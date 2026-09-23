import type { Project } from '../lib/types'
import {
  bitmapSource,
  clipDur,
  renderFrame,
  resetAutoGain,
  totalDuration,
  videoSource
} from '../lib/composite'

/**
 * Deterministic, offline export.
 *
 * The old exporter played the recording in real time and captured whatever
 * happened to be on the canvas. Any stall — the window losing focus, timer
 * throttling, a CPU spike, the display sleeping — silently recorded a frozen
 * frame, so exports came out stuttering or stuck.
 *
 * This renders frame N by *seeking* to frame N, drawing it, and handing it to
 * an encoder with an explicit timestamp. There is no clock to fall behind, so
 * the output is identical no matter what else the machine is doing. Audio is
 * decoded to PCM and cut to the same clip ranges, then muxed by ffmpeg.
 */

export interface OfflineOpts {
  fps?: number
  onProgress?: (fraction: number, label: string) => void
  onAudioIssue?: (reason: string) => void
  signal?: { cancelled: boolean }
}

export interface RenderedMedia {
  h264: ArrayBuffer
  wav: ArrayBuffer | null
  fps: number
}

export function webCodecsAvailable(): boolean {
  return typeof window !== 'undefined' && typeof (window as never as { VideoEncoder?: unknown }).VideoEncoder === 'function'
}

/**
 * Pick an H.264 level that can actually code `width`x`height` at `fps`.
 *
 * This used to be hardcoded to Main@4.0. That fits standard 1920x1080 (8160
 * macroblocks, under the 8192 limit) but NOT a cropped 1924x1080, which rounds
 * up to 8228 and is rejected. configure() then failed, the codec closed, and
 * the next encode() threw a confusing "closed codec" InvalidStateError instead
 * of the real reason.
 *
 * Levels are tried lowest-first so ordinary exports keep the widest device
 * compatibility, and each candidate is checked with the browser rather than
 * assumed.
 */
const AVC_LEVELS: { codec: string; maxFS: number; maxMBPS: number }[] = [
  { codec: 'avc1.4d0028', maxFS: 8192, maxMBPS: 245760 }, // 4.0
  { codec: 'avc1.4d002a', maxFS: 8704, maxMBPS: 522240 }, // 4.2
  { codec: 'avc1.4d0032', maxFS: 22080, maxMBPS: 589824 }, // 5.0
  { codec: 'avc1.4d0033', maxFS: 36864, maxMBPS: 983040 } // 5.1
]

async function encoderConfigFor(
  width: number,
  height: number,
  fps: number
): Promise<VideoEncoderConfig> {
  const frameSize = Math.ceil(width / 16) * Math.ceil(height / 16)
  const base = {
    width,
    height,
    bitrate: 8_000_000,
    framerate: fps,
    avc: { format: 'annexb' as const },
    hardwareAcceleration: 'prefer-hardware' as const
  }
  const VE = (window as never as { VideoEncoder: typeof VideoEncoder }).VideoEncoder

  let lastReason = ''
  for (const lvl of AVC_LEVELS) {
    if (frameSize > lvl.maxFS || frameSize * fps > lvl.maxMBPS) continue
    const config = { ...base, codec: lvl.codec }
    try {
      const support = await VE.isConfigSupported(config)
      if (support.supported) return config
      lastReason = `${lvl.codec} not supported`
    } catch (e) {
      lastReason = String(e)
    }
  }
  throw new Error(
    `no H.264 level can encode ${width}x${height} at ${fps}fps` +
      (lastReason ? ` (${lastReason})` : '')
  )
}

function loadVideo(src: string, muted: boolean): Promise<HTMLVideoElement> {
  const v = document.createElement('video')
  v.src = src
  v.preload = 'auto'
  v.muted = muted
  v.playsInline = true
  return new Promise((resolve, reject) => {
    const ok = (): void => resolve(v)
    v.addEventListener('loadeddata', ok, { once: true })
    v.addEventListener('error', () => reject(new Error('Could not read the recording')), {
      once: true
    })
  })
}

/** Seek and wait until the frame at `t` is actually decoded and presentable. */
function seekTo(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      v.removeEventListener('seeked', done)
      resolve()
    }
    // Already there (within a sub-frame tolerance).
    if (Math.abs(v.currentTime - t) < 0.001 && v.readyState >= 2) {
      resolve()
      return
    }
    v.addEventListener('seeked', done)
    v.currentTime = t
    // Never hang the whole export on one bad seek.
    setTimeout(done, 2000)
  })
}

