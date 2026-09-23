import ffmpeg from 'fluent-ffmpeg'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { spawn } from 'child_process'

// When packaged, the native binary is unpacked from the asar archive.
const ffmpegPath = ffmpegInstaller.path.replace('app.asar', 'app.asar.unpacked')
ffmpeg.setFfmpegPath(ffmpegPath)

/**
 * Mux an elementary H.264 stream (Annex B, from the offline renderer) with an
 * optional WAV track into a playable MP4. The video is copied — it was already
 * encoded frame-exact — so nothing here can reintroduce timing drift.
 */
export function muxToMp4(
  h264Path: string,
  wavPath: string | null,
  fps: number,
  output: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(h264Path)
      .inputOptions(['-f', 'h264', '-r', String(fps)])

    if (wavPath) cmd.input(wavPath)

    const outOpts = ['-c:v copy', '-movflags +faststart', '-video_track_timescale', '90000']
    if (wavPath) outOpts.push('-c:a', 'aac', '-b:a', '192k', '-shortest')

    cmd
      .outputOptions(outOpts)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .save(output)
  })
}

export function transcodeToMp4(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .outputOptions([
        '-c:v libx264',
        '-preset veryfast',
        '-crf 20',
        '-pix_fmt yuv420p',
        '-movflags +faststart',
        '-c:a aac',
        '-b:a 192k'
      ])
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .save(output)
  })
}

/**
 * Decode `count` frames starting at `startSec`, resampled to `fps`, and return
 * them as concatenated JPEGs.
 *
 * Why this exists: asking an HTMLVideoElement for one frame at a time costs
 * ~100ms per seek in Chromium regardless of codec (it's pipeline overhead, not
 * decode — ffmpeg decodes the same source at ~1000fps). Pulling frames from
 * ffmpeg sequentially is orders of magnitude faster and, unlike anything driven
 * by the browser's clock, returns exactly the frames we asked for.
 */
export function extractFramesJpeg(
  src: string,
  startSec: number,
  count: number,
  fps: number,
  quality = 2
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-ss', startSec.toFixed(4),
      '-i', src,
      '-vf', `fps=${fps}`,
      '-frames:v', String(count),
      '-q:v', String(quality),
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-'
    ]
    const proc = spawn(ffmpegPath, args)
    const out: Buffer[] = []
    const err: Buffer[] = []
    proc.stdout.on('data', (d: Buffer) => out.push(d))
    proc.stderr.on('data', (d: Buffer) => err.push(d))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0 && out.length === 0) {
        reject(new Error(`frame extraction failed: ${Buffer.concat(err).toString().slice(0, 400)}`))
        return
      }
      resolve(Buffer.concat(out))
    })
  })
}
