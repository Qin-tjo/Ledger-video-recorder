import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { spawn } from 'child_process'
import type { FrameSample, Gray, Region } from './sourceGeometry'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// When packaged, the native binary is unpacked from the asar archive.
export const ffmpegPath = ffmpegInstaller.path.replace('app.asar', 'app.asar.unpacked')

interface RunResult {
  code: number
  stdout: Buffer
  stderr: string
}

/** Run ffmpeg to completion, collecting its output. Never rejects on a
 * non-zero exit — callers decide what counts as failure. */
function run(args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // stdin closed: ffmpeg otherwise reads it for interactive commands.
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    proc.stdout.on('data', (d: Buffer) => out.push(d))
    proc.stderr.on('data', (d: Buffer) => err.push(d))
    proc.on('error', reject)
    proc.on('close', (code) =>
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() })
    )
  })
}

const tail = (s: string, n = 400): string => s.trim().slice(-n)

/**
 * How to shape frames before they reach the renderer. Doing this in ffmpeg,
 * before JPEG encoding, is the single biggest export speedup (a Retina frame
 * bound for 1080p is ~2.4x more pixels than needed) — and it's where frames
 * of a jittery recording are normalised back to one steady picture.
 */
export interface FrameShape {
  /** Normalise a recording whose frame size varies: crop each frame to the
   * region holding the steady picture, looked up by frame size (ffmpeg
   * re-evaluates this whenever the size changes); sizes not in the table get
   * the largest region of `aspect` placed by align. */
  content: { regions: Region[]; aspect: number; alignX: number; alignY: number } | null
  /** User crop, as fractions of the (normalised) picture. */
  crop: { x: number; y: number; w: number; h: number } | null
  /** Final frame size. */
  width: number
  height: number
  /** JPEG quality for the hand-over (ffmpeg -q:v, 1 = best). */
  quality?: number
}

/** ffmpeg filters for a shape. Expressions are single-quoted so their commas
 * aren't read as filter separators. */
export function shapeFilters(shape: FrameShape): string[] {
  const f: string[] = []
  const n = (v: number): string => v.toFixed(6)
  if (shape.content) {
    const { regions, aspect: a, alignX, alignY } = shape.content
    // if(size is W1xH1, v1, if(size is W2xH2, v2, ... fallback))
    const pick = (key: 'x' | 'y' | 'cw' | 'ch', fallback: string): string =>
      regions.reduceRight(
        (rest, r) => `if(eq(iw,${r.w})*eq(ih,${r.h}),${r[key]},${rest})`,
        fallback
      )
    const fw = `min(iw,ih*${n(a)})`
    const fh = `min(ih,iw/${n(a)})`
    f.push(
      `crop=w='${pick('cw', fw)}':h='${pick('ch', fh)}'` +
        `:x='${pick('x', `(iw-ow)*${n(alignX)}`)}':y='${pick('y', `(ih-oh)*${n(alignY)}`)}'`
    )
  }
  if (shape.crop) {
    const c = shape.crop
    f.push(`crop=w='iw*${n(c.w)}':h='ih*${n(c.h)}':x='iw*${n(c.x)}':y='ih*${n(c.y)}'`)
  }
  f.push(`scale=${shape.width}:${shape.height}:flags=${SCALE_FLAGS}`)
  return f
}

/** Downscaling filter for frames headed to the encoder. */
export const SCALE_FLAGS = 'bicubic'

export interface DecodedFrames {
  /** Concatenated JPEGs, one per source frame, in order. */
  jpeg: Buffer
  /** Each frame's timestamp, in seconds from the start of the recording. */
  pts: number[]
}

/**
 * Every real source frame in [startSec, endSec), shaped to `shape`, as
 * concatenated JPEGs with their exact timestamps.
 *
 * No frame-rate conversion happens here, deliberately. Screen recordings are
 * variable-rate — MediaRecorder skips frames while the screen is still (one
 * 18-minute recording averaged 19 fps with 655 gaps over 0.3s) — and ffmpeg's
 * fps filter, run per chunk, started each chunk at its first real frame
 * instead of holding the previous one, shifting whole chunks late; it also
 * restarts (dropping or duplicating frames) whenever the frame size changes.
 * The renderer instead picks, for each output instant, the latest real frame
 * at or before it.
 *
 * Why ffmpeg at all: asking an HTMLVideoElement for one frame at a time costs
 * ~100ms per seek in Chromium; decoding sequentially here is far faster.
 */
