import type { Clip, Project, ZoomEffect } from './types'
import { uid } from './uid'

// Clip model ---------------------------------------------------------------
// The final video is the clips played in order. Timeline is laid out in OUTPUT
// time (clips packed left-to-right). Split divides a clip; delete ripples the
// rest closed; trimming a clip's edge changes its in/out.

export const MIN_CLIP = 0.2 // shortest allowed clip (seconds)

export function makeClips(duration: number): Clip[] {
  return [{ id: uid(), inPoint: 0, outPoint: Math.max(MIN_CLIP, duration) }]
}

export const clipDur = (c: Clip): number => Math.max(0, c.outPoint - c.inPoint)

export function totalDuration(p: Project): number {
  return p.clips.reduce((s, c) => s + clipDur(c), 0)
}

export interface ClipBox {
  clip: Clip
  index: number
  outStart: number
  outEnd: number
}

/** Clips with their cumulative output positions. */
export function clipLayout(p: Project): ClipBox[] {
  let acc = 0
  return p.clips.map((clip, index) => {
    const outStart = acc
    acc += clipDur(clip)
    return { clip, index, outStart, outEnd: acc }
  })
}

/** Map an output time to { clip index, source time }. */
export function outputToSource(p: Project, outT: number): { index: number; source: number } {
  let acc = 0
  for (let i = 0; i < p.clips.length; i++) {
    const d = clipDur(p.clips[i])
    if (outT < acc + d || i === p.clips.length - 1) {
      const within = Math.max(0, Math.min(d, outT - acc))
      return { index: i, source: p.clips[i].inPoint + within }
    }
    acc += d
  }
  return { index: 0, source: p.clips[0]?.inPoint ?? 0 }
}

/** Output time for a given source time inside a specific clip. */
export function clipToOutput(p: Project, index: number, source: number): number {
  let acc = 0
  for (let i = 0; i < index; i++) acc += clipDur(p.clips[i])
  const c = p.clips[index]
  if (!c) return acc
  return acc + Math.max(0, Math.min(clipDur(c), source - c.inPoint))
}

// --- Editing operations (pure) ---

/** Split the clip at the given OUTPUT time into two clips. */
export function splitAt(p: Project, outT: number): { clips: Clip[]; newId: string | null } {
  const { index, source } = outputToSource(p, outT)
  const c = p.clips[index]
  if (!c || source <= c.inPoint + MIN_CLIP || source >= c.outPoint - MIN_CLIP) {
    return { clips: p.clips, newId: null }
  }
  const left: Clip = { id: c.id, inPoint: c.inPoint, outPoint: source }
  const right: Clip = { id: uid(), inPoint: source, outPoint: c.outPoint }
  return {
    clips: [...p.clips.slice(0, index), left, right, ...p.clips.slice(index + 1)],
    newId: right.id
  }
}

/** Delete a clip (ripple). Keeps at least one clip. */
export function deleteClip(clips: Clip[], id: string): Clip[] {
  if (clips.length <= 1) return clips
  return clips.filter((c) => c.id !== id)
}

/** Trim a clip's head (inPoint) or tail (outPoint) to an absolute source time. */
export function trimClip(
  clips: Clip[],
  id: string,
  side: 'in' | 'out',
  sourceT: number,
  duration: number
): Clip[] {
  return clips.map((c) => {
    if (c.id !== id) return c
    if (side === 'in') {
      return { ...c, inPoint: Math.max(0, Math.min(sourceT, c.outPoint - MIN_CLIP)) }
    }
    return { ...c, outPoint: Math.min(duration, Math.max(sourceT, c.inPoint + MIN_CLIP)) }
  })
}

// Zoom punch-in ------------------------------------------------------------

const easeInOut = (x: number): number =>
  x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2

interface ZoomState {
  scale: number
  focusX: number
  focusY: number
}

export const ZOOM_RAMP = 0.45 // seconds to ease in / out

/** Zoom state at source time t: eases 1×→scale→1× within each effect span. */
export function zoomStateAt(effects: ZoomEffect[], t: number): ZoomState {
  for (const e of effects) {
    if (t < e.start || t > e.end) continue
    const ramp = Math.min(ZOOM_RAMP, (e.end - e.start) / 2)
    let f = 1
    if (ramp > 0) {
      if (t < e.start + ramp) f = easeInOut((t - e.start) / ramp)
      else if (t > e.end - ramp) f = easeInOut((e.end - t) / ramp)
    }
    return {
      scale: 1 + (e.scale - 1) * f,
      focusX: e.focusX,
      focusY: e.focusY
    }
  }
  return { scale: 1, focusX: 0.5, focusY: 0.5 }
}

