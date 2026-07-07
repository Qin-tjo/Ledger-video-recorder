export type CameraShape = 'circle' | 'rounded' | 'square'
export type CameraCorner = 'bl' | 'br' | 'tl' | 'tr' | 'custom'

export interface CameraLayout {
  enabled: boolean
  shape: CameraShape
  // size as fraction of the output height
  size: number
  // zoom/crop inside the bubble (1 = fit; >1 crops tighter to fill the face)
  zoom: number
  // normalized center position (0..1) in output space
  x: number
  y: number
  corner: CameraCorner
  mirror: boolean
  border: boolean
}

export interface Background {
  mode: 'none' | 'solid' | 'gradient'
  color: string
  color2: string
  padding: number // fraction of output width used as inset padding
  radius: number // px corner radius of the inset screen
}

/** A punch-in zoom over a time span: eases from 1× up to `scale` (focused on
 * focusX/focusY), holds, then eases back to 1×. */
export interface ZoomEffect {
  id: string
  start: number // source seconds
  end: number // source seconds
  scale: number // peak zoom (1 = none)
  focusX: number // 0..1 point of interest
  focusY: number
}

/** A clip references a range of the source recording. The final video is the
 * clips played back-to-back in order (CapCut-style). Deleting a clip closes the
 * gap; splitting divides one clip into two; trimming changes a clip's in/out. */
export interface Clip {
  id: string
  inPoint: number // source seconds
  outPoint: number // source seconds
}

export interface Project {
  screenSrc: string // blob/file url
  cameraSrc: string | null
  duration: number // seconds (source)
  clips: Clip[]
  camera: CameraLayout
  background: Background
  zooms: ZoomEffect[]
  outputWidth: number
  outputHeight: number
}

export const defaultProject = (): Project => ({
  screenSrc: '',
  cameraSrc: null,
  duration: 0,
  clips: [],
  camera: {
    enabled: true,
    shape: 'circle',
    size: 0.24,
    zoom: 1,
    x: 0.13,
    y: 0.83,
    corner: 'bl',
    mirror: true,
    border: true
  },
  background: {
    mode: 'none',
    color: '#0b0c10',
    color2: '#312e81',
    padding: 0.06,
    radius: 16
  },
  zooms: [],
  outputWidth: 1920,
  outputHeight: 1080
})
