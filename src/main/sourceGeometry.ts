/**
 * Where the real picture sits inside a recording's frames.
 *
 * macOS window capture (when asked to scale) can deliver the same window at
 * several frame sizes, flipping every few seconds. Measured on a real
 * recording: 1918x1036 with a 24px black bar on the left (78% of frames),
 * 1894x1036, and 1920x1050 — and the last is not simply a larger copy: it
 * carries ~6 extra rows at the bottom and is scaled slightly differently on
 * each axis. Played as-is the picture visibly jumps.
 *
 * So rather than assume a shape, this measures, for each frame size, which
 * region holds the same picture as the most common size, by matching image
 * brightness profiles between neighbouring frames. Export and preview then
 * crop each frame to its region, so every frame shows one steady picture.
 *
 * Pure: frame data comes in, geometry goes out — tested without ffmpeg.
 */

export interface Region {
  /** Frame size this applies to. */
  w: number
  h: number
  /** Where the picture is within such a frame. */
  x: number
  y: number
  cw: number
  ch: number
}

export interface SourceGeometry {
  /** Size of the steady picture (the most common frame size's picture). */
  width: number
  height: number
  /** Per frame size: the region holding the picture. */
  regions: Region[]
  /** For a frame size never sampled: the largest region of this shape,
   * placed where bars were seen (0 = left/top, 1 = right/bottom). */
  aspect: number
  alignX: number
  alignY: number
  /** True when frame sizes change. Nothing is cropped otherwise, so a stable
   * recording (even a dark app with black edges) is never touched. */
  varies: boolean
}

export interface FrameSample {
  w: number
  h: number
  /** Seconds into the recording. */
  t: number
  /** Non-black content box found in the frame. */
  box: { x: number; y: number; w: number; h: number }
}

export interface SizeClass {
  w: number
  h: number
  n: number
  times: number[]
  box: { x: number; y: number; w: number; h: number }
}

export interface Gray {
  w: number
  h: number
  data: Uint8Array
}

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
/** A box within this many pixels of the frame edge counts as filling it. */
const EDGE = 4
const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2)

/** Group samples by frame size, most common first. */
export function sizeClasses(samples: FrameSample[]): SizeClass[] {
  const groups = new Map<string, { w: number; h: number; times: number[]; boxes: FrameSample['box'][] }>()
  for (const s of samples) {
    const k = `${s.w}x${s.h}`
    const g = groups.get(k) ?? { w: s.w, h: s.h, times: [], boxes: [] }
    g.times.push(s.t)
    g.boxes.push(s.box)
    groups.set(k, g)
  }
  return [...groups.values()]
    .map((g) => ({
      w: g.w,
      h: g.h,
      n: g.times.length,
      times: g.times,
      box: {
        x: median(g.boxes.map((b) => b.x)),
        y: median(g.boxes.map((b) => b.y)),
        w: median(g.boxes.map((b) => b.w)),
        h: median(g.boxes.map((b) => b.h))
      }
    }))
    .sort((a, b) => b.n - a.n)
}

/** The class used as the steady picture: the most common frame size. */
export const referenceClass = (classes: SizeClass[]): SizeClass => classes[0]

/**
 * Frame pairs (a frame of `k`, a frame of `ref`) taken moments apart, so the
 * screen content is (nearly) the same in both. For each `k` frame both the
 * nearest earlier and nearest later `ref` frame are offered: the screen can
 * change right at a size switch (a scroll, a window resize), and only one
 * side may still match.
 */
export function nearestPairs(k: SizeClass, ref: SizeClass, count = 6): [number, number][] {
  const sorted = [...ref.times].sort((a, b) => a - b)
  const cands: { tk: number; tr: number; d: number }[] = []
  for (const tk of k.times) {
    let before: number | null = null
    let after: number | null = null
    for (const t of sorted) {
      if (t <= tk) before = t
      else {
        after = t
        break
      }
    }
    for (const tr of [before, after]) if (tr !== null) cands.push({ tk, tr, d: Math.abs(tr - tk) })
  }
  cands.sort((a, b) => a.d - b.d)
  const out: [number, number][] = []
  for (const c of cands) {
    // Keep picks from different moments so one odd moment can't dominate.
    if (out.filter(([tk]) => Math.abs(tk - c.tk) < 1).length >= 2) continue
    out.push([c.tk, c.tr])
    if (out.length >= count) break
  }
  return out
}

