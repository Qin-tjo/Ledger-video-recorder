#!/usr/bin/env node
/**
 * End-to-end export test.
 *
 * Generates recordings shaped like MediaRecorder's output (VP9/Opus WebM with
 * no duration in the header), exports them through the app's real exporter
 * and export handlers in a headless Electron, then checks every file with
 * ffmpeg independently of the app: dimensions, exact frame count, duration,
 * audio presence, and a clean full decode.
 *
 *   npm run test:export
 *   npm run test:export -- --soak=/path/to/screen.webm:476.2   (a real, long recording)
 *
 * Covers each way an export has failed before, so it can't quietly return.
 */
import { build } from 'esbuild'
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ffmpeg = require('@ffmpeg-installer/ffmpeg').path
const electron = require('electron')
const FPS = 30

const keep = process.argv.includes('--keep')
const work = mkdtempSync(join(tmpdir(), 'lvr-export-test-'))
const rec = join(work, 'recordings', 'session')
const outDir = join(work, 'out')
mkdirSync(rec, { recursive: true })
mkdirSync(outDir, { recursive: true })

function ff(args) {
  const r = spawnSync(ffmpeg, args, { encoding: 'utf8', maxBuffer: 1 << 28 })
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }
}

// ---- fixtures -------------------------------------------------------------
// -live 1 writes WebM the way MediaRecorder does: no duration, no cues.
function makeWebm(name, { w, h, seconds, audio }) {
  const file = join(rec, name)
  const args = ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=${FPS}:duration=${seconds}`]
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}:sample_rate=48000`)
  args.push('-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '3M', '-pix_fmt', 'yuv420p')
  if (audio) args.push('-c:a', 'libopus')
  args.push('-f', 'webm', '-live', '1', file)
  const r = ff(args)
  if (r.code !== 0) throw new Error(`fixture ${name} failed: ${r.err}`)
  return file
}

// ---- unit checks -----------------------------------------------------------
console.log('Unit checks:')
{
  const out = join(tmpdir(), `lvr-unit-${process.pid}.cjs`)
  await build({ bundle: true, logLevel: 'error', absWorkingDir: root, entryPoints: ['test/export/unit.ts'],
    outfile: out, platform: 'node', format: 'cjs' })
  const u = spawnSync(process.execPath, [out], { stdio: 'inherit' })
  rmSync(out, { force: true })
  if (u.status !== 0) process.exit(1)
}

console.log('\nGenerating recordings…')
const screen = makeWebm('screen.webm', { w: 2940, h: 1678, seconds: 6, audio: true }) // Retina-sized
const screenMuted = makeWebm('screen-muted.webm', { w: 1920, h: 1080, seconds: 4, audio: false })
const camera = makeWebm('camera.webm', { w: 1280, h: 720, seconds: 4, audio: false }) // ends early

// A window recording whose frame size jitters the way macOS delivered it in
// the wild: full 1920x1050, then the same picture shrunk to 1894x1036 with a
// 24px black bar on the left (1918x1036), then shrunk without the bar.
const JITTER_SRC = 'testsrc2=size=1920x1050:rate=30:duration=6'
function makeJittery() {
  const parts = [
    ['0', '1.5', ''],
    ['1.5', '3', ',scale=1894:1036,pad=1918:1036:24:0:black'],
    ['3', '4.5', ',scale=1894:1036'],
    ['4.5', '6', '']
  ].map(([a, b, vf], i) => {
    const f = join(work, `jitter-${i}.webm`)
    const r = ff(['-y', '-v', 'error', '-f', 'lavfi', '-i', `${JITTER_SRC},trim=start=${a}:end=${b},setpts=PTS-STARTPTS${vf}`,
      '-f', 'lavfi', '-i', `sine=frequency=330:duration=${b - a}:sample_rate=48000`,
      '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '3M', '-pix_fmt', 'yuv420p',
      '-c:a', 'libopus', '-f', 'webm', f])
    if (r.code !== 0) throw new Error(`jitter part failed: ${r.err}`)
    return f
  })
  const list = join(work, 'jitter.txt')
  writeFileSync(list, parts.map((f) => `file '${f}'`).join('\n'))
  const out = join(rec, 'screen-jitter.webm')
  const r = ff(['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-f', 'webm', '-live', '1', out])
  if (r.code !== 0) throw new Error(`jitter concat failed: ${r.err}`)
  return out
}
const jittery = makeJittery()