// Layout of the inset screen rect (accounting for background padding) ------

function screenRect(
  p: Project,
  W: number,
  H: number
): { x: number; y: number; w: number; h: number; radius: number } {
  if (p.background.mode === 'none') return { x: 0, y: 0, w: W, h: H, radius: 0 }
  const pad = p.background.padding * W
  return {
    x: pad,
    y: pad,
    w: W - pad * 2,
    h: H - pad * 2,
    radius: p.background.radius
  }
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

// The single source of truth used by BOTH preview and export ---------------

export function renderFrame(
  ctx: CanvasRenderingContext2D,
  p: Project,
  sourceTime: number,
  screenVideo: HTMLVideoElement,
  cameraVideo: HTMLVideoElement | null
): void {
  const W = p.outputWidth
  const H = p.outputHeight

  // 1. Background
  if (p.background.mode === 'solid') {
    ctx.fillStyle = p.background.color
    ctx.fillRect(0, 0, W, H)
  } else if (p.background.mode === 'gradient') {
    const g = ctx.createLinearGradient(0, 0, W, H)
    g.addColorStop(0, p.background.color)
    g.addColorStop(1, p.background.color2)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, H)
  } else {
    ctx.clearRect(0, 0, W, H)
  }

  // 2. Screen layer (with zoom transform), clipped to the inset rect
  const rect = screenRect(p, W, H)
  const z = zoomStateAt(p.zooms, sourceTime)

  ctx.save()
  if (rect.radius > 0) {
    roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, rect.radius)
    ctx.clip()
  } else {
    ctx.beginPath()
    ctx.rect(rect.x, rect.y, rect.w, rect.h)
    ctx.clip()
  }

  if (screenVideo.videoWidth > 0) {
    // object-fit: cover within rect
    const vw = screenVideo.videoWidth
    const vh = screenVideo.videoHeight
    const scale = Math.max(rect.w / vw, rect.h / vh) * z.scale
    const dw = vw * scale
    const dh = vh * scale
    // center on focus point
    const fx = rect.x + rect.w * z.focusX
    const fy = rect.y + rect.h * z.focusY
    let dx = fx - dw * z.focusX
    let dy = fy - dh * z.focusY
    // clamp so we never show empty edges
    dx = Math.min(rect.x, Math.max(rect.x + rect.w - dw, dx))
    dy = Math.min(rect.y, Math.max(rect.y + rect.h - dh, dy))
    ctx.drawImage(screenVideo, dx, dy, dw, dh)
  }
  ctx.restore()

  // 3. Camera bubble
  if (p.camera.enabled && cameraVideo && cameraVideo.videoWidth > 0) {
    drawCamera(ctx, p, cameraVideo, W, H)
  }
}

function drawCamera(
  ctx: CanvasRenderingContext2D,
  p: Project,
  cam: HTMLVideoElement,
  W: number,
  H: number
): void {
  const size = p.camera.size * H
  const cx = p.camera.x * W
  const cy = p.camera.y * H
  const x = cx - size / 2
  const y = cy - size / 2

  ctx.save()
  // border / shadow
  if (p.camera.border) {
    ctx.shadowColor = 'rgba(0,0,0,0.45)'
    ctx.shadowBlur = size * 0.12
    ctx.shadowOffsetY = size * 0.04
  }

  const r =
    p.camera.shape === 'circle'
      ? size / 2
      : p.camera.shape === 'rounded'
        ? size * 0.16
        : 0
  roundRectPath(ctx, x, y, size, size, r)
  if (p.camera.border) {
    ctx.fillStyle = '#ffffff'
    ctx.fill()
  }
  ctx.restore()

  ctx.save()
  const inset = p.camera.border ? size * 0.02 : 0
  const ir = Math.max(0, r - inset)
  roundRectPath(ctx, x + inset, y + inset, size - inset * 2, size - inset * 2, ir)
  ctx.clip()

  const vw = cam.videoWidth
  const vh = cam.videoHeight
  const zoom = p.camera.zoom || 1
  const scale = Math.max(size / vw, size / vh) * zoom
  const dw = vw * scale
  const dh = vh * scale
  const dx = x + (size - dw) / 2
  const dy = y + (size - dh) / 2

  if (p.camera.mirror) {
    ctx.translate(x + size / 2, 0)
    ctx.scale(-1, 1)
    ctx.translate(-(x + size / 2), 0)
  }
  ctx.drawImage(cam, dx, dy, dw, dh)
  ctx.restore()
}