/** Map output frame index -> source time, walking the clip list. */
function frameToSource(project: Project, outT: number): number {
  let acc = 0
  for (const c of project.clips) {
    const d = clipDur(c)
    if (outT < acc + d) return c.inPoint + (outT - acc)
    acc += d
  }
  const last = project.clips[project.clips.length - 1]
  return last ? last.outPoint : 0
}

export async function renderOffline(
  project: Project,
  opts: OfflineOpts = {}
): Promise<RenderedMedia> {
  const fps = opts.fps ?? 30
  const total = totalDuration(project)
  const frameCount = Math.max(1, Math.round(total * fps))

  const canvas = document.createElement('canvas')
  canvas.width = project.outputWidth
  canvas.height = project.outputHeight
  const ctx = canvas.getContext('2d', { alpha: false })!

  const screen = await loadVideo(project.screenSrc, true)
  const camera = project.cameraSrc ? await loadVideo(project.cameraSrc, true) : null

  // ---- video ----
  const chunks: Uint8Array[] = []
  const VE = (window as never as { VideoEncoder: typeof VideoEncoder }).VideoEncoder
  let encodeError: Error | null = null
  const encoder = new VE({
    output: (chunk: EncodedVideoChunk) => {
      const buf = new Uint8Array(chunk.byteLength)
      chunk.copyTo(buf)
      chunks.push(buf)
    },
    error: (e: Error) => {
      encodeError = e
    }
  })

  encoder.configure(
    await encoderConfigFor(project.outputWidth, project.outputHeight, fps)
  )

  resetAutoGain()
  const frameDurUs = 1_000_000 / fps

  for (let i = 0; i < frameCount; i++) {
    if (opts.signal?.cancelled) break
    if (encodeError) throw encodeError

    const outT = i / fps
    const srcT = frameToSource(project, outT)

    await seekTo(screen, srcT)
    if (camera) await seekTo(camera, srcT)

    renderFrame(ctx, project, srcT, videoSource(screen), camera ? videoSource(camera) : null)

    const frame = new VideoFrame(canvas, {
      timestamp: Math.round(i * frameDurUs),
      duration: Math.round(frameDurUs)
    })
    encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 })
    frame.close()

    // Don't let the encoder queue run away on long exports.
    while (encoder.encodeQueueSize > 8) {
      await new Promise((r) => setTimeout(r, 4))
    }

    if (i % 5 === 0) {
      opts.onProgress?.((i / frameCount) * 0.9, 'Rendering video')
    }
  }

  await encoder.flush()
  encoder.close()
  if (encodeError) throw encodeError

  const totalBytes = chunks.reduce((n, c) => n + c.byteLength, 0)
  const h264 = new Uint8Array(totalBytes)
  let off = 0
  for (const c of chunks) {
    h264.set(c, off)
    off += c.byteLength
  }

  // ---- audio ----
  opts.onProgress?.(0.92, 'Rendering audio')
  let wav: ArrayBuffer | null = null
  let audioError: string | null = null
  try {
    wav = await renderAudio(project)
    if (!wav) audioError = 'no audio track in the recording'
  } catch (e) {
    // Still produce the video, but never let a silent export be a surprise.
    audioError = String(e)
    console.error('audio render failed', e)
  }
  if (audioError) opts.onAudioIssue?.(audioError)

  screen.src = ''
  if (camera) camera.src = ''
  opts.onProgress?.(1, 'Finishing')

  return { h264: h264.buffer, wav, fps }
}