// A variable-frame-rate recording, like MediaRecorder makes of a still screen:
// stretches with no frames at all, one straddling the 4s chunk boundary.
// Video only, so frame n is stamped exactly n/30.
const VFR_SRC = 'testsrc2=size=1280x720:rate=30:duration=8'
const VFR_GAPS = [[1.0, 1.4], [3.8, 4.3], [5.5, 5.8]]
function makeVfr() {
  const out = join(rec, 'screen-vfr.webm')
  const drop = VFR_GAPS.map(([a, b]) => `between(t\\,${a}\\,${b - 0.001})`).join('+')
  const r = ff(['-y', '-v', 'error', '-f', 'lavfi', '-i', `${VFR_SRC},select='not(${drop})'`,
    '-vsync', 'vfr', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '3M',
    '-pix_fmt', 'yuv420p', '-f', 'webm', '-live', '1', out])
  if (r.code !== 0) throw new Error(`vfr fixture failed: ${r.err}`)
  return out
}
const vfr = makeVfr()

// ---- cases ----------------------------------------------------------------
const frames = (clips) => clips.reduce((n, [a, b]) => n + Math.max(1, Math.round((b - a) * FPS)), 0)
const base = { screenPath: screen, srcW: 2940, srcH: 1678, duration: 6, expectAudio: true }

const cases = [
  { ...base, name: 'full-frame', cameraPath: camera,
    expect: { w: 1892, h: 1080 } },
  { ...base, name: 'crop-1924x1080 (the reported bug)',
    crop: { x: 0.24, y: 0.175, w: 0.7587, h: 0.7461 }, size: { width: 1924, height: 1080 },
    expect: { w: 1924, h: 1080 }, geometry: [1.0, 4.5] },
  { ...base, name: 'wide-2560x1080 (needs Level 5.0)',
    crop: { x: 0, y: 0.2, w: 1, h: 0.5 }, size: { width: 2560, height: 1080 },
    expect: { w: 2560, h: 1080 } },
  { ...base, name: 'wide-2560x834 (needs Level 4.2)',
    crop: { x: 0, y: 0.25, w: 1, h: 0.48 }, size: { width: 2560, height: 834 },
    expect: { w: 2560, h: 834 }, geometry: [2.0] },
  { ...base, name: 'uncropped, picture check',
    expect: { w: 1892, h: 1080 }, geometry: [0.5, 3.0] },
  { ...base, name: 'odd-size 321x181 (rounded to even)',
    crop: { x: 0.4, y: 0.4, w: 0.11, h: 0.11 }, size: { width: 321, height: 181 },
    expect: { w: 320, h: 180 } },
  { ...base, name: 'cuts + zoom + padded gradient', cameraPath: camera,
    clips: [[0.5, 2.0], [3.0, 5.5]],
    zooms: [{ start: 3.2, end: 5.0, scale: 1.8, focusX: 0.3, focusY: 0.4 }],
    background: { mode: 'gradient', padding: 0.06, radius: 16 },
    expect: { w: 1892, h: 1080 } },
  { name: 'no microphone', screenPath: screenMuted, srcW: 1920, srcH: 1080, duration: 4,
    expectAudio: false, expect: { w: 1920, h: 1080 } },
  { ...base, name: 'clip past end of truncated file', clips: [[4.5, 7.2]],
    expect: { w: 1892, h: 1080 } },
  { ...base, name: 'camera shorter than screen', cameraPath: camera, clips: [[2.0, 6.0]],
    expect: { w: 1892, h: 1080 } },
  { ...base, name: 'software encoder', startWith: 'prefer-software',
    size: { width: 1924, height: 1080 }, crop: { x: 0.24, y: 0.175, w: 0.7587, h: 0.7461 },
    expect: { w: 1924, h: 1080, encoder: 'software' } },
  { ...base, name: 'hardware failure retries in software', injectFailAt: 40,
    expect: { w: 1892, h: 1080, encoder: 'software' } },
  { ...base, name: 'tiny clip', clips: [[1.0, 1.05]],
    expect: { w: 1892, h: 1080 } },
  { name: 'gaps in the recording hold the right frame', screenPath: vfr, srcW: 1280, srcH: 720, duration: 8,
    expectAudio: false, expect: { w: 1280, h: 720 },
    // Each output frame must show exactly the latest real frame at or before
    // its instant — inside gaps, across the chunk boundary at 4.0s, and after.
    frameCheck: { reference: VFR_SRC, gaps: VFR_GAPS, at: [15, 33, 41, 60, 116, 120, 127, 129, 130, 168, 195] } },
  { name: 'jittery window recording is steadied', screenPath: jittery, srcW: 1920, srcH: 1050, duration: 6,
    expectAudio: true, expect: { w: 1920, h: 1050 },
    // Frames from every size, compared with the clean original picture.
    // Compared at half size: the shrunk frames had to be enlarged back, which
    // softens fine detail; halving removes that softness but not a shift.
    // Measured: steadied 31.6-41.5 dB, the old shifting picture 23.1-25.7 dB.
    geometry: [1.0, 1.8, 2.2, 2.8, 3.3, 3.7, 4.2], reference: JITTER_SRC, compareScale: 0.5, minPsnr: 29 },
  { name: 'jittery recording, cropped', screenPath: jittery, srcW: 1920, srcH: 1050, duration: 6,
    expectAudio: true, crop: { x: 0.25, y: 0.2, w: 0.5, h: 0.5 }, expect: { w: 960, h: 524 },
    geometry: [1.0, 2.2, 3.7], reference: JITTER_SRC, compareScale: 0.5, minPsnr: 29 }
]

