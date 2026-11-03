/**
 * Unit checks for source-geometry detection and the matching preview math.
 * Run by scripts/test-export.mjs before the end-to-end exports.
 */
import {
  buildGeometry,
  fallbackRegion,
  fitRegion,
  nearestPairs,
  pictureShape,
  referencePicture,
  sizeClasses,
  type FrameSample,
  type Gray
} from '../../src/main/sourceGeometry'
import { contentRect } from '../../src/renderer/src/lib/composite'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  — ${detail}`}`)
  if (!ok) failed++
}
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol
const rep = (n: number, t0: number, s: Omit<FrameSample, 't'>): FrameSample[] =>
  Array.from({ length: n }, (_, i) => ({ ...s, t: t0 + i / 30 }))

// The four frame types measured in a real jittery window recording.
const real: FrameSample[] = [
  ...rep(206, 0, { w: 1920, h: 1050, box: { x: 0, y: 0, w: 1920, h: 1050 } }),
  ...rep(11, 7.3, { w: 1920, h: 1036, box: { x: 24, y: 0, w: 1896, h: 1036 } }),
  ...rep(1343, 8, { w: 1918, h: 1036, box: { x: 24, y: 0, w: 1894, h: 1036 } }),
  ...rep(11, 60, { w: 1894, h: 1036, box: { x: 0, y: 0, w: 1894, h: 1036 } })
]
const classes = sizeClasses(real)
check('real jitter: most common size is the reference', classes[0].w === 1918 && classes[0].h === 1036)
const shape = pictureShape(classes)
check('real jitter: reference picture excludes the 24px bar', shape.refBox.x === 24 && shape.refBox.w === 1894)
check('real jitter: bars are on the left', near(shape.alignX, 1, 0.05), String(shape.alignX))
const g = buildGeometry(classes, new Map())!
check('real jitter: varies, steady picture 1894x1036', g.varies && g.width === 1894 && g.height === 1036, `${g.width}x${g.height}`)
const refR = contentRect(1918, 1036, g)
check('real jitter: reference frame maps to its picture', refR.x === 24 && refR.w === 1894 && refR.h === 1036, JSON.stringify(refR))

// Measured regions win over the shape rule (the 1920x1050 frames carry extra
// rows at the bottom, so the shape rule alone is wrong for them).
// Two pairs: one straddling a scroll (poor match), one clean. The clean one wins.
const measured = new Map([['1920x1050', [
  { region: { x: 0, y: 0, cw: 1917, ch: 1049 }, err: 900 },
  { region: { x: 0, y: 0, cw: 1917, ch: 1044 }, err: 120 },
  null
]]])
const g2 = buildGeometry(classes, measured)!
const full = contentRect(1920, 1050, g2)
check('best-matching measured region used for 1920x1050', full.w === 1917 && full.h === 1044, JSON.stringify(full))
check('unmeasured size falls back to shape rule', JSON.stringify(contentRect(1894, 1036, g2)) === JSON.stringify(contentRect(1894, 1036, g)))
check('unseen size handled', contentRect(1700, 930, g2).w > 0)

// Pairing picks frames close in time, from different moments.
const k1920 = classes.find((c) => c.w === 1920 && c.h === 1036)!
const pairs = nearestPairs(k1920, classes[0], 6)
check('frame pairs are moments apart', pairs.length >= 1 && pairs.every(([a, b]) => Math.abs(a - b) < 1))
const between = nearestPairs(
  { w: 1920, h: 1050, n: 1, times: [1.5], box: { x: 0, y: 0, w: 1920, h: 1050 } },
  { w: 1918, h: 1036, n: 4, times: [0, 1, 2, 3], box: { x: 24, y: 0, w: 1894, h: 1036 } }
)
check('pairs look both before and after', JSON.stringify(between) === JSON.stringify([[1.5, 1], [1.5, 2]]), JSON.stringify(between))

// A stable recording is never touched, even if its edges look black.
const dark = buildGeometry(sizeClasses(rep(500, 0, { w: 2940, h: 1678, box: { x: 60, y: 0, w: 2880, h: 1678 } })), new Map())!
check('stable dark recording: not normalised', !dark.varies)
const id = contentRect(2940, 1678, dark)
check('stable dark recording: picture is the whole frame', id.x === 0 && id.w === 2940 && id.h === 1678)
check('no geometry: identity', contentRect(800, 600, null).w === 800)

// fitRegion recovers a known mapping: make a textured reference picture, then
// a "frame" holding it stretched into a known region with a black bar.
function synth(w: number, h: number, f: (x: number, y: number) => number): Gray {
  const d = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = Math.max(0, Math.min(255, f(x, y)))
  return { w, h, data: d }
}
const tex = (x: number, y: number): number =>
  128 + 60 * Math.sin(x / 23) + 40 * Math.cos(y / 17) + 30 * Math.sin((x + 2 * y) / 41) + (((x >> 5) + (y >> 5)) % 2) * 20
const RW = 600, RH = 330
const ref = synth(RW, RH, tex)
// Frame: 20px black bar on the left, then the picture's region shown at 610x340
// (i.e. the frame holds a slightly larger, offset view): picture pixel (u,v)
// sits at frame (20 + u*590/600, v*334/330), and extra rows below.
const FW = 612, FH = 346
const frame = synth(FW, FH, (x, y) => (x < 20 ? 0 : tex(((x - 20) * 600) / 590, (y * 330) / 334)))
const k = { w: FW, h: FH, n: 1, times: [0], box: { x: 20, y: 0, w: FW - 20, h: FH } }
const fit = fitRegion(frame, k, referencePicture(ref, { x: 0, y: 0, w: RW, h: RH }), fallbackRegion(FW, FH, { aspect: RW / RH, alignX: 1, alignY: 0.5 }))
const fr = fit?.region
check('fitRegion recovers a known region', !!fr && near(fr.x, 20, 2) && near(fr.cw, 590, 3) && near(fr.y, 0, 2) && near(fr.ch, 334, 3), JSON.stringify(fit))
// A featureless frame gives nothing to match: fall back rather than guess.
const flat = synth(FW, FH, () => 200)
const none = fitRegion(flat, k, referencePicture(synth(RW, RH, () => 200), { x: 0, y: 0, w: RW, h: RH }), fallbackRegion(FW, FH, { aspect: RW / RH, alignX: 1, alignY: 0.5 }))
check('featureless frame: no fitted region (uses shape rule)', none === null, JSON.stringify(none))

if (failed) {
  console.log(`\n${failed} unit check(s) failed`)
  process.exit(1)
}
