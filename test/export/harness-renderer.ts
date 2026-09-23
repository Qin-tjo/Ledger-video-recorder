/** Renderer side of the export test: builds a project from a case and runs
 * the app's real exporter on it. */
import { defaultProject } from '../../src/renderer/src/lib/types'
import { makeClips, outputSizeFor } from '../../src/renderer/src/lib/composite'
import { exportVideo, type Accel } from '../../src/renderer/src/editor/exporter'

interface Case {
  name: string
  screenPath: string
  cameraPath?: string
  srcW: number
  srcH: number
  duration: number
  clips?: [number, number][]
  crop?: { x: number; y: number; w: number; h: number }
  size?: { width: number; height: number }
  background?: Record<string, unknown>
  zooms?: { start: number; end: number; scale: number; focusX: number; focusY: number }[]
  startWith?: Accel
  injectFailAt?: number
}

;(window as unknown as { runCase: (c: Case) => Promise<unknown> }).runCase = async (c) => {
  const p = defaultProject()
  p.screenSrc = 'unused:screen'
  p.screenPath = c.screenPath
  p.cameraPath = c.cameraPath ?? null
  p.cameraSrc = c.cameraPath ? 'unused:camera' : null
  p.camera.enabled = !!c.cameraPath
  p.duration = c.duration
  p.clips = c.clips
    ? c.clips.map(([a, b], i) => ({ id: `c${i}`, inPoint: a, outPoint: b }))
    : makeClips(c.duration)
  p.crop = c.crop ?? null
  const size = c.size ?? outputSizeFor(c.srcW, c.srcH, p.crop)
  p.outputWidth = size.width
  p.outputHeight = size.height
  if (c.background) Object.assign(p.background, c.background)
  if (c.zooms) p.zooms = c.zooms.map((z, i) => ({ id: `z${i}`, ...z }))

  // Same order as the app: choose the destination, then export.
  const out = await window.ledger.export.chooseSavePath('recording.mp4')
  if (!out) throw new Error('no output path')
  const res = await exportVideo(p, out, {
    startWith: c.startWith,
    injectEncoderFailureAt: c.injectFailAt
  })
  return { ...res, outputWidth: p.outputWidth, outputHeight: p.outputHeight }
}
