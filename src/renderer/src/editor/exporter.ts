import type { Project } from '../lib/types'
import {
  bitmapSource,
  clipDur,
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
}

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
/** How much missing footage at the end of a recording we paper over. */
const MAX_HELD_SECONDS = 2
/** An encoder that accepts no work for this long is treated as dead. */
const ENCODER_STALL_MS = 20_000
const BITRATE = 8_000_000

/** A failure in the encoder itself — worth retrying on the other encoder. */
class EncoderFailure extends Error {}

// ---------------------------------------------------------------------------
// Encoder configuration
// ---------------------------------------------------------------------------

/** H.264 Main profile levels: max frame size and rate, in macroblocks. */
const AVC_LEVELS: { codec: string; maxFS: number; maxMBPS: number }[] = [
  { codec: 'avc1.4d0028', maxFS: 8192, maxMBPS: 245760 }, // 4.0
  { codec: 'avc1.4d002a', maxFS: 8704, maxMBPS: 522240 }, // 4.2
  { codec: 'avc1.4d0032', maxFS: 22080, maxMBPS: 589824 }, // 5.0
  { codec: 'avc1.4d0033', maxFS: 36864, maxMBPS: 983040 } // 5.1
]

/**
 * The lowest H.264 level that can code `width`x`height` at `fps` and that this
 * machine's encoder accepts. Lowest-first keeps ordinary 1080p exports on
 * Level 4.0 for the widest device compatibility.
 */
