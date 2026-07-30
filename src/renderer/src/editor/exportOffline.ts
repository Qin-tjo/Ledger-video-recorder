import type { Project } from '../lib/types'
import { clipDur, renderFrame, resetAutoGain, totalDuration } from '../lib/composite'

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

  encoder.configure({
    codec: 'avc1.4d0028', // H.264 Main @ 4.0 — broadly playable
    width: project.outputWidth,
    height: project.outputHeight,
    bitrate: 8_000_000,
    framerate: fps,
    avc: { format: 'annexb' },
    hardwareAcceleration: 'prefer-hardware'
  })

  resetAutoGain()
  const frameDurUs = 1_000_000 / fps

  for (let i = 0; i < frameCount; i++) {
    if (opts.signal?.cancelled) break
    if (encodeError) throw encodeError

    const outT = i / fps
    const srcT = frameToSource(project, outT)

    await seekTo(screen, srcT)
    if (camera) await seekTo(camera, srcT)

    renderFrame(ctx, project, srcT, screen, camera)

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