export async function extractFramesJpeg(
  src: string,
  startSec: number,
  endSec: number,
  shape: FrameShape | null
): Promise<DecodedFrames> {
  const quality = shape?.quality ?? 2
  // trim ends the window. ffmpeg's -t does not: on MediaRecorder WebM,
  // "-ss 240 -t 15" decoded 155 seconds. trim ends the filter chain at the
  // window's end, so ffmpeg stops decoding there (0.56s instead of 3.8s).
  // showinfo logs each frame's timestamp as it leaves the chain, so the n-th
  // log line belongs to the n-th JPEG (checksum=0: no per-frame hashing).
  const vf = [
    `trim=end=${endSec.toFixed(4)}`,
    ...(shape ? shapeFilters(shape) : []),
    'showinfo=checksum=0'
  ]
  // prettier-ignore
  const r = await run([
    '-nostdin', '-hide_banner', '-loglevel', 'info',
    // -copyts: keep the recording's own timestamps.
    '-copyts',
    '-ss', Math.max(0, startSec).toFixed(4),
    '-i', src,
    '-an',
    '-vf', vf.join(','),
    // One output frame per source frame: never duplicate or drop.
    '-vsync', 'passthrough',
    '-q:v', String(quality),
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-'
  ])
  const pts = [...r.stderr.matchAll(/Parsed_showinfo_\d+.*?\bn:\s*\d+.*?\bpts_time:(-?[\d.]+)/g)].map((m) => Number(m[1]))
  if (r.code !== 0 && r.stdout.length === 0) {
    throw new Error(`frame extraction failed: ${tail(r.stderr)}`)
  }
  return { jpeg: r.stdout, pts }
}

/**
 * Sample frame sizes and their non-black content boxes from a few stretches of
 * a recording, for working out its real picture (see sourceGeometry.ts).
 */
export async function sampleFrameBoxes(
  src: string,
  startsSec: number[],
  spanSec: number
): Promise<FrameSample[]> {
  const passes = startsSec.map(async (start) => {
    // prettier-ignore
    const r = await run([
      '-nostdin', '-hide_banner',
      // -copyts: timestamps stay absolute, so a sampled frame can be found again.
      '-copyts',
      '-ss', start.toFixed(3),
      '-i', src,
      '-an',
      // trim, not -t, ends the window (see extractFramesJpeg).
      '-vf', `trim=end=${(start + spanSec).toFixed(3)},showinfo=checksum=0,cropdetect=limit=24:round=2:skip=0:reset=1,metadata=print`,
      '-f', 'null', '-'
    ])
    const out: FrameSample[] = []
    let size: { w: number; h: number; t: number } | null = null
    let box: Partial<FrameSample['box']> = {}
    for (const line of r.stderr.split('\n')) {
      const si = /\bn:\s*\d+.*?\bpts_time:([\d.]+).*?\bs:(\d+)x(\d+)/.exec(line)
      if (si) {
        size = { t: Number(si[1]), w: Number(si[2]), h: Number(si[3]) }
        box = {}
        continue
      }
      const m = /lavfi\.cropdetect\.(w|h|x|y)=(\d+)/.exec(line)
      if (m && size) {
        box[m[1] as 'w' | 'h' | 'x' | 'y'] = Number(m[2])
        if (box.w !== undefined && box.h !== undefined && box.x !== undefined && box.y !== undefined) {
          out.push({ w: size.w, h: size.h, t: size.t, box: box as FrameSample['box'] })
          box = {}
        }
      }
    }
    return out
  })
  return (await Promise.all(passes)).flat()
}

export interface MediaInfo {
  hasVideo: boolean
  hasAudio: boolean
  /** Coded size of the first video stream; 0 when there is none. */
  width: number
  height: number
  /** null when the container doesn't record one (e.g. MediaRecorder WebM). */
  duration: number | null
}

