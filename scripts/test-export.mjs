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

console.log('Generating recordings…')
const screen = makeWebm('screen.webm', { w: 2940, h: 1678, seconds: 6, audio: true }) // Retina-sized
const screenMuted = makeWebm('screen-muted.webm', { w: 1920, h: 1080, seconds: 4, audio: false })
const camera = makeWebm('camera.webm', { w: 1280, h: 720, seconds: 4, audio: false }) // ends early

// ---- cases ----------------------------------------------------------------
const frames = (clips) => clips.reduce((n, [a, b]) => n + Math.max(1, Math.round((b - a) * FPS)), 0)
const base = { screenPath: screen, srcW: 2940, srcH: 1678, duration: 6, expectAudio: true }

const cases = [
  { ...base, name: 'full-frame', cameraPath: camera,
    expect: { w: 1892, h: 1080 } },
  { ...base, name: 'crop-1924x1080 (the reported bug)',
    crop: { x: 0.24, y: 0.175, w: 0.7587, h: 0.7461 }, size: { width: 1924, height: 1080 },
    expect: { w: 1924, h: 1080 } },
  { ...base, name: 'wide-2560x1080 (needs Level 5.0)',
    crop: { x: 0, y: 0.2, w: 1, h: 0.5 }, size: { width: 2560, height: 1080 },
    expect: { w: 2560, h: 1080 } },
  { ...base, name: 'wide-2560x834 (needs Level 4.2)',
    crop: { x: 0, y: 0.25, w: 1, h: 0.48 }, size: { width: 2560, height: 834 },
    expect: { w: 2560, h: 834 } },
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
    expect: { w: 1892, h: 1080 } }
]

// Optional: push a real recording through too, cropped to the size that used
// to fail. The file is linked, never modified.
const soakArg = process.argv.find((a) => a.startsWith('--soak='))
if (soakArg) {
  const spec = soakArg.slice('--soak='.length)
  const at = spec.lastIndexOf(':')
  const file = spec.slice(0, at)
  const seconds = Number(spec.slice(at + 1))
  if (!existsSync(file) || !(seconds > 0)) throw new Error('--soak needs <file>:<seconds>')
  const link = join(rec, 'soak.webm')
  symlinkSync(file, link)
  const head = ff(['-hide_banner', '-i', file]).err
  const [, w, h] = /Video: .*?, (\d+)x(\d+)/.exec(head)
  cases.push({ name: `soak: ${seconds}s real recording at 1924x1080`, screenPath: link,
    srcW: Number(w), srcH: Number(h), duration: seconds, expectAudio: /Audio:/.test(head),
    crop: { x: 0.24, y: 0.175, w: 0.7587, h: 0.7461 }, size: { width: 1924, height: 1080 },
    expect: { w: 1924, h: 1080 } })
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
  }
  const ok = problems.length === 0
  if (!ok) failed++
  console.log(`${ok ? '  ✓' : '  ✗'} ${c.name}${r ? `  (${(r.ms / 1000).toFixed(1)}s)` : ''}`)
  for (const p of problems) console.log(`      ${p}`)
}

const leftovers = readdirSafe(tmpdir()).filter((n) => /^lvr-\d/.test(n))
if (leftovers.length) { failed++; console.log(`  ✗ temp files left behind: ${leftovers.join(', ')}`) }

function readdirSafe(d) { try { return require('fs').readdirSync(d) } catch { return [] } }

console.log(`\n${allCases.length - failed}/${allCases.length} passed`)
if (!keep) { rmSync(work, { recursive: true, force: true }); rmSync(buildDir, { recursive: true, force: true }) }
else console.log(`kept: ${work}`)
process.exit(failed ? 1 : 0)
