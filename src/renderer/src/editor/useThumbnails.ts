import { useEffect, useState } from 'react'

/**
 * Generates a filmstrip of thumbnails from a video source by seeking a detached
 * video element to evenly spaced points and drawing each to a small canvas.
 */
export function useThumbnails(src: string, duration: number, count = 12): string[] {
  const [thumbs, setThumbs] = useState<string[]>([])

  useEffect(() => {
    if (!src || duration <= 0) {
      setThumbs([])
      return
    }
    let cancelled = false
    const video = document.createElement('video')
    video.src = src
    video.muted = true
    video.preload = 'auto'

    const canvas = document.createElement('canvas')
    const W = 160
    const H = 90
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')!

    const seek = (t: number): Promise<void> =>
      new Promise((resolve) => {
        const onSeeked = (): void => {
          video.removeEventListener('seeked', onSeeked)
          resolve()
        }
        video.addEventListener('seeked', onSeeked)
        video.currentTime = t
      })

    const run = async (): Promise<void> => {
      await new Promise<void>((res) => {
        if (video.readyState >= 1) res()
        else video.addEventListener('loadedmetadata', () => res(), { once: true })
      })
      const out: string[] = []
      for (let i = 0; i < count; i++) {
        if (cancelled) return
        const t = (duration * (i + 0.5)) / count
        try {
          await seek(Math.min(t, Math.max(0, duration - 0.05)))
          // cover-fit the frame into the thumb
          const vw = video.videoWidth || 16
          const vh = video.videoHeight || 9
          const scale = Math.max(W / vw, H / vh)
          const dw = vw * scale
          const dh = vh * scale
          ctx.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh)
          out.push(canvas.toDataURL('image/jpeg', 0.6))
          if (!cancelled) setThumbs([...out])
        } catch {
          out.push('')
        }
      }
    }
    void run()

    return () => {
      cancelled = true
      video.src = ''
    }
  }, [src, duration, count])

  return thumbs
}
