import type { Project } from '../lib/types'
import {
  bitmapSource,
  clipDur,
  outputSizeFor,
  renderFrame,
  resetAutoGain,
  screenRect,
  zoomStateAt
} from '../lib/composite'

/**
 * Export: the one path from a project to an MP4 on disk.
 *
 *   ffmpeg decodes source frames, already cropped and scaled to the pixels the
 *   output needs (main, several chunks in parallel) → renderFrame composites
 *   them onto a canvas → VideoEncoder → encoded chunks stream to a temp file
 *   (main) → ffmpeg muxes with audio cut from the source → the result is
 *   validated, then moved into place.
 *
 * Every step that has failed in the wild is handled here rather than surfaced
 * as a crash:
 *  - the H.264 level is chosen for the actual output size (a fixed Level 4.0
 *    rejected cropped sizes like 1924x1080);
 *  - odd dimensions are rounded to even, which 4:2:0 H.264 requires;
 *  - a hardware encoder failure or stall retries the export in software;
 *  - a truncated recording (common with MediaRecorder) holds the last good
 *    frame instead of failing on the final second;
 *  - audio problems never cost the video (see exportIpc.ts).
 */

export type Accel = 'prefer-hardware' | 'prefer-software'

export interface ExportOpts {
  fps?: number
  onProgress?: (fraction: number, label: string) => void
  signal?: { cancelled: boolean }
  /** Which encoder to try first. Defaults to hardware, falling back to software. */
  startWith?: Accel
  /** Test hook: make the first encoder pass fail at this frame. */
  injectEncoderFailureAt?: number
  /** Encoding settings; defaults are the measured best for speed and quality. */
  encoding?: Partial<Encoding>
}

export interface Encoding {
  /** Target bits per second. */
  bitrate: number
  /** H.264 profile. */
  profile: 'main' | 'high'
  /** JPEG quality of frames handed over from ffmpeg (ffmpeg -q:v; 1 = best). */
  jpegQuality: number
}

/** Measured on real screen content (a Google Doc with typing and scrolling)
 * against a lossless reference: High profile at 12 Mbps scored 44.7 dB vs
 * 44.0 for Main at 8 Mbps, at the same speed, for ~14% larger files. */
export const DEFAULT_ENCODING: Encoding = { bitrate: 12_000_000, profile: 'high', jpegQuality: 2 }

export interface ExportResult {
  canceled: boolean
  filePath?: string
  audio?: 'ok' | 'none' | 'failed'
  audioDetail?: string
  encoder?: 'hardware' | 'software'
  /** Where the time went, in ms — reported by the export test. */
  timings?: ExportTimings
}

export interface ExportTimings {
  total: number
  /** Blocked waiting for decoded source frames. */
  waitFrames: number
  /** Compositing onto the canvas. */
  draw: number
  /** Creating the VideoFrame and handing it to the encoder. */
  encode: number
  /** Blocked because the encoder queue was full. */
  backpressure: number
  /** Flush + mux + validate. */
  finish: number
}

/** Frames per ffmpeg call: amortizes process startup, keeps buffers modest. */
const CHUNK_FRAMES = 120
/** ffmpeg processes decoding ahead in parallel. Its JPEG encoder is
 * single-threaded, so this is where multiple cores pay off. */
const PARALLEL_CHUNKS = 3
/** Frames decoded to bitmaps ahead of drawing. Chunks stay compressed until
 * then, so memory stays ~100MB instead of gigabytes of full-size bitmaps. */
const BITMAP_LOOKAHEAD = 12
/** Encoder queue depth before we wait for it to catch up. */
const ENCODER_QUEUE = 16
/** How far past the recording's last frame an export may run, holding it. */
const MAX_HELD_SECONDS = 2
/** An encoder that accepts no work for this long is treated as dead. */
const ENCODER_STALL_MS = 20_000

/** A failure in the encoder itself — worth retrying on the other encoder. */
class EncoderFailure extends Error {}

// ---------------------------------------------------------------------------
// Encoder configuration
// ---------------------------------------------------------------------------

/** H.264 levels: max frame size and rate, in macroblocks. */
const AVC_LEVELS: { level: string; maxFS: number; maxMBPS: number }[] = [
  { level: '28', maxFS: 8192, maxMBPS: 245760 }, // 4.0
  { level: '2a', maxFS: 8704, maxMBPS: 522240 }, // 4.2
  { level: '32', maxFS: 22080, maxMBPS: 589824 }, // 5.0
  { level: '33', maxFS: 36864, maxMBPS: 983040 } // 5.1
]
const PROFILE_IDC = { main: '4d00', high: '6400' } as const