// Optional: push a real recording through too, cropped to the size that used
// to fail. The file is linked, never modified.
for (const soakArg of process.argv.filter((a) => a.startsWith('--soak=') || a.startsWith('--soak-plain='))) {
  const plain = soakArg.startsWith('--soak-plain=')
  const spec = soakArg.slice(soakArg.indexOf('=') + 1)
  const at = spec.lastIndexOf(':')
  const file = spec.slice(0, at)
  const seconds = Number(spec.slice(at + 1))
  if (!existsSync(file) || !(seconds > 0)) throw new Error('--soak needs <file>:<seconds>')
  const link = join(rec, plain ? 'soak-plain.webm' : 'soak.webm')
  symlinkSync(file, link)
  const head = ff(['-hide_banner', '-i', file]).err
  const [, w, h] = /Video: .*?, (\d+)x(\d+)/.exec(head)
  cases.push(plain
    ? { name: `soak: ${seconds}s real recording, as recorded`, screenPath: link,
        srcW: Number(w), srcH: Number(h), duration: seconds, expectAudio: /Audio:/.test(head),
        expect: { w: Number(process.env.SOAK_W ?? w), h: Number(process.env.SOAK_H ?? h) } }
    : { name: `soak: ${seconds}s real recording at 1924x1080`, screenPath: link,
        srcW: Number(w), srcH: Number(h), duration: seconds, expectAudio: /Audio:/.test(head),
        crop: { x: 0.24, y: 0.175, w: 0.7587, h: 0.7461 }, size: { width: 1924, height: 1080 },
        expect: { w: 1924, h: 1080 } })
}

// Quality benchmark on a real recording: one export per encoder setting, each
// compared with a lossless reference of the same frames.
const benchArg = process.argv.find((a) => a.startsWith('--bench='))
const bench = []
if (benchArg) {
  const spec = benchArg.slice('--bench='.length)
  const at = spec.lastIndexOf(':')
  const file = spec.slice(0, at)
  const seconds = Number(spec.slice(at + 1))
  const link = join(rec, `bench${file.slice(file.lastIndexOf('.'))}`)
  symlinkSync(file, link)
  const head = ff(['-hide_banner', '-i', file]).err
  const [, w, h] = /Video: .*?, (\d+)x(\d+)/.exec(head)
  // BENCH_SELF_REF: the input is already a clean, fixed-rate picture at the
  // output size, so compare against it directly.
  const selfRef = !!process.env.BENCH_SELF_REF
  const ref = selfRef ? link : join(work, 'bench-ref.mkv')
  const variants = JSON.parse(process.env.BENCH_VARIANTS ?? '[{}]')
  cases.length = 0 // benchmark only
  variants.forEach((encoding, n) => {
    const label = Object.keys(encoding).length ? Object.entries(encoding).map(([k, v]) => `${k}=${v}`).join(' ') : 'defaults'
    const c = { name: `bench ${label}`, screenPath: link, srcW: Number(w), srcH: Number(h), duration: seconds,
      expectAudio: /Audio:/.test(head), encoding, reference: ref, makeReference: !selfRef && n === 0, bench: true,
      expect: { w: Number(process.env.SOAK_W ?? w), h: Number(process.env.SOAK_H ?? h) } }
    cases.push(c)
    bench.push(c)
  })
}