/** Read stream layout and duration from the container header. */
export async function probeMedia(src: string): Promise<MediaInfo> {
  // With no output ffmpeg exits non-zero after printing the input summary,
  // which is all we want here.
  const r = await run(['-hide_banner', '-i', src])
  const s = r.stderr
  if (/No such file|Invalid data found/i.test(s)) {
    throw new Error(`cannot read ${src}: ${tail(s, 200)}`)
  }
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s)
  const v = /Stream #\d+:\d+.*?: Video: .*?, (\d{2,5})x(\d{2,5})/.exec(s)
  return {
    width: v ? Number(v[1]) : 0,
    height: v ? Number(v[2]) : 0,
    hasVideo: /Stream #\d+:\d+.*?: Video:/.test(s),
    hasAudio: /Stream #\d+:\d+.*?: Audio:/.test(s),
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null
  }
}

export interface AudioSpec {
  /** File to take audio from (the screen recording carries the mic). */
  src: string
  /** Source ranges to keep, in output order — the same cuts as the video. */
  ranges: { start: number; end: number }[]
}

/**
 * Mux the encoded H.264 elementary stream with audio cut to the same clip
 * ranges. The video is stream-copied, so nothing here can alter its timing.
 * Audio is padded to the video's length, so a mic track that ends early can
 * never truncate the picture.
 */
export async function muxExport(
  h264Path: string,
  fps: number,
  audio: AudioSpec | null,
  output: string
): Promise<void> {
  const args = ['-y', '-v', 'error', '-f', 'h264', '-r', String(fps), '-i', h264Path]

  if (audio && audio.ranges.length) {
    args.push('-i', audio.src)
    const parts = audio.ranges.map(
      (r, i) =>
        `[1:a]atrim=start=${r.start.toFixed(4)}:end=${r.end.toFixed(4)},asetpts=PTS-STARTPTS[a${i}]`
    )
    const labels = audio.ranges.map((_, i) => `[a${i}]`).join('')
    const joined =
      audio.ranges.length === 1
        ? `[a0]apad[aout]`
        : `${labels}concat=n=${audio.ranges.length}:v=0:a=1,apad[aout]`
    args.push(
      '-filter_complex', `${parts.join(';')};${joined}`,
      '-map', '0:v',
      '-map', '[aout]',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest'
    )
  } else {
    args.push('-map', '0:v')
  }

  // prettier-ignore
  args.push(
    '-c:v', 'copy',
    '-movflags', '+faststart',
    '-video_track_timescale', '90000',
    '-f', 'mp4',
    output
  )

  const r = await run(args)
  if (r.code !== 0) throw new Error(`could not write the MP4: ${tail(r.stderr)}`)
}

/** Refuse to hand back a file that is missing its picture or is the wrong length. */
export async function validateOutput(
  file: string,
  expectedSec: number,
  fps: number
): Promise<void> {
  const info = await probeMedia(file)
  if (!info.hasVideo) throw new Error('the exported file has no video stream')
  if (info.duration === null) throw new Error('the exported file has no duration')
  const tolerance = Math.max(0.25, 2 / fps)
  if (Math.abs(info.duration - expectedSec) > tolerance) {
    throw new Error(
      `the exported file is ${info.duration.toFixed(2)}s long but should be ${expectedSec.toFixed(2)}s`
    )
  }
}

/**
 * One frame at its true size, as grayscale. A frame is copied out of the file
 * undecoded and decoded on its own: decoding in place lets ffmpeg rescale it
 * to match the frames around it, which is exactly what must be avoided here.
 * Returns null unless the frame really is `w`x`h`.
 */
export async function grabGray(src: string, t: number, w: number, h: number): Promise<Gray | null> {
  const tmp = join(tmpdir(), `lvr-frame-${process.pid}-${Math.random().toString(36).slice(2)}.webm`)
  try {
    // prettier-ignore
    const cut = await run([
      '-nostdin', '-v', 'error', '-ss', (t + 0.001).toFixed(4), '-i', src,
      '-map', '0:v:0', '-frames:v', '1', '-c', 'copy', '-f', 'webm', '-y', tmp
    ])
    if (cut.code !== 0) return null
    // prettier-ignore
    const r = await run([
      '-nostdin', '-v', 'error', '-i', tmp,
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'
    ])
    if (r.code !== 0 || r.stdout.length !== w * h) return null
    return { w, h, data: new Uint8Array(r.stdout) }
  } finally {
    await fs.unlink(tmp).catch(() => {})
  }
}