/**
 * The lowest H.264 level that can code `width`x`height` at `fps` and that this
 * machine's encoder accepts. Lowest-first keeps ordinary 1080p exports on
 * Level 4.0 for the widest device compatibility.
 */
export async function encoderConfigFor(
  width: number,
  height: number,
  fps: number,
  accel: Accel,
  enc: Encoding = DEFAULT_ENCODING
): Promise<VideoEncoderConfig> {
  const frameSize = Math.ceil(width / 16) * Math.ceil(height / 16)
  const accels: HardwareAcceleration[] =
    accel === 'prefer-hardware' ? ['prefer-hardware', 'no-preference'] : ['prefer-software']

  // High profile first; Main if this encoder can't do High (Chromium's
  // software encoder may not), so a profile is never the reason export fails.
  const profiles: Encoding['profile'][] = enc.profile === 'high' ? ['high', 'main'] : ['main']
  let lastReason = ''
  for (const profile of profiles) {
    for (const hw of accels) {
      for (const lvl of AVC_LEVELS) {
        if (frameSize > lvl.maxFS || frameSize * fps > lvl.maxMBPS) continue
        const codec = `avc1.${PROFILE_IDC[profile]}${lvl.level}`
        const config: VideoEncoderConfig = {
          codec,
          width,
          height,
          bitrate: enc.bitrate,
          framerate: fps,
          avc: { format: 'annexb' },
          hardwareAcceleration: hw
        }
        try {
          if ((await VideoEncoder.isConfigSupported(config)).supported) return config
          lastReason = `${codec} (${hw}) not supported`
        } catch (e) {
          lastReason = e instanceof Error ? e.message : String(e)
        }
      }
    }
  }
  throw new EncoderFailure(
    `no H.264 encoder setting can produce ${width}x${height} at ${fps}fps` +
      (lastReason ? ` (${lastReason})` : '')
  )
}

/** H.264 with 4:2:0 chroma needs even dimensions. */
const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2)

// ---------------------------------------------------------------------------
// Frame plan
// ---------------------------------------------------------------------------

export interface Plan {
  /** Source time of every output frame, in order. */
  frames: number[]
  /** Source audio ranges matching the video frames exactly. */
  ranges: { start: number; end: number }[]
}

/**
 * Lay out every output frame. Each clip contributes round(duration × fps)
 * frames, and its audio range is cut to that same length so picture and
 * sound can't drift apart across many cuts.
 */
export function framePlan(project: Project, fps: number): Plan {
  const frames: number[] = []
  const ranges: Plan['ranges'] = []
  for (const c of project.clips) {
    const n = Math.max(1, Math.round(clipDur(c) * fps))
    for (let i = 0; i < n; i++) frames.push(c.inPoint + i / fps)
    ranges.push({ start: c.inPoint, end: c.inPoint + n / fps })
  }
  return { frames, ranges }
}

// ---------------------------------------------------------------------------
// Source decoding
// ---------------------------------------------------------------------------

/** Split concatenated JPEGs (ffmpeg image2pipe output) into individual images. */
function splitJpegs(buf: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []
  let start = -1
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] !== 0xff) continue
    if (buf[i + 1] === 0xd8 && start === -1) {
      start = i
    } else if (buf[i + 1] === 0xd9 && start !== -1) {
      out.push(buf.subarray(start, i + 2))
      start = -1
    }
  }
  return out
}

type Shape = Parameters<typeof window.ledger.export.extractFrames>[3]

/**
 * The smallest frames that still draw pixel-for-pixel: the output rect's
 * size, times the strongest zoom in this stretch (a punch-in needs the extra
 * detail). Never upscales past the source. ffmpeg also normalises a jittery
 * recording's frames to its real picture and applies the crop.
 */
function screenShape(
  project: Project,
  srcW: number,
  srcH: number,
  maxZoom: number
): NonNullable<Shape> {
  const g = project.source?.varies ? project.source : null
  // Size of the real picture, then of the cropped region within it.
  const picW = g ? g.width : srcW
  const picH = g ? g.height : srcH
  const c = project.crop
  const w = c ? c.w * picW : picW
  const h = c ? c.h * picH : picH
  const rect = screenRect(project, project.outputWidth, project.outputHeight)
  const f = Math.min(1, Math.max(rect.w / w, rect.h / h) * maxZoom)
  return {
    content: g ? { regions: g.regions, aspect: g.aspect, alignX: g.alignX, alignY: g.alignY } : null,
    crop: c ? { x: c.x, y: c.y, w: Math.min(c.w, 1 - c.x), h: Math.min(c.h, 1 - c.y) } : null,
    width: even(Math.round(w * f)),
    height: even(Math.round(h * f))
  }
}

