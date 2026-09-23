import type { Project } from '../lib/types'
import { bitmapSource, clipDur, renderFrame, resetAutoGain } from '../lib/composite'

/**
 * Export: the one path from a project to an MP4 on disk.
 *
 *   ffmpeg decodes source frames (main) → renderFrame composites them onto a
 *   canvas → VideoEncoder → encoded chunks stream to a temp file (main) →
 *   ffmpeg muxes with audio cut from the source → the result is validated,
 *   then moved into place.
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
}

/** Frames per ffmpeg call: amortizes process startup, keeps buffers modest. */
const CHUNK_FRAMES = 120
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

async function decodeChunk(
  path: string,
  startSec: number,
  count: number,
  fps: number
): Promise<ImageBitmap[]> {
  const raw = await window.ledger.export.extractFrames(path, startSec, count, fps)
  const jpegs = splitJpegs(new Uint8Array(raw))
  const settled = await Promise.allSettled(
    jpegs.map((j) => createImageBitmap(new Blob([j as BlobPart], { type: 'image/jpeg' })))
  )
  // Keep the frames that decoded, in order; a damaged frame is replaced by
  // its neighbour downstream rather than failing the export.
  return settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
}

/**
 * Serves one frame per output frame, holding the last good frame across gaps
 * (a truncated tail, a camera track that ended early, a damaged frame).
 */
class FrameFeed {
  private held: ImageBitmap | null = null
  heldFrames = 0

  /** Take ownership of a decoded chunk and return exactly `n` frames. */
  take(chunk: ImageBitmap[], n: number): (ImageBitmap | null)[] {
    const out: (ImageBitmap | null)[] = []
    for (let k = 0; k < n; k++) {
      if (k < chunk.length) {
        out.push(chunk[k])
      } else {
        out.push(chunk.length ? chunk[chunk.length - 1] : this.held)
        this.heldFrames++
      }
    }
    return out
  }

  /** After a chunk is drawn: keep its last frame for gaps, free the rest. */
  release(chunk: ImageBitmap[]): void {
    if (!chunk.length) return
    const last = chunk[chunk.length - 1]
    for (const b of chunk) if (b !== last) b.close()
    if (this.held && this.held !== last) this.held.close()
    this.held = last
  }

  get hasFrame(): boolean {
    return this.held !== null
  }

  dispose(): void {
    this.held?.close()
    this.held = null
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
  const screenPath = project.screenPath!
  const cameraPath = project.camera.enabled ? project.cameraPath : null

  const { frames: plan, ranges } = framePlan(project, fps)
  const frameCount = plan.length
  const maxHeld = Math.round(MAX_HELD_SECONDS * fps)

  // Resolve everything that can fail up front, before any temp file exists.
  const config = await encoderConfigFor(width, height, fps, accel)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('could not create a drawing surface for the export')

  const streamId = await window.ledger.export.streamBegin()

  let encoderError: Error | null = null
  let writeError: Error | null = null
  // Once the pass is over (finished or failed), late encoder output must not
  // reach a stream that has already been closed or deleted.
  let accepting = true
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
    }
  })

  const screenFeed = new FrameFeed()
  const cameraFeed = new FrameFeed()
  let pending: Promise<[ImageBitmap[], ImageBitmap[]]> | null = null

  /** Throw whichever failure happened first, if any. */
  const check = (): void => {
    if (encoderError) throw encoderError
    if (writeError) throw writeError
    if (encoder.state !== 'configured') {
      throw new EncoderFailure(`video encoder stopped unexpectedly (state: ${encoder.state})`)
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

    // A chunk covers up to CHUNK_FRAMES consecutive frames, never across a cut,
    // so ffmpeg always decodes one contiguous span.
    const chunkLen = (i: number): number => {
      let n = 1
      while (
        n < CHUNK_FRAMES &&
        i + n < frameCount &&
        Math.abs(plan[i + n] - (plan[i] + n / fps)) < 1e-6
      ) {
        n++
      }
      return n
    }

    const fetchChunk = (i: number, n: number): Promise<[ImageBitmap[], ImageBitmap[]]> => {
      const screen = decodeChunk(screenPath, plan[i], n, fps).catch((e) => {
        // A decode failure is only survivable if there's a frame to hold.
        if (screenFeed.hasFrame) return [] as ImageBitmap[]
        throw new Error(`could not read the recording: ${e instanceof Error ? e.message : e}`)
      })
      // The camera is optional: if it can't be read, keep going without it.
      const camera = cameraPath
        ? decodeChunk(cameraPath, plan[i], n, fps).catch(() => [] as ImageBitmap[])
        : Promise.resolve([] as ImageBitmap[])
      return Promise.all([screen, camera])
    }

    let i = 0
    let n = chunkLen(0)
    // Decode the next chunk while this one encodes.
    pending = fetchChunk(0, n)

    while (i < frameCount) {
      if (opts.signal?.cancelled) {
        accepting = false
        encoder.close()
        await Promise.allSettled(writes)
        await window.ledger.export.streamAbort(streamId)
        return { canceled: true }
      }

      if (!pending) throw new Error('export lost track of its next frames')
      const [screens, cams] = await pending
      pending = null
      const nextI = i + n
      const nextN = nextI < frameCount ? chunkLen(nextI) : 0
      if (nextN) pending = fetchChunk(nextI, nextN)

      if (!screens.length && !screenFeed.hasFrame) {
        throw new Error('could not read any video from the recording')
      }
      const sFrames = screenFeed.take(screens, n)
      const cFrames = cameraFeed.take(cams, n)
      if (screenFeed.heldFrames > maxHeld) {
        throw new Error(
          `the recording ends early — about ${(screenFeed.heldFrames / fps).toFixed(1)}s of video is missing`
        )
      }

      for (let k = 0; k < n; k++) {
        const idx = i + k
        const s = sFrames[k]!
        const c = cFrames[k]
        renderFrame(ctx, project, plan[idx], bitmapSource(s), c ? bitmapSource(c) : null)

        check()
        if (failAt !== undefined && idx === failAt) {
          throw new EncoderFailure('injected encoder failure (test)')
        }

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

        // Back-pressure, with a deadline: a wedged encoder must not hang forever.
        const waitStart = performance.now()
        while (encoder.encodeQueueSize > 8) {
          check()
          if (performance.now() - waitStart > ENCODER_STALL_MS) {
            throw new EncoderFailure('video encoder stopped responding')
          }
          await new Promise((r) => setTimeout(r, 2))
        }
      }

      screenFeed.release(screens)
      cameraFeed.release(cams)
      i = nextI
      n = nextN
      opts.onProgress?.((i / frameCount) * 0.95, 'Rendering video')
    }

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
    return {
      canceled: false,
      filePath: res.filePath,
      audio: res.audio,
      audioDetail: res.audioDetail,
      encoder: accel === 'prefer-hardware' ? 'hardware' : 'software'
    }
  } catch (e) {
    // Stop the encoder before discarding its stream, so nothing is written
    // to a file that no longer exists.
    accepting = false
    if (encoder.state !== 'closed') encoder.close()
    await Promise.allSettled(writes)
    pending?.then(
      ([a, b]) => [...a, ...b].forEach((bm) => bm.close()),
      () => {}
    )
    await window.ledger.export.streamAbort(streamId).catch(() => {})
    throw e
  } finally {
    if (encoder.state !== 'closed') encoder.close()
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