export async function encoderConfigFor(
  width: number,
  height: number,
  fps: number,
  accel: Accel
): Promise<VideoEncoderConfig> {
  const frameSize = Math.ceil(width / 16) * Math.ceil(height / 16)
  const accels: HardwareAcceleration[] =
    accel === 'prefer-hardware' ? ['prefer-hardware', 'no-preference'] : ['prefer-software']

  let lastReason = ''
  for (const hw of accels) {
    for (const lvl of AVC_LEVELS) {
      if (frameSize > lvl.maxFS || frameSize * fps > lvl.maxMBPS) continue
      const config: VideoEncoderConfig = {
        codec: lvl.codec,
        width,
        height,
        bitrate: BITRATE,
        framerate: fps,
        avc: { format: 'annexb' },
        hardwareAcceleration: hw
      }
      try {
        if ((await VideoEncoder.isConfigSupported(config)).supported) return config
        lastReason = `${lvl.codec} (${hw}) not supported`
      } catch (e) {
        lastReason = e instanceof Error ? e.message : String(e)
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

type Shape = Parameters<typeof window.ledger.export.extractFrames>[4]

/** Integer pixel crop of `frac` within a `w`x`h` frame, kept inside it. */
function cropPx(
  frac: { x: number; y: number; w: number; h: number },
  w: number,
  h: number
): { x: number; y: number; w: number; h: number } {
  const x = Math.min(w - 2, Math.max(0, Math.round(frac.x * w)))
  const y = Math.min(h - 2, Math.max(0, Math.round(frac.y * h)))
  return {
    x,
    y,
    w: Math.max(2, Math.min(w - x, Math.round(frac.w * w))),
    h: Math.max(2, Math.min(h - y, Math.round(frac.h * h)))
  }
}

/**
 * The smallest frames that still draw pixel-for-pixel: the output rect's
 * size, times the strongest zoom in this stretch (a punch-in needs the extra
 * detail). Never upscales past the source.
 */
function screenShape(
  project: Project,
  srcW: number,
  srcH: number,
  maxZoom: number
): NonNullable<Shape> {
  const crop = project.crop ? cropPx(project.crop, srcW, srcH) : null
  const w = crop ? crop.w : srcW
  const h = crop ? crop.h : srcH
  const rect = screenRect(project, project.outputWidth, project.outputHeight)
  const f = Math.min(1, Math.max(rect.w / w, rect.h / h) * maxZoom)
  return { crop, width: even(Math.round(w * f)), height: even(Math.round(h * f)) }
}

/** The camera bubble samples its source at bubble size × camera zoom. */
function cameraShape(project: Project, srcW: number, srcH: number): NonNullable<Shape> {
  const need = project.camera.size * project.outputHeight * (project.camera.zoom || 1)
  const f = Math.min(1, need / Math.min(srcW, srcH))
  return { crop: null, width: even(Math.round(srcW * f)), height: even(Math.round(srcH * f)) }
}

/** Fetch a chunk's frames as compressed JPEGs. */
async function fetchJpegs(
  path: string,
  startSec: number,
  count: number,
  fps: number,
  shape: Shape
): Promise<Uint8Array[]> {
  const raw = await window.ledger.export.extractFrames(path, startSec, count, fps, shape)
  return splitJpegs(new Uint8Array(raw))
}

const toBitmap = (jpeg: Uint8Array | undefined): Promise<ImageBitmap | null> =>
  jpeg
    ? createImageBitmap(new Blob([jpeg as BlobPart], { type: 'image/jpeg' })).catch(() => null)
    : Promise.resolve(null)

/**
 * Turns a chunk of JPEGs into one bitmap per output frame, decoding a few
 * frames ahead. A missing or damaged frame repeats the last good one (a
 * truncated tail, a camera that stopped early), and those repeats are counted
 * so a badly broken recording is still reported rather than papered over.
 */
class FrameFeed {
  private last: ImageBitmap | null = null
  private jpegs: Uint8Array[] = []
  private ahead: (Promise<ImageBitmap | null> | undefined)[] = []
  repeated = 0

  load(jpegs: Uint8Array[]): void {
    this.jpegs = jpegs
    this.ahead = []
    for (let k = 0; k < Math.min(BITMAP_LOOKAHEAD, jpegs.length); k++) {
      this.ahead[k] = toBitmap(jpegs[k])
    }
  }

  /** The frame to draw for position `k` of the current chunk. */
  async frame(k: number): Promise<ImageBitmap | null> {
    const next = k + BITMAP_LOOKAHEAD
    if (next < this.jpegs.length && !this.ahead[next]) this.ahead[next] = toBitmap(this.jpegs[next])
    const bmp = k < this.jpegs.length ? await this.ahead[k] : null
    this.ahead[k] = undefined
    if (bmp) {
      this.last?.close()
      this.last = bmp
    } else {
      this.repeated++
    }
    return this.last
  }

  get hasFrame(): boolean {
    return this.last !== null
  }

  dispose(): void {
    this.last?.close()
    this.last = null
    for (const p of this.ahead) p?.then((b) => b?.close())
    this.ahead = []
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
  const width = even(source.outputWidth)
  const height = even(source.outputHeight)
  const project: Project = { ...source, outputWidth: width, outputHeight: height }
  // Frames arrive already cropped by ffmpeg, so the compositor must not crop again.
  const drawProject: Project = { ...project, crop: null }
  const screenPath = project.screenPath!
  const cameraPath = project.camera.enabled ? project.cameraPath : null

  const { frames: plan, ranges } = framePlan(project, fps)
  const frameCount = plan.length
  const maxRepeated = Math.round(MAX_HELD_SECONDS * fps)

  // Resolve everything that can fail up front, before any temp file exists.
  const config = await encoderConfigFor(width, height, fps, accel)
  const screenInfo = await window.ledger.export.probe(screenPath)
  if (!screenInfo.hasVideo || !screenInfo.width) throw new Error('the recording has no readable video')
  const cameraInfo = cameraPath
    ? await window.ledger.export.probe(cameraPath).catch(() => null)
    : null
  const camShape =
    cameraInfo?.hasVideo && cameraInfo.width
      ? cameraShape(project, cameraInfo.width, cameraInfo.height)
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
    chunks.push({ i, n, shape: screenShape(project, screenInfo.width, screenInfo.height, maxZoom) })
    i += n
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { alpha: false })
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

  const screenFeed = new FrameFeed()
  const cameraFeed = new FrameFeed()
  const inFlight = new Map<number, Promise<[Uint8Array[], Uint8Array[]]>>()

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

  const fetchChunk = (c: number): Promise<[Uint8Array[], Uint8Array[]]> => {
    const { i, n, shape } = chunks[c]
    const screen = fetchJpegs(screenPath, plan[i], n, fps, shape).catch((e) => {
      // A decode failure is only survivable if there's a frame to repeat.
      if (screenFeed.hasFrame || c > 0) return [] as Uint8Array[]
      throw new Error(`could not read the recording: ${e instanceof Error ? e.message : e}`)
    })
    // The camera is optional: if it can't be read, keep going without it.
    const camera =
      cameraPath && camShape
        ? fetchJpegs(cameraPath, plan[i], n, fps, camShape).catch(() => [] as Uint8Array[])
        : Promise.resolve([] as Uint8Array[])
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
      const [screenJpegs, cameraJpegs] = await inFlight.get(c)!
      inFlight.delete(c)
      fillPipeline(c + 1)
      t.waitFrames += performance.now() - t0

      screenFeed.load(screenJpegs)
      cameraFeed.load(cameraJpegs)
      const { i, n } = chunks[c]

      for (let k = 0; k < n; k++) {
        const idx = i + k
        t0 = performance.now()
        const s = await screenFeed.frame(k)
        const cam = cameraJpegs.length || cameraFeed.hasFrame ? await cameraFeed.frame(k) : null
        t.waitFrames += performance.now() - t0

        if (!s) throw new Error('could not read any video from the recording')
        if (screenFeed.repeated > maxRepeated) {
          throw new Error(
            `the recording ends early — about ${(screenFeed.repeated / fps).toFixed(1)}s of video is missing`
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
