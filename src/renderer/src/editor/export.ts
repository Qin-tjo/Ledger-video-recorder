import type { Project } from '../lib/types'
import { clipDur, renderFrame, totalDuration } from '../lib/composite'

interface ExportOpts {
  fps?: number
  onProgress?: (fraction: number) => void
}

function seek(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const onSeeked = (): void => {
      video.removeEventListener('seeked', onSeeked)
      resolve()
    }
    video.addEventListener('seeked', onSeeked)
    video.currentTime = t
  })
}

function pickMime(): string {
  const c = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
  return c.find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm'
}

/** A detached, ready-to-use video element for rendering during export. */
function makeVideo(src: string, muted: boolean): Promise<HTMLVideoElement> {
  const v = document.createElement('video')
  v.src = src
  v.preload = 'auto'
  v.muted = muted
  v.playsInline = true
  return new Promise((resolve, reject) => {
    const ok = (): void => {
      v.removeEventListener('loadeddata', ok)
      resolve(v)
    }
    v.addEventListener('loadeddata', ok)
    v.addEventListener('error', () => reject(new Error('Failed to load media for export')))
  })
}

/**
 * Renders the project composition to a WebM Blob using its OWN detached video
 * elements (so the editor preview is untouched). Audio is routed through the
 * Web Audio graph into the recording — NOT to the speakers — so nothing plays
 * aloud during export. Uses the same renderFrame() as the live preview.
 */
export async function exportProject(project: Project, opts: ExportOpts = {}): Promise<Blob> {
  const fps = opts.fps ?? 30
  const total = totalDuration(project)
  const canvas = document.createElement('canvas')
  canvas.width = project.outputWidth
  canvas.height = project.outputHeight
  const ctx = canvas.getContext('2d')!

  const screen = await makeVideo(project.screenSrc, false)
  const camera = project.cameraSrc ? await makeVideo(project.cameraSrc, true) : null

  const videoStream = canvas.captureStream(fps)

  // Route the screen element's audio (which holds the mic track) into the
  // recording via Web Audio, connected ONLY to a stream destination — never to
  // audioCtx.destination — so it is captured but never audible.
  const audioCtx = new AudioContext()
  await audioCtx.resume().catch(() => {})
  try {
    const srcNode = audioCtx.createMediaElementSource(screen)
    const dest = audioCtx.createMediaStreamDestination()
    srcNode.connect(dest)
    const track = dest.stream.getAudioTracks()[0]
    if (track) videoStream.addTrack(track)
  } catch {
    // no audio track available — export silent video
  }

  const mime = pickMime()
  const recorder = new MediaRecorder(videoStream, {
    mimeType: mime,
    videoBitsPerSecond: 8_000_000
  })
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  const done = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mime }))
  })

  // Play each clip's source range in order, drawing the composed canvas.
  recorder.start()
  let outAcc = 0
  for (const clip of project.clips) {
    await seek(screen, clip.inPoint)
    if (camera) await seek(camera, clip.inPoint)
    await screen.play().catch(() => {})
    camera?.play().catch(() => {})
    await new Promise<void>((resolve) => {
      const step = (): void => {
        const t = screen.currentTime
        if (camera && Math.abs(camera.currentTime - t) > 0.2) camera.currentTime = t
        renderFrame(ctx, project, t, screen, camera)
        const outT = outAcc + Math.max(0, t - clip.inPoint)
        opts.onProgress?.(total > 0 ? Math.min(1, outT / total) : 1)
        if (t >= clip.outPoint - 1 / fps) {
          resolve()
          return
        }
        requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    })
    screen.pause()
    camera?.pause()
    outAcc += clipDur(clip)
  }

  recorder.stop()
  const blob = await done
  opts.onProgress?.(1)

  // cleanup
  audioCtx.close().catch(() => {})
  screen.src = ''
  if (camera) camera.src = ''
  return blob
}