const allCases = cases.map((c, i) => {
  const clips = c.clips ?? [[0, c.duration]]
  return { ...c, outPath: join(outDir, `case-${String(i + 1).padStart(2, '0')}.mp4`),
    expectFrames: frames(clips) }
})
writeFileSync(join(work, 'cases.json'), JSON.stringify(allCases, null, 2))

// ---- bundle & run ---------------------------------------------------------
console.log('Bundling…')
const buildDir = join(root, '.test-build')
rmSync(buildDir, { recursive: true, force: true })
const common = { bundle: true, logLevel: 'error', absWorkingDir: root }
await build({ ...common, entryPoints: ['test/export/harness-main.ts'], outfile: join(buildDir, 'harness-main.js'),
  platform: 'node', format: 'cjs', external: ['electron', '@ffmpeg-installer/ffmpeg'] })
await build({ ...common, entryPoints: ['src/preload/index.ts'], outfile: join(buildDir, 'preload.js'),
  platform: 'node', format: 'cjs', external: ['electron'] })
await build({ ...common, entryPoints: ['test/export/harness-renderer.ts'], outfile: join(buildDir, 'harness-renderer.js'),
  platform: 'browser', format: 'iife' })
copyFileSync(join(root, 'test/export/harness.html'), join(buildDir, 'harness.html'))