/** Decode the source audio and concatenate exactly the kept clip ranges. */
async function renderAudio(project: Project): Promise<ArrayBuffer | null> {
  // XHR rather than fetch: blob: URLs are reachable here without needing a
  // connect-src exception, and it works the same for file-backed blobs.
  const raw = await new Promise<ArrayBuffer>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', project.screenSrc, true)
    xhr.responseType = 'arraybuffer'
    xhr.onload = () => resolve(xhr.response as ArrayBuffer)
    xhr.onerror = () => reject(new Error('could not read the recording audio'))
    xhr.send()
  })
  const ac = new OfflineAudioContext(2, 1, 48000)
  const decoded = await ac.decodeAudioData(raw)
  if (!decoded || decoded.length === 0) return null

  const sr = decoded.sampleRate
  const channels = Math.min(2, decoded.numberOfChannels)
  const segments = project.clips.map((c) => {
    const start = Math.max(0, Math.floor(c.inPoint * sr))
    const end = Math.min(decoded.length, Math.ceil(c.outPoint * sr))
    return { start, end: Math.max(start, end) }
  })
  const frames = segments.reduce((n, s) => n + (s.end - s.start), 0)
  if (frames <= 0) return null

  const out: Float32Array[] = []
  for (let ch = 0; ch < channels; ch++) {
    const data = decoded.getChannelData(Math.min(ch, decoded.numberOfChannels - 1))
    const buf = new Float32Array(frames)
    let o = 0
    for (const s of segments) {
      buf.set(data.subarray(s.start, s.end), o)
      o += s.end - s.start
    }
    out.push(buf)
  }
  return encodeWav(out, sr)
}

/** 16-bit PCM WAV — ffmpeg re-encodes to AAC during the mux. */
function encodeWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const numCh = channels.length
  const frames = channels[0].length
  const dataBytes = frames * numCh * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)

  const str = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, numCh, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * numCh * 2, true)
  view.setUint16(32, numCh * 2, true)
  view.setUint16(34, 16, true)
  str(36, 'data')
  view.setUint32(40, dataBytes, true)

  let off = 44
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, channels[ch][i]))
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      off += 2
    }
  }
  return buffer
}


// ---------------------------------------------------------------------------
// Fast path: decode with ffmpeg, stream the encode to disk.
//
// Seeking an HTMLVideoElement costs ~100ms per frame in Chromium no matter the
// codec — that's fixed pipeline overhead, not decode (ffmpeg reads the same
// recording at ~1000fps). So a 8-minute export spent ~25 minutes seeking. Here
// frames are pulled from ffmpeg sequentially in chunks instead, and the encoded
// H.264 is written straight to a temp file rather than accumulated in renderer
// memory — holding ~1GB of chunks was what made the VideoEncoder die mid-export
// with "Cannot call 'encode' on a closed codec".
// ---------------------------------------------------------------------------

/** Frames per ffmpeg call. Big enough to amortize process startup, small
 * enough that one chunk of JPEGs is a modest buffer. */
const CHUNK_FRAMES = 120

/** Split concatenated JPEGs (ffmpeg image2pipe output) into individual blobs. */
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
  return Promise.all(
    jpegs.map((j) => createImageBitmap(new Blob([j as BlobPart], { type: 'image/jpeg' })))
  )
}

/** One entry per output frame: which clip it's in and its source time. */
function framePlan(project: Project, fps: number): { srcT: number }[] {
  const plan: { srcT: number }[] = []
  for (const c of project.clips) {
    const n = Math.max(1, Math.round(clipDur(c) * fps))
    for (let i = 0; i < n; i++) plan.push({ srcT: c.inPoint + i / fps })
  }
  return plan
}

export function fastPathAvailable(project: Project): boolean {
  return webCodecsAvailable() && !!project.screenPath
}

/**
 * Render and save in one pass. Returns the same shape as the save dialog so the
 * caller can report where the file went.
 */