/** The picture region for a frame size when nothing better is known. */
export function fallbackRegion(fw: number, fh: number, g: Pick<SourceGeometry, 'aspect' | 'alignX' | 'alignY'>): Omit<Region, 'w' | 'h'> {
  const cw = Math.min(fw, Math.round(fh * g.aspect))
  const ch = Math.min(fh, Math.round(fw / g.aspect))
  return { x: Math.round((fw - cw) * g.alignX), y: Math.round((fh - ch) * g.alignY), cw, ch }
}

function crop(img: Gray, b: { x: number; y: number; w: number; h: number }): Gray {
  const out = new Uint8Array(b.w * b.h)
  for (let y = 0; y < b.h; y++) {
    out.set(img.data.subarray((b.y + y) * img.w + b.x, (b.y + y) * img.w + b.x + b.w), y * b.w)
  }
  return { w: b.w, h: b.h, data: out }
}

/** Mean brightness of each column (axis 'x') or row (axis 'y'). */
function profile(img: Gray, axis: 'x' | 'y'): Float64Array {
  const n = axis === 'x' ? img.w : img.h
  const p = new Float64Array(n)
  for (let y = 0; y < img.h; y++) {
    const row = y * img.w
    for (let x = 0; x < img.w; x++) p[axis === 'x' ? x : y] += img.data[row + x]
  }
  const d = axis === 'x' ? img.h : img.w
  for (let i = 0; i < n; i++) p[i] /= d
  return p
}

/** Linear interpolation of `p` at fractional index `at`. */
const sample = (p: Float64Array, at: number): number => {
  const i = Math.max(0, Math.min(p.length - 1, at))
  const lo = Math.floor(i)
  const hi = Math.min(p.length - 1, lo + 1)
  return p[lo] + (p[hi] - p[lo]) * (i - lo)
}

/**
 * Find [start, start+len) of `src` that, stretched to `ref`'s length, best
 * matches `ref`. Compared over the central 80% so edges (where frames
 * differ most) don't dominate. Searches up to ±7% in scale and offset.
 */
function fitAxis(src: Float64Array, ref: Float64Array): { start: number; len: number; err: number } {
  const n = ref.length
  const lo = Math.floor(n * 0.1)
  const hi = Math.ceil(n * 0.9)
  let best = { start: 0, len: Math.min(src.length, n), err: Infinity }
  const minLen = Math.max(2, Math.floor(n * 0.93))
  const maxLen = Math.min(src.length, Math.ceil(n * 1.07))
  for (let len = minLen; len <= maxLen; len++) {
    const maxStart = Math.min(src.length - len, Math.ceil(src.length * 0.07))
    for (let start = 0; start <= maxStart; start++) {
      let e = 0
      const k = len / n
      for (let i = lo; i < hi; i++) {
        const d = sample(src, start + (i + 0.5) * k - 0.5) - ref[i]
        e += d * d
        if (e >= best.err * (hi - lo)) break
      }
      e /= hi - lo
      if (e < best.err) best = { start, len, err: e }
    }
  }
  return best
}

/** Mean squared difference between `ref` and region `r` of `img` stretched
 * onto it (bilinear), sampled on a grid over the central 90%. */
export function regionError(
  img: Gray,
  r: { x: number; y: number; w: number; h: number },
  ref: Gray,
  step = 3
): number {
  let e = 0
  let n = 0
  const sx = r.w / ref.w
  const sy = r.h / ref.h
  for (let y = Math.floor(ref.h * 0.05); y < ref.h * 0.95; y += step) {
    const fy = Math.min(img.h - 1.001, Math.max(0, r.y + (y + 0.5) * sy - 0.5))
    const y0 = Math.floor(fy)
    const ty = fy - y0
    for (let x = Math.floor(ref.w * 0.05); x < ref.w * 0.95; x += step) {
      const fx = Math.min(img.w - 1.001, Math.max(0, r.x + (x + 0.5) * sx - 0.5))
      const x0 = Math.floor(fx)
      const tx = fx - x0
      const i = y0 * img.w + x0
      const top = img.data[i] + (img.data[i + 1] - img.data[i]) * tx
      const bot = img.data[i + img.w] + (img.data[i + img.w + 1] - img.data[i + img.w]) * tx
      const d = top + (bot - top) * ty - ref.data[y * ref.w + x]
      e += d * d
      n++
    }
  }
  return e / Math.max(1, n)
}

/**
 * Polish a region by coordinate descent on the full 2-D error. The 1-D
 * profile fit gets close but can be fooled on one axis — e.g. when the two
 * frame sizes differ in sharpness as well as geometry — and a 5px error in
 * height reads as a visible jump on text.
 */
