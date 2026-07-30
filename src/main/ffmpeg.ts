import ffmpeg from 'fluent-ffmpeg'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'

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