export async function renderAndSave(
  project: Project,
  suggested: string,
  opts: OfflineOpts = {}
): Promise<{ canceled: boolean; filePath?: string }> {
  const fps = opts.fps ?? 30
  const screenPath = project.screenPath!
  const cameraPath = project.camera.enabled ? project.cameraPath : null

  const canvas = document.createElement('canvas')
  canvas.width = project.outputWidth
  canvas.height = project.outputHeight
  const ctx = canvas.getContext('2d', { alpha: false })!

  const plan = framePlan(project, fps)
  const frameCount = plan.length

  // Resolve the encoder config first: if no level can code this size there is
  // nothing to clean up yet.
  const encoderConfig = await encoderConfigFor(project.outputWidth, project.outputHeight, fps)
  const streamId = await window.ledger.export.streamBegin()

  const VE = (window as never as { VideoEncoder: typeof VideoEncoder }).VideoEncoder
  let encodeError: Error | null = null
  const writes: Promise<void>[] = []
  const encoder = new VE({
    output: (chunk: EncodedVideoChunk) => {
      const buf = new Uint8Array(chunk.byteLength)
      chunk.copyTo(buf)
      writes.push(
        window.ledger.export.streamWrite(streamId, buf.buffer).catch((e) => {
          encodeError = encodeError ?? (e as Error)
        })
      )
    },
    error: (e: Error) => {
      encodeError = encodeError ?? e
    }
  })
  encoder.configure(encoderConfig)

  resetAutoGain()
  const frameDurUs = 1_000_000 / fps

  // How many frames the chunk starting at `i` covers: up to CHUNK_FRAMES, but
  // never across a cut, so ffmpeg only ever decodes one contiguous span.
  const chunkLen = (i: number): number => {
    const startT = plan[i].srcT
    let n = 1
    while (
      n < CHUNK_FRAMES &&
      i + n < frameCount &&
      Math.abs(plan[i + n].srcT - (startT + n / fps)) < 1e-6
    ) {
      n++
    }
    return n
  }

  const fetchChunk = (i: number, n: number): Promise<[ImageBitmap[], ImageBitmap[]]> =>
    Promise.all([
      decodeChunk(screenPath, plan[i].srcT, n, fps),
      cameraPath ? decodeChunk(cameraPath, plan[i].srcT, n, fps) : Promise.resolve([])
    ])

  try {
    let i = 0
    let n = chunkLen(0)
    // Decoding and encoding are both ~realtime-bound, so keep one chunk in
    // flight while the previous one encodes.
    let pending: Promise<[ImageBitmap[], ImageBitmap[]]> | null = fetchChunk(0, n)

    while (i < frameCount) {
      if (opts.signal?.cancelled) {
        pending?.catch(() => {})
        await window.ledger.export.streamAbort(streamId)
        encoder.close()
        return { canceled: true }
      }

      const [screens, cams] = await pending!
      if (!screens.length) throw new Error('the recording could not be decoded')

      const nextI = i + n
      const nextN = nextI < frameCount ? chunkLen(nextI) : 0
      pending = nextN ? fetchChunk(nextI, nextN) : null

      for (let k = 0; k < n; k++) {
        // ffmpeg can return a frame or two short at the tail of a span; hold
        // the last decoded frame rather than dropping output frames.
        const sBmp = screens[Math.min(k, screens.length - 1)]
        const cBmp = cams.length ? cams[Math.min(k, cams.length - 1)] : null

        renderFrame(
          ctx,
          project,
          plan[i + k].srcT,
          bitmapSource(sBmp),
          cBmp ? bitmapSource(cBmp) : null
        )

        if (encodeError) throw encodeError
        if (encoder.state !== 'configured') {
          throw new Error('the video encoder stopped unexpectedly')
        }

        const frame = new VideoFrame(canvas, {
          timestamp: Math.round((i + k) * frameDurUs),
          duration: Math.round(frameDurUs)
        })
        encoder.encode(frame, { keyFrame: (i + k) % (fps * 2) === 0 })
        frame.close()

        while (encoder.encodeQueueSize > 8 && !encodeError) {
          await new Promise((r) => setTimeout(r, 2))
        }
      }

      for (const b of screens) b.close()
      for (const b of cams) b.close()

      i = nextI
      n = nextN
      opts.onProgress?.((i / frameCount) * 0.9, 'Rendering video')
    }

    await encoder.flush()
    encoder.close()
    await Promise.all(writes)
    if (encodeError) throw encodeError

    opts.onProgress?.(0.92, 'Rendering audio')
    let wav: ArrayBuffer | null = null
    let audioError: string | null = null
    try {
      wav = await renderAudio(project)
      if (!wav) audioError = 'no audio track in the recording'
    } catch (e) {
      audioError = String(e)
      console.error('audio render failed', e)
    }
    if (audioError) opts.onAudioIssue?.(audioError)

    opts.onProgress?.(0.96, 'Writing file')
    return await window.ledger.export.streamFinish(streamId, wav, fps, suggested)
  } catch (e) {
    if (encoder.state !== 'closed') encoder.close()
    await window.ledger.export.streamAbort(streamId).catch(() => {})
    throw e
  }
}