/** The camera bubble samples its source at bubble size × camera zoom. */
function cameraShape(project: Project, srcW: number, srcH: number): NonNullable<Shape> {
  const need = project.camera.size * project.outputHeight * (project.camera.zoom || 1)
  const f = Math.min(1, need / Math.min(srcW, srcH))
  return {
    content: null,
    crop: null,
    width: even(Math.round(srcW * f)),
    height: even(Math.round(srcH * f))
  }
}

interface SourceFrame {
  /** Seconds from the start of the recording. */
  pts: number
  jpeg: Uint8Array
}

/** Fetch every real source frame in [start, end), compressed, with timestamps. */
async function fetchFrames(
  path: string,
  start: number,
  end: number,
  shape: Shape
): Promise<SourceFrame[]> {
  const r = await window.ledger.export.extractFrames(path, start, end, shape)
  const jpegs = splitJpegs(new Uint8Array(r.data))
  if (jpegs.length !== r.pts.length) {
    throw new Error(`frame data and timestamps disagree (${jpegs.length} vs ${r.pts.length})`)
  }
  return jpegs.map((jpeg, i) => ({ pts: r.pts[i], jpeg }))
}

const toBitmap = (jpeg: Uint8Array): Promise<ImageBitmap | null> =>
  createImageBitmap(new Blob([jpeg as BlobPart], { type: 'image/jpeg' })).catch(() => null)


/**
 * Answers "what was on screen at time t?" with the real frame nearest to t
 * without being more than half an output frame ahead of it — i.e. the latest
 * frame stamped at or before t + half a frame. Screen recordings skip frames
 * while nothing changes, so the answer is often a frame from a while ago,
 * held across gaps and chunk boundaries alike. Before the first frame, the
 * first frame is shown. Frames stay compressed until needed, decoded a few
 * ahead.
 */
class FrameFeed {
  /** @param slack how far after t a frame may be stamped and still count. */
  constructor(private readonly slack: number) {}

  private cur: { pts: number; bmp: ImageBitmap } | null = null
  private frames: SourceFrame[] = []
  private next = 0
  private decoded = new Map<number, Promise<ImageBitmap | null>>()
  /** Latest timestamp seen in any chunk, for spotting a truncated recording. */
  lastPts = -Infinity

  load(frames: SourceFrame[]): void {
    for (const p of this.decoded.values()) p.then((b) => b?.close())
    this.decoded.clear()
    this.frames = frames
    this.next = 0
    if (frames.length) this.lastPts = Math.max(this.lastPts, frames[frames.length - 1].pts)
    this.prefetch()
  }

  private decode(i: number): Promise<ImageBitmap | null> {
    let p = this.decoded.get(i)
    if (!p) {
      p = toBitmap(this.frames[i].jpeg)
      this.decoded.set(i, p)
    }
    return p
  }

  private prefetch(): void {
    for (let i = this.next; i < Math.min(this.frames.length, this.next + BITMAP_LOOKAHEAD); i++) this.decode(i)
  }

  async at(t: number): Promise<ImageBitmap | null> {
    // Advance to the latest frame at or before t, skipping any in between
    // (a source faster than the output).
    let target = -1
    while (this.next < this.frames.length && this.frames[this.next].pts <= t + this.slack) {
      if (target >= 0) this.drop(target)
      target = this.next++
    }
    // Nothing on screen yet (the export starts before the first frame): show
    // the first frame rather than nothing.
    if (target < 0 && !this.cur && this.frames.length) target = this.next++
    if (target >= 0) {
      const bmp = await this.decode(target)
      this.decoded.delete(target)
      // A damaged frame keeps the previous one on screen.
      if (bmp) {
        this.cur?.bmp.close()
        this.cur = { pts: this.frames[target].pts, bmp }
      }
    }
    this.prefetch()
    return this.cur?.bmp ?? null
  }

  private drop(i: number): void {
    this.decoded.get(i)?.then((b) => b?.close())
    this.decoded.delete(i)
  }

  get hasFrame(): boolean {
    return this.cur !== null
  }

