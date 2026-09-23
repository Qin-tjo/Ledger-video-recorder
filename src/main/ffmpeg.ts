import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { spawn } from 'child_process'

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
    const proc = spawn(ffmpegPath, args)
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
 * Decode `count` frames starting at `startSec`, resampled to `fps`, and return
 * them as concatenated JPEGs. Returns fewer frames (possibly none) when the
 * span runs past the end of the file — MediaRecorder output is often
 * truncated, so that is expected and handled by the caller.
 *
 * Why this exists: asking an HTMLVideoElement for one frame at a time costs
 * ~100ms per seek in Chromium regardless of codec (pipeline overhead, not
 * decode). Pulling frames from ffmpeg sequentially is far faster and returns
 * exactly the frames asked for.
 */
export async function extractFramesJpeg(
  src: string,
  startSec: number,
  count: number,
  fps: number,
  quality = 2
): Promise<Buffer> {
  // prettier-ignore
  const r = await run([
    '-v', 'error',
    '-ss', Math.max(0, startSec).toFixed(4),
    '-i', src,
    '-vf', `fps=${fps}`,
    '-frames:v', String(count),
    '-q:v', String(quality),
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-'
  ])
  if (r.code !== 0 && r.stdout.length === 0) {
    throw new Error(`frame extraction failed: ${tail(r.stderr)}`)
  }
  return r.stdout
}

export interface MediaInfo {
  hasVideo: boolean
  hasAudio: boolean
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
  return {
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