console.log(`Exporting ${allCases.length} cases…`)
const run = spawnSync(electron, [join(buildDir, 'harness-main.js')], {
  env: { ...process.env, LVR_TEST_DIR: work, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: 'inherit'
})
if (run.status !== 0 || !existsSync(join(work, 'results.json'))) {
  console.error(`\nElectron exited with ${run.status}; no results.`)
  process.exit(1)
}
const results = JSON.parse(readFileSync(join(work, 'results.json'), 'utf8'))

// ---- verify, independently of the app --------------------------------------
function inspect(file) {
  const head = ff(['-hide_banner', '-i', file]).err
  const v = /Stream #\d+:\d+.*?: Video: (\w+).*?, (\d+)x(\d+)/.exec(head)
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(head)
  const packets = ff(['-v', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'framecrc', '-'])
    .out.split('\n').filter((l) => l && !l.startsWith('#')).length
  const decode = ff(['-v', 'error', '-i', file, '-f', 'null', '-']).err.trim()
  return {
    codec: v?.[1], w: Number(v?.[2]), h: Number(v?.[3]),
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : NaN,
    audio: /Stream #\d+:\d+.*?: Audio: aac/.test(head),
    frames: packets, decodeErrors: decode
  }
}

/**
 * Compare exported frames with an independent ffmpeg crop + cover-fit of the
 * source at the same instant (cover-fit, centred, is how the compositor fills
 * the frame). A wrong crop offset or scale shows up as a
 * collapse in PSNR long before it would be obvious by eye.
 */
const MIN_PSNR = 30
function pictureCheck(c) {
  const [W, H] = [c.expect.w, c.expect.h]
  let crop = ''
  if (c.crop) {
    // srcW/srcH are the real picture's size (for a jittery fixture, the clean original).
    const x = Math.min(c.srcW - 2, Math.max(0, Math.round(c.crop.x * c.srcW)))
    const y = Math.min(c.srcH - 2, Math.max(0, Math.round(c.crop.y * c.srcH)))
    const w = Math.max(2, Math.min(c.srcW - x, Math.round(c.crop.w * c.srcW)))
    const h = Math.max(2, Math.min(c.srcH - y, Math.round(c.crop.h * c.srcH)))
    crop = `crop=${w}:${h}:${x}:${y},`
  }
  const problems = []
  const grab = (input, filter, out) =>
    ff(['-nostdin', '-v', 'error', ...input, '-vf', filter, '-vsync', '0', '-frames:v', '1', '-y', out])
  const compare = (a, b) => {
    const r = ff(['-nostdin', '-hide_banner', '-i', a, '-i', b,
      '-lavfi', '[0:v]format=yuv420p[o];[1:v]format=yuv420p[ref];[o][ref]psnr', '-f', 'null', '-'])
    const m = /PSNR .*?average:([\d.]+|inf)/.exec(r.err)
    return m ? (m[1] === 'inf' ? Infinity : Number(m[1])) : NaN
  }
  for (const t of c.geometry) {
    const a = join(work, 'psnr-out.png')
    const b = join(work, 'psnr-ref.png')
    let psnr
    if (c.reference) {
      // Against the clean original, by frame number. A source whose frames
      // are stamped a few ms off the 30fps grid is sampled one frame either
      // side at a given instant (that sampling by time is what keeps sound in
      // sync), so accept the best of k-1..k+1 — a picture that is shifted or
      // scaled wrong matches none of them.
      const k = Math.round(t * FPS)
      const half = c.compareScale ? `,scale=iw*${c.compareScale}:ih*${c.compareScale}:flags=area` : ''
      grab(['-i', c.outPath], `select=eq(n\\,${k})${half}`, a)
      psnr = -Infinity
      for (const j of [k - 1, k, k + 1]) {
        grab(['-f', 'lavfi', '-i', c.reference],
          `select=eq(n\\,${j}),${crop}scale=${W}:${H}:flags=bicubic:force_original_aspect_ratio=increase,crop=${W}:${H}${half}`, b)
        psnr = Math.max(psnr, compare(a, b))
      }
    } else {
      // Extract each frame on its own, then compare: seeking two inputs inside
      // one filter graph can pair frames from different instants.
      ff(['-nostdin', '-v', 'error', '-ss', String(t), '-i', c.outPath, '-frames:v', '1', '-y', a])
      ff(['-nostdin', '-v', 'error', '-ss', String(t), '-i', c.screenPath, '-vf',
        `${crop}scale=${W}:${H}:flags=bicubic:force_original_aspect_ratio=increase,crop=${W}:${H}`, '-frames:v', '1', '-y', b])
      psnr = compare(a, b)
    }
    const min = c.minPsnr ?? MIN_PSNR
    if (!(psnr >= min)) problems.push(`picture at ${t}s differs from the source (PSNR ${psnr.toFixed(1)} dB, want ≥ ${min})`)
    else c.psnr = [...(c.psnr ?? []), psnr]
  }
  return problems
}

/**
 * Strict timing check: output frame k must be source frame j, the latest frame
 * the source actually has at or before k/30. The right frame scores ~40 dB
 * against the clean original; its neighbours on a moving test pattern ~25.
 */
function frameCheck(c) {
  const { reference, gaps, at } = c.frameCheck
  const inGap = (n) => gaps.some(([a, b]) => n / FPS >= a - 1e-9 && n / FPS < b - 1e-9)
  const problems = []
  const scores = []
  const grab = (input, filter, out) =>
    ff(['-nostdin', '-v', 'error', ...input, '-vf', filter, '-vsync', '0', '-frames:v', '1', '-y', out])
  const psnrOf = (x, y) => {
    const r = ff(['-nostdin', '-hide_banner', '-i', x, '-i', y,
      '-lavfi', '[0:v]format=yuv420p[o];[1:v]format=yuv420p[r];[o][r]psnr', '-f', 'null', '-'])
    const m = /average:([\d.]+|inf)/.exec(r.err)
    return m ? (m[1] === 'inf' ? 99 : Number(m[1])) : NaN
  }
  for (const k of at) {
    let j = k
    while (j > 0 && inGap(j)) j--
    const a = join(work, 'fc-out.png')
    grab(['-i', c.outPath], `select=eq(n\\,${k})`, a)
    const score = (n) => {
      const b = join(work, 'fc-ref.png')
      grab(['-f', 'lavfi', '-i', reference], `select=eq(n\\,${n})`, b)
      return psnrOf(a, b)
    }
    const right = score(j)
    const others = [j - 1, j + 1, k].filter((n) => n !== j && n >= 0 && !inGap(n)).map(score)
    scores.push(right)
    if (!(right >= 32) || others.some((o) => o >= right)) {
      problems.push(`frame ${k} (${(k / FPS).toFixed(2)}s) should show source frame ${j}: ${right.toFixed(1)} dB vs neighbours ${others.map((o) => o.toFixed(1)).join('/')}`)
    }
  }
  if (!problems.length) c.psnr = [Math.min(...scores)]
  return problems
}

console.log('\nVerifying with ffmpeg:\n')
let failed = 0
for (const c of allCases) {
  const r = results.find((x) => x.name === c.name)
  const problems = []
  if (!r?.ok) problems.push(`export threw: ${r?.error}`)
  else if (!existsSync(c.outPath)) problems.push('no output file')
  else {
    const m = inspect(c.outPath)
    if (m.codec !== 'h264') problems.push(`codec ${m.codec}`)
    if (m.w !== c.expect.w || m.h !== c.expect.h) problems.push(`size ${m.w}x${m.h}, want ${c.expect.w}x${c.expect.h}`)
    if (m.frames !== c.expectFrames) problems.push(`${m.frames} frames, want ${c.expectFrames}`)
    const want = c.expectFrames / FPS
    if (!(Math.abs(m.duration - want) <= Math.max(0.1, 2 / FPS))) problems.push(`duration ${m.duration}s, want ${want.toFixed(3)}s`)
    if (m.audio !== c.expectAudio) problems.push(c.expectAudio ? 'audio missing' : 'unexpected audio')
    if (c.expectAudio && r.result.audio !== 'ok') problems.push(`audio reported ${r.result.audio}: ${r.result.audioDetail}`)
    if (m.decodeErrors) problems.push(`decode errors: ${m.decodeErrors.slice(0, 200)}`)
    if (c.expect.encoder && r.result.encoder !== c.expect.encoder) problems.push(`encoder ${r.result.encoder}, want ${c.expect.encoder}`)
    if (existsSync(join(dirname(c.outPath), `.${c.outPath.split('/').pop()}.lvr-partial`))) problems.push('left a partial file')
    if (c.geometry) problems.push(...pictureCheck(c))
    if (c.frameCheck) problems.push(...frameCheck(c))
  }
  const ok = problems.length === 0
  if (!ok) failed++
  const psnr = c.psnr ? `  picture ${Math.min(...c.psnr).toFixed(1)} dB` : ''
  console.log(`${ok ? '  ✓' : '  ✗'} ${c.name}${r ? `  (${(r.ms / 1000).toFixed(1)}s)` : ''}${psnr}`)
  for (const p of problems) console.log(`      ${p}`)
  const tm = r?.result?.timings
  if (tm && (process.argv.includes('--timings') || tm.total > 10000)) {
    const f = (k) => `${k} ${(tm[k] / 1000).toFixed(1)}s`
    const fps = (c.expectFrames / (tm.total / 1000)).toFixed(0)
    console.log(`      ${fps} fps · ${['waitFrames', 'draw', 'encode', 'backpressure', 'finish'].map(f).join(' · ')}`)
  }
}

if (bench.length) {
  console.log('\nQuality vs lossless reference (higher is better):\n')
  console.log('  setting                                   PSNR avg  worst 1%    SSIM    size   speed')
  for (const c of allCases.filter((x) => x.bench)) {
    const r = results.find((x) => x.name === c.name)
    if (!r?.ok) { console.log(`  ${c.name}: failed`); continue }
    const stats = join(work, 'psnr.log')
    const q = ff(['-nostdin', '-hide_banner', '-i', c.outPath, '-i', c.reference, '-lavfi',
      // Pair frames by number (setpts=N), not by timestamp: the reference
      // may carry irregular timestamps, which would pair the wrong frames.
      `[0:v]setpts=N/(30*TB),format=yuv420p[a];[1:v]setpts=N/(30*TB),format=yuv420p[b];[a]split[a1][a2];[b]split[b1][b2];[a1][b1]psnr=stats_file=${stats};[a2][b2]ssim`,
      '-f', 'null', '-'])
    const per = readFileSync(stats, 'utf8').split('\n').map((l) => /psnr_avg:([\d.]+|inf)/.exec(l)).filter(Boolean)
      .map((m) => (m[1] === 'inf' ? 99 : Number(m[1]))).sort((a, b) => a - b)
    const avg = per.reduce((a, b) => a + b, 0) / per.length
    const worst = per[Math.floor(per.length * 0.01)]
    const ssim = /SSIM .*?All:([\d.]+)/.exec(q.err)?.[1]
    const mb = (require('fs').statSync(c.outPath).size / 1e6).toFixed(1)
    const fps = (c.expectFrames / (r.ms / 1000)).toFixed(0)
    console.log(`  ${c.name.padEnd(40)} ${avg.toFixed(2).padStart(7)} dB ${worst.toFixed(1).padStart(6)} dB  ${ssim}  ${mb.padStart(5)}MB  ${fps.padStart(3)} fps`)
  }
}

const leftovers = readdirSafe(tmpdir()).filter((n) => /^lvr-\d/.test(n))
if (leftovers.length) { failed++; console.log(`  ✗ temp files left behind: ${leftovers.join(', ')}`) }

function readdirSafe(d) { try { return require('fs').readdirSync(d) } catch { return [] } }

console.log(`\n${allCases.length - failed}/${allCases.length} passed`)
if (!keep) { rmSync(work, { recursive: true, force: true }); rmSync(buildDir, { recursive: true, force: true }) }
else console.log(`kept: ${work}`)
process.exit(failed ? 1 : 0)