  dispose(): void {
    this.cur?.bmp.close()
    this.cur = null
    for (const p of this.decoded.values()) p.then((b) => b?.close())
    this.decoded.clear()
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Render `project` to `outPath` (which must come from
 * window.ledger.export.chooseSavePath). Retries once on the other encoder if
 * the first one fails.
 */
export async function exportVideo(
  project: Project,
  outPath: string,
  opts: ExportOpts = {}
): Promise<ExportResult> {
  if (typeof VideoEncoder !== 'function') {
    throw new Error('this version of the app cannot encode video (WebCodecs is unavailable)')
  }
  if (!project.screenPath) throw new Error('the recording has not been saved to disk')
  if (!project.clips.length) throw new Error('there is nothing to export — every clip was removed')

  // The editor analyses the recording when it opens; if export starts first,
  // do it now so a jittery recording is never exported un-steadied.
  if (!project.source) {
    opts.onProgress?.(0, 'Checking the recording')
    const g = await window.ledger.export.analyzeSource(project.screenPath)
    if (g) {
      project = { ...project, source: g }
      if (g.varies) {
        const out = outputSizeFor(g.width, g.height, project.crop)
        project = { ...project, outputWidth: out.width, outputHeight: out.height }
      }
    }
  }

  const first: Accel = opts.startWith ?? 'prefer-hardware'
  try {
    return await renderPass(project, outPath, opts, first, opts.injectEncoderFailureAt)
  } catch (e) {
    if (!(e instanceof EncoderFailure) || opts.signal?.cancelled || first === 'prefer-software') {
      throw e
    }
    console.warn('hardware encoding failed, retrying in software:', e)
    opts.onProgress?.(0, 'Retrying with the software encoder')
    return await renderPass(project, outPath, opts, 'prefer-software')
  }
}

async function renderPass(
  source: Project,
  outPath: string,
  opts: ExportOpts,
  accel: Accel,
  failAt?: number
): Promise<ExportResult> {
  const fps = opts.fps ?? 30
  const enc: Encoding = { ...DEFAULT_ENCODING, ...opts.encoding }
  const width = even(source.outputWidth)
  const height = even(source.outputHeight)
  const project: Project = { ...source, outputWidth: width, outputHeight: height }
  // Frames arrive normalised and cropped by ffmpeg; the compositor must not
  // do either again.
  const drawProject: Project = { ...project, crop: null, source: null }
  const screenPath = project.screenPath!
  const cameraPath = project.camera.enabled ? project.cameraPath : null

  const { frames: plan, ranges } = framePlan(project, fps)
  const frameCount = plan.length

  // Resolve everything that can fail up front, before any temp file exists.
  const config = await encoderConfigFor(width, height, fps, accel, enc)
  const screenInfo = await window.ledger.export.probe(screenPath)
  if (!screenInfo.hasVideo || !screenInfo.width) throw new Error('the recording has no readable video')
  const cameraInfo = cameraPath
    ? await window.ledger.export.probe(cameraPath).catch(() => null)
    : null
  const camShape =
    cameraInfo?.hasVideo && cameraInfo.width
      ? { ...cameraShape(project, cameraInfo.width, cameraInfo.height), quality: enc.jpegQuality }
      : null

  // Split the plan into chunks: up to CHUNK_FRAMES consecutive frames, never
  // across a cut, so each ffmpeg call decodes one contiguous span.
  const chunks: { i: number; n: number; shape: NonNullable<Shape> }[] = []
  for (let i = 0; i < frameCount; ) {
    let n = 1
    while (
      n < CHUNK_FRAMES &&
      i + n < frameCount &&
      Math.abs(plan[i + n] - (plan[i] + n / fps)) < 1e-6
    ) {
      n++
    }
    let maxZoom = 1
    for (let k = i; k < i + n; k++) maxZoom = Math.max(maxZoom, zoomStateAt(project.zooms, plan[k]).scale)
    chunks.push({
      i,
      n,
      shape: { ...screenShape(project, screenInfo.width, screenInfo.height, maxZoom), quality: enc.jpegQuality }
    })
    i += n
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  // CPU-backed canvas (willReadFrequently). With Chromium's default GPU
  // canvas, a JPEG-decoded frame drawn and then handed to VideoFrame comes out
  // shifted 1px sideways — measured at 20.7 dB against the frame drawn, versus
  // 41.1 dB this way, which blurs text visibly. Same speed either way.
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })
  if (!ctx) throw new Error('could not create a drawing surface for the export')

  const streamId = await window.ledger.export.streamBegin()
  const t: ExportTimings = { total: 0, waitFrames: 0, draw: 0, encode: 0, backpressure: 0, finish: 0 }
  const tStart = performance.now()

  let encoderError: Error | null = null
  let writeError: Error | null = null
  // Once the pass is over (finished or failed), late encoder output must not
  // reach a stream that has already been closed or deleted.
  let accepting = true
  // Resolves a wait for queue room; called when the encoder frees a slot or fails.
  let wake: (() => void) | null = null
  const writes: Promise<void>[] = []
  const encoder = new VideoEncoder({
    output: (chunk) => {
      if (!accepting) return
      const buf = new Uint8Array(chunk.byteLength)
      chunk.copyTo(buf)
      writes.push(
        window.ledger.export.streamWrite(streamId, buf.buffer).catch((e) => {
          writeError = writeError ?? (e instanceof Error ? e : new Error(String(e)))
        })
      )
    },
    error: (e) => {
      encoderError = encoderError ?? new EncoderFailure(`video encoder failed: ${e.message}`)
      wake?.()
    }
  })
  encoder.addEventListener('dequeue', () => wake?.())

  // Nearest frame: up to half an output frame early (ties go to the earlier).
  const slack = 0.5 / fps - 1e-6
  const screenFeed = new FrameFeed(slack)
  const cameraFeed = new FrameFeed(slack)
  const inFlight = new Map<number, Promise<[SourceFrame[], SourceFrame[]]>>()

  /** Throw whichever failure happened first, if any. */
  const check = (): void => {
    if (encoderError) throw encoderError
    if (writeError) throw writeError
    if (encoder.state !== 'configured') {
      throw new EncoderFailure(`video encoder stopped unexpectedly (state: ${encoder.state})`)
    }
  }

  /** Wait until the encoder has room, woken by its own 'dequeue' event rather
   * than a polling timer. A wedged encoder must not hang the export forever. */
  const waitForRoom = async (): Promise<void> => {
    const began = performance.now()
    while (encoder.encodeQueueSize > ENCODER_QUEUE) {
      check()
      const left = ENCODER_STALL_MS - (performance.now() - began)
      if (left <= 0) throw new EncoderFailure('video encoder stopped responding')
      await new Promise<void>((res) => {
        const timer = setTimeout(res, Math.min(left, 250))
        wake = () => {
          clearTimeout(timer)
          res()
        }
      })
      wake = null
    }
  }

  const fetchChunk = (c: number): Promise<[SourceFrame[], SourceFrame[]]> => {
    const { i, n, shape } = chunks[c]
    // Every real frame from this chunk's first instant up to (not including)
    // the next chunk's; the frame on screen at the very start, if it came
    // earlier, is still held from the previous chunk.
    const start = plan[i]
    const end = plan[i + n - 1] + 1 / fps
    const screen = fetchFrames(screenPath, start, end, shape).catch((e) => {
      // A decode failure is only survivable if there's a frame to hold.
      if (screenFeed.hasFrame || c > 0) return [] as SourceFrame[]
      throw new Error(`could not read the recording: ${e instanceof Error ? e.message : e}`)
    })
    // The camera is optional: if it can't be read, keep going without it.
    const camera =
      cameraPath && camShape
        ? fetchFrames(cameraPath, start, end, camShape).catch(() => [] as SourceFrame[])
        : Promise.resolve([] as SourceFrame[])
    return Promise.all([screen, camera])
  }
  const fillPipeline = (from: number): void => {
    for (let c = from; c < Math.min(chunks.length, from + PARALLEL_CHUNKS); c++) {
      if (!inFlight.has(c)) inFlight.set(c, fetchChunk(c))
    }
  }

  try {
    try {
      encoder.configure(config)
    } catch (e) {
      throw new EncoderFailure(`video encoder rejected its settings: ${String(e)}`)
    }
    resetAutoGain()
    const frameDurUs = 1_000_000 / fps

    for (let c = 0; c < chunks.length; c++) {
      if (opts.signal?.cancelled) {
        accepting = false
        encoder.close()
        await Promise.allSettled(writes)
        await window.ledger.export.streamAbort(streamId)
        return { canceled: true }
      }

      fillPipeline(c)
      let t0 = performance.now()
      const [screenFrames, cameraFrames] = await inFlight.get(c)!
      inFlight.delete(c)
      fillPipeline(c + 1)
      t.waitFrames += performance.now() - t0

      screenFeed.load(screenFrames)
      cameraFeed.load(cameraFrames)
      const { i, n } = chunks[c]

      for (let k = 0; k < n; k++) {
        const idx = i + k
        t0 = performance.now()
        const s = await screenFeed.at(plan[idx])
        const cam = await cameraFeed.at(plan[idx])
        t.waitFrames += performance.now() - t0

        if (!s) throw new Error('could not read any video from the recording')
        // Holding a frame through a gap is normal; holding it for seconds past
        // the last frame the file has means the recording ends early.
        if (c === chunks.length - 1 && plan[idx] - screenFeed.lastPts > MAX_HELD_SECONDS) {
          throw new Error(
            `the recording ends early — about ${(plan[frameCount - 1] - screenFeed.lastPts).toFixed(1)}s of video is missing`
          )
        }

        t0 = performance.now()
        renderFrame(ctx, drawProject, plan[idx], bitmapSource(s), cam ? bitmapSource(cam) : null)
        t.draw += performance.now() - t0

        check()
        if (failAt !== undefined && idx === failAt) {
          throw new EncoderFailure('injected encoder failure (test)')
        }

        t0 = performance.now()
        const frame = new VideoFrame(canvas, {
          timestamp: Math.round(idx * frameDurUs),
          duration: Math.round(frameDurUs)
        })
        try {
          encoder.encode(frame, { keyFrame: idx % (fps * 2) === 0 })
        } catch (e) {
          throw encoderError ?? new EncoderFailure(`video encoder failed: ${String(e)}`)
        } finally {
          frame.close()
        }
        t.encode += performance.now() - t0

        t0 = performance.now()
        await waitForRoom()
        t.backpressure += performance.now() - t0
      }

      opts.onProgress?.(((i + n) / frameCount) * 0.95, 'Rendering video')
    }

    const tFinish = performance.now()
    try {
      await encoder.flush()
    } catch (e) {
      throw encoderError ?? new EncoderFailure(`video encoder failed to finish: ${String(e)}`)
    }
    check()
    encoder.close()
    accepting = false
    await Promise.all(writes)
    if (writeError) throw writeError

    opts.onProgress?.(0.97, 'Saving')
    const res = await window.ledger.export.streamFinish(
      streamId,
      { fps, frames: frameCount, audio: { src: screenPath, ranges } },
      outPath
    )
    opts.onProgress?.(1, 'Done')
    t.finish = performance.now() - tFinish
    t.total = performance.now() - tStart
    return {
      canceled: false,
      filePath: res.filePath,
      audio: res.audio,
      audioDetail: res.audioDetail,
      encoder: accel === 'prefer-hardware' ? 'hardware' : 'software',
      timings: t
    }
  } catch (e) {
    // Stop the encoder before discarding its stream, so nothing is written
    // to a file that no longer exists.
    accepting = false
    if (encoder.state !== 'closed') encoder.close()
    await Promise.allSettled(writes)
    await window.ledger.export.streamAbort(streamId).catch(() => {})
    throw e
  } finally {
    if (encoder.state !== 'closed') encoder.close()
    for (const p of inFlight.values()) p.catch(() => {})
    screenFeed.dispose()
    cameraFeed.dispose()
  }
}

// ---------------------------------------------------------------------------
// Sources on disk
// ---------------------------------------------------------------------------

function readBlobUrl(url: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', url, true)
    xhr.responseType = 'arraybuffer'
    xhr.onload = () => resolve(xhr.response as ArrayBuffer)
    xhr.onerror = () => reject(new Error('could not read the recording from memory'))
    xhr.send()
  })
}

/**
 * Export reads sources from disk. Recordings are saved as they finish, but if
 * that ever failed, write them out now instead of refusing to export.
 */
export async function ensureOnDisk(
  project: Project
): Promise<{ screenPath: string; cameraPath: string | null }> {
  if (project.screenPath) return { screenPath: project.screenPath, cameraPath: project.cameraPath }
  const session = await window.ledger.recordings.newSession()
  const screenPath = await window.ledger.recordings.saveTrack(
    session.dir,
    'screen.webm',
    await readBlobUrl(project.screenSrc)
  )
  const cameraPath = project.cameraSrc
    ? await window.ledger.recordings.saveTrack(
        session.dir,
        'camera.webm',
        await readBlobUrl(project.cameraSrc)
      )
    : null
  return { screenPath, cameraPath }
}