function refine(img: Gray, ref: Gray, start: Omit<Region, 'w' | 'h'>, reach = 8): Omit<Region, 'w' | 'h'> {
  let cur = { ...start }
  const err = (c: Omit<Region, 'w' | 'h'>): number =>
    c.x < 0 || c.y < 0 || c.cw < 2 || c.ch < 2 || c.x + c.cw > img.w || c.y + c.ch > img.h
      ? Infinity
      : regionError(img, { x: c.x, y: c.y, w: c.cw, h: c.ch }, ref)
  let best = err(cur)
  for (let round = 0; round < 4; round++) {
    let moved = false
    for (const key of ['ch', 'cw', 'y', 'x'] as const) {
      for (let d = -reach; d <= reach; d++) {
        if (!d) continue
        const c = { ...cur, [key]: cur[key] + d }
        const e = err(c)
        if (e < best) {
          best = e
          cur = c
          moved = true
        }
      }
    }
    if (!moved) break
  }
  return cur
}

/**
 * Which region of frame `img` (of size class `k`) shows the same picture as
 * `ref` (the reference picture, bars already removed)? Returns null when the
 * fitted region isn't clearly better than the shape-based guess — e.g. a
 * featureless screen gives nothing to match.
 */
export interface Fit {
  region: Omit<Region, 'w' | 'h'>
  /** How well the region matches the reference picture (lower is better). */
  err: number
}

export function fitRegion(img: Gray, k: SizeClass, ref: Gray, fallback: Omit<Region, 'w' | 'h'>): Fit | null {
  const inner = crop(img, k.box)
  const fx = fitAxis(profile(inner, 'x'), profile(ref, 'x'))
  const fy = fitAxis(profile(inner, 'y'), profile(ref, 'y'))
  const fitted = refine(img, ref, { x: k.box.x + fx.start, y: k.box.y + fy.start, cw: fx.len, ch: fy.len })
  const eFit = regionError(img, { x: fitted.x, y: fitted.y, w: fitted.cw, h: fitted.ch }, ref)
  const eGuess = regionError(img, { x: fallback.x, y: fallback.y, w: fallback.cw, h: fallback.ch }, ref)
  return eFit < eGuess * 0.9 ? { region: fitted, err: eFit } : null
}

/**
 * Assemble the geometry. `fits` holds, per non-reference size, the regions
 * measured from one or more frame pairs (any may be null if unusable).
 */
/** The reference picture's box (bars removed) and the fallback shape. */
export function pictureShape(classes: SizeClass[]): {
  refBox: { x: number; y: number; w: number; h: number }
  aspect: number
  alignX: number
  alignY: number
} {
  const ref = referenceClass(classes)
  const refBox =
    ref.box.w >= ref.w - EDGE && ref.box.h >= ref.h - EDGE ? { x: 0, y: 0, w: ref.w, h: ref.h } : ref.box
  let ax = 0, axN = 0, ay = 0, ayN = 0
  for (const c of classes) {
    const spareX = c.w - c.box.w
    const spareY = c.h - c.box.h
    if (spareX > EDGE) { ax += (c.box.x / spareX) * c.n; axN += c.n }
    if (spareY > EDGE) { ay += (c.box.y / spareY) * c.n; ayN += c.n }
  }
  const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
  return {
    refBox,
    aspect: refBox.w / refBox.h,
    alignX: axN ? clamp01(ax / axN) : 0.5,
    alignY: ayN ? clamp01(ay / ayN) : 0.5
  }
}

/** The reference picture cut out of a frame of the reference size. */
export const referencePicture = (frame: Gray, refBox: { x: number; y: number; w: number; h: number }): Gray =>
  crop(frame, refBox)

export function buildGeometry(
  classes: SizeClass[],
  fits: Map<string, (Fit | null)[]>
): SourceGeometry | null {
  if (!classes.length) return null
  const ref = referenceClass(classes)
  const varies = classes.length > 1

  const { refBox, ...shape } = pictureShape(classes)

  const regions: Region[] = []
  if (varies) {
    regions.push({ w: ref.w, h: ref.h, x: refBox.x, y: refBox.y, cw: refBox.w, ch: refBox.h })
    for (const c of classes.slice(1)) {
      // The pair that matched best wins: a pair straddling a real change on
      // screen (a scroll) fits badly and must not drag the result.
      const measured = (fits.get(`${c.w}x${c.h}`) ?? []).filter((f): f is Fit => !!f)
      const r = measured.length
        ? measured.reduce((a, b) => (b.err < a.err ? b : a)).region
        : fallbackRegion(c.w, c.h, shape)
      regions.push({ w: c.w, h: c.h, ...r })
    }
  }

  return {
    width: even(refBox.w),
    height: even(refBox.h),
    regions,
    ...shape,
    varies
  }
}
