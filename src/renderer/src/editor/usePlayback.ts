import { useCallback, useEffect, useRef, useState } from 'react'
import type { Project } from '../lib/types'
import { clipToOutput, outputToSource, renderFrame, totalDuration } from '../lib/composite'

interface Refs {
  canvas: HTMLCanvasElement | null
  screen: HTMLVideoElement | null
  camera: HTMLVideoElement | null
}

export function usePlayback(project: Project | null, refs: Refs) {
  const [playing, setPlaying] = useState(false)
  const [outputTime, setOutputTime] = useState(0)
  const [sourceTime, setSourceTime] = useState(0)
  const raf = useRef(0)
  const curClip = useRef(0)
  const lastStateUpdate = useRef(0)
  const projectRef = useRef(project)
  projectRef.current = project

  const draw = useCallback(() => {
    const p = projectRef.current
    const { canvas, screen, camera } = refs
    if (!p || !canvas || !screen) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    renderFrame(ctx, p, screen.currentTime, screen, camera)
  }, [refs])

  useEffect(() => {
    const loop = (): void => {
      const p = projectRef.current
      const { screen, camera } = refs
      if (p && screen && p.clips.length) {
        let idx = Math.min(curClip.current, p.clips.length - 1)
        let clip = p.clips[idx]
        const t = screen.currentTime

        if (playing) {
          if (t >= clip.outPoint - 1e-3) {
            // advance to the next clip, or end
            if (idx + 1 < p.clips.length) {
              idx += 1
              curClip.current = idx
              clip = p.clips[idx]
              screen.currentTime = clip.inPoint
              if (camera) camera.currentTime = clip.inPoint
            } else {
              screen.pause()
              camera?.pause()
              setPlaying(false)
            }
          } else if (t < clip.inPoint - 0.05) {
            screen.currentTime = clip.inPoint
          }
          if (camera && Math.abs(camera.currentTime - screen.currentTime) > 0.25) {
            camera.currentTime = screen.currentTime
          }
        }

        const now = performance.now()
        if (now - lastStateUpdate.current > 50) {
          lastStateUpdate.current = now
          setSourceTime(screen.currentTime)
          setOutputTime(clipToOutput(p, curClip.current, screen.currentTime))
        }
      }
      draw()
      raf.current = requestAnimationFrame(loop)
    }
    raf.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf.current)
  }, [draw, playing, refs])

  // Seek by OUTPUT time (what the timeline/playhead uses).
  const seek = useCallback(
    (outT: number) => {
      const p = projectRef.current
      const { screen, camera } = refs
      if (!p || !screen) return
      const clamped = Math.max(0, Math.min(totalDuration(p), outT))
      const { index, source } = outputToSource(p, clamped)
      curClip.current = index
      screen.currentTime = source
      if (camera) camera.currentTime = source
      setOutputTime(clamped)
      setSourceTime(source)
    },
    [refs]
  )

  const play = useCallback(() => {
    const p = projectRef.current
    const { screen, camera } = refs
    if (!p || !screen) return
    if (outputTime >= totalDuration(p) - 1e-3) {
      seek(0)
    }
    screen.play()
    camera?.play()
    setPlaying(true)
  }, [refs, outputTime, seek])

  const pause = useCallback(() => {
    refs.screen?.pause()
    refs.camera?.pause()
    setPlaying(false)
  }, [refs])

  const toggle = useCallback(() => {
    if (playing) pause()
    else play()
  }, [playing, play, pause])

  return { playing, sourceTime, outputTime, play, pause, toggle, seek }
}
