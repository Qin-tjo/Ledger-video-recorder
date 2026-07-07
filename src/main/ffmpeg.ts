import ffmpeg from 'fluent-ffmpeg'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'

// When packaged, the native binary is unpacked from the asar archive.
const ffmpegPath = ffmpegInstaller.path.replace('app.asar', 'app.asar.unpacked')
ffmpeg.setFfmpegPath(ffmpegPath)

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
