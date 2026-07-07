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

/**
 * Renders the project composition to a WebM Blob by stepping the source videos
 * frame-by-frame and drawing via the SAME renderFrame used for preview.
 * Audio is taken live from the screen video element's captured stream.
 */
export async function exportProject(
  project: Project,
  screen: HTMLVideoElement,
  camera: HTMLVideoElement | null,
  opts: ExportOpts = {}
): Promise<Blob> {
  const fps = opts.fps ?? 30
  const total = totalDuration(project)
  const canvas = document.createElement('canvas')
  canvas.width = project.outputWidth
  canvas.height = project.outputHeight
  const ctx = canvas.getContext('2d')!

  const wasPlaying = !screen.paused
  screen.pause()
  camera?.pause()

  const videoStream = canvas.captureStream(fps)

  // Attach audio from the screen element (holds the mic track).
  try {
    // capture the element's audio into the stream
    const el = screen as HTMLMediaElement & {
      captureStream?: () => MediaStream
      mozCaptureStream?: () => MediaStream
    }
    const capture = el.captureStream || el.mozCaptureStream
    if (capture) {
      const elStream = capture.call(el)
      const audioTrack = elStream.getAudioTracks()[0]
      if (audioTrack) videoStream.addTrack(audioTrack)
    }
  } catch {
    // no audio — export video only
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

  // Play each clip's source range in order, in real time (keeps audio aligned),
  // drawing the composed canvas from the current frame.
  recorder.start()
  screen.muted = false
  let outAcc = 0
  for (const clip of project.clips) {
    await seek(screen, clip.inPoint)
    if (camera) camera.currentTime = clip.inPoint
    screen.play()
    camera?.play()
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
  void wasPlaying
  return blob
}
