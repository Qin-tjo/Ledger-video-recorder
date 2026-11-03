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
  studio: StudioLook
}

/** Warm "studio lighting" grade for the camera. `autoLight` measures the actual
 * frame brightness and lifts/pulls exposure so dim or harsh rooms still land in
 * a flattering range. */
export interface StudioLook {
  enabled: boolean
  intensity: number // 0..1 overall strength of the grade
  warmth: number // 0..1 golden-hour tint
  autoLight: boolean
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

/** A region of the source screen recording to keep, normalized 0..1. */
export interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

/** Where the real picture sits in the recording's frames. macOS window
 * capture can deliver the same window at slightly different sizes with black
 * bars; preview and export both normalise every frame back to this. Worked
 * out by the main process (sourceGeometry.ts). */
export interface SourceGeometry {
  /** Size of the steady picture. */
  width: number
  height: number
  /** Per frame size: where the picture is within such a frame (measured). */
  regions: { w: number; h: number; x: number; y: number; cw: number; ch: number }[]
  /** For a frame size not in `regions`: the largest region of this shape,
   * placed by align (0 = left/top, 1 = right/bottom). */
  aspect: number
  alignX: number
  alignY: number
  /** Only when sizes vary is anything normalised. */
  varies: boolean
}

export interface Project {
  screenSrc: string // blob/file url
  cameraSrc: string | null
  /** On-disk sources, when known. Export decodes from these with ffmpeg, which
   * is far faster than seeking a <video> and always returns the exact frames. */
  screenPath: string | null
  cameraPath: string | null
  /** null until analysed. */
  source: SourceGeometry | null
  duration: number // seconds (source)
  clips: Clip[]
  /** null = use the whole screen recording. Fractions of the real picture
   * (after normalisation), so a crop means the same thing on every frame. */
  crop: CropRect | null
  camera: CameraLayout
  background: Background
  zooms: ZoomEffect[]
  outputWidth: number
  outputHeight: number
}

export const defaultProject = (): Project => ({
  screenSrc: '',
  cameraSrc: null,
  screenPath: null,
  cameraPath: null,
  source: null,
  duration: 0,
  clips: [],
  crop: null,
  camera: {
    enabled: true,
    shape: 'circle',
    size: 0.24,
    zoom: 1,
    x: 0.13,
    y: 0.83,
    corner: 'bl',
    mirror: true,
    border: true,
    studio: { enabled: true, intensity: 0.6, warmth: 0.5, autoLight: true }
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
