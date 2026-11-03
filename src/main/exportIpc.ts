import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import { createWriteStream, promises as fs, type WriteStream } from 'fs'
import { basename, dirname, join, resolve, sep } from 'path'
import {
  extractFramesJpeg,
  muxExport,
  probeMedia,
  validateOutput,
  type FrameShape
} from './ffmpeg'
import { analyzeSource } from './analyzeSource'

/**
 * Export pipeline, main-process side.
 *
 * The renderer composites and encodes; this side decodes source frames with
 * ffmpeg, receives the encoded H.264 as a stream (so a long export never sits
 * in memory), and muxes the final MP4 with audio cut straight from the source
 * file on disk.
 *
 * Kept separate from index.ts so the automated export test registers exactly
 * these handlers, not a copy of them.
 */

export interface FinishSpec {
  fps: number
  frames: number
  audio: { src: string; ranges: { start: number; end: number }[] } | null
}

export interface FinishResult {
  filePath: string
  audio: 'ok' | 'none' | 'failed'
  audioDetail?: string
}

export interface ExportDeps {
  recordingsRoot: () => string
  parentWindow: () => BrowserWindow | null
  /** Replaces the save dialog; used by the automated export test. */
  chooseSavePath?: (suggested: string) => Promise<string | null>
}

interface Stream {
  path: string
  fd: WriteStream
  error: Error | null
}

// These values are interpolated into an ffmpeg filter graph, so accept only
// plain in-range numbers from the renderer.
function num(v: unknown, lo: number, hi: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) {
    throw new Error('invalid export parameter')
  }
  return v
}
const int = (v: unknown, lo: number, hi: number): number => {
  const n = num(v, lo, hi)
  if (!Number.isInteger(n)) throw new Error('invalid export parameter')
  return n
}
function checkShape(v: unknown): FrameShape | null {
  if (v === null || v === undefined) return null
  const s = v as FrameShape
  let content: FrameShape['content'] = null
  if (s.content) {
    const regions = Array.isArray(s.content.regions) ? s.content.regions : []
    if (regions.length > MAX_REGIONS) throw new Error('invalid export parameter')
    content = {
      regions: regions.map((r) => ({
        w: int(r.w, 2, 16384),
        h: int(r.h, 2, 16384),
        x: int(r.x, 0, 16384),
        y: int(r.y, 0, 16384),
        cw: int(r.cw, 2, 16384),
        ch: int(r.ch, 2, 16384)
      })),
      aspect: num(s.content.aspect, 0.05, 20),
      alignX: num(s.content.alignX, 0, 1),
      alignY: num(s.content.alignY, 0, 1)
    }
  }
  let crop: FrameShape['crop'] = null
  if (s.crop) {
    crop = {
      x: num(s.crop.x, 0, 1),
      y: num(s.crop.y, 0, 1),
      w: num(s.crop.w, 0.001, 1),
      h: num(s.crop.h, 0.001, 1)
    }
    if (crop.x + crop.w > 1.000001 || crop.y + crop.h > 1.000001) {
      throw new Error('invalid export parameter')
    }
  }
  return {
    content,
    crop,
    width: int(s.width, 2, 16384),
    height: int(s.height, 2, 16384),
    quality: s.quality === undefined ? undefined : int(s.quality, 1, 31)
  }
}

/** Matches analyzeSource: frame sizes measured per recording. */
const MAX_REGIONS = 12

const TEMP_PREFIX = 'lvr-'
const STALE_MS = 6 * 60 * 60 * 1000

/** Remove temp files left behind by an export that was killed mid-way. */
async function sweepStaleTemp(): Promise<void> {
  const dir = app.getPath('temp')
  let names: string[] = []
  try {
    names = await fs.readdir(dir)
  } catch {
    return
  }
  const now = Date.now()
  for (const n of names) {
    if (!n.startsWith(TEMP_PREFIX)) continue
    const p = join(dir, n)
    try {
      const st = await fs.stat(p)
      if (st.isFile() && now - st.mtimeMs > STALE_MS) await fs.unlink(p)
    } catch {
      // gone already, or not ours to touch
    }
  }
}

export function registerExportHandlers(deps: ExportDeps): void {
  void sweepStaleTemp()

  /** Only ever read sources from inside the recordings folder. */
  const inRecordings = (p: string): string => {
    const root = resolve(deps.recordingsRoot())
    const r = resolve(p)
    if (r !== root && !r.startsWith(root + sep)) throw new Error('Invalid source path')
    return r
  }

  // The renderer may only write to a path the user picked in a save dialog.
  const approved = new Set<string>()
  const streams = new Map<string, Stream>()

  const pickWithDialog = async (suggested: string): Promise<string | null> => {
    const opts = {
      title: 'Save recording',
      defaultPath: suggested,
      filters: [{ name: 'MP4', extensions: ['mp4'] }]
    }
    const win = deps.parentWindow()
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    return r.canceled || !r.filePath ? null : r.filePath
  }

  ipcMain.handle('export:chooseSavePath', async (_e, suggested: string) => {
    let p = await (deps.chooseSavePath ?? pickWithDialog)(suggested)
    if (!p) return null
    if (!p.toLowerCase().endsWith('.mp4')) p += '.mp4'
    approved.add(p)
    return p
  })

  ipcMain.handle('export:probe', async (_e, src: string) => probeMedia(inRecordings(src)))

  /** Work out the recording's real picture (see sourceGeometry.ts). Samples a
   * few stretches so jitter that starts later in a long recording is seen. */
  ipcMain.handle('export:analyzeSource', async (_e, src: string) => analyzeSource(inRecordings(src)))

  ipcMain.handle(
    'export:extractFrames',
    async (_e, src: string, startSec: number, endSec: number, shape: unknown) => {
      const start = num(startSec, 0, 1e6)
      const end = num(endSec, start, start + 600)
      const r = await extractFramesJpeg(inRecordings(src), start, end, checkShape(shape))
      return { data: new Uint8Array(r.jpeg).buffer, pts: r.pts }
    }
  )

  ipcMain.handle('export:streamBegin', async () => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const path = join(app.getPath('temp'), `${TEMP_PREFIX}${id}.h264`)
    const s: Stream = { path, fd: createWriteStream(path), error: null }
    s.fd.on('error', (err) => {
      s.error = err
    })
    streams.set(id, s)
    return id
  })

  ipcMain.handle('export:streamWrite', async (_e, id: string, data: ArrayBuffer) => {
    const s = streams.get(id)
    if (!s) throw new Error('export stream is closed')
    if (s.error) throw new Error(`could not write temporary file: ${s.error.message}`)
    await new Promise<void>((res, rej) =>
      s.fd.write(Buffer.from(data), (err) => (err ? rej(err) : res()))
    )
  })

  const closeStream = (s: Stream): Promise<void> =>
    new Promise((res) => {
      if (s.fd.closed || s.fd.destroyed) res()
      else s.fd.end(() => res())
    })

  ipcMain.handle('export:streamAbort', async (_e, id: string) => {
    const s = streams.get(id)
    if (!s) return
    streams.delete(id)
    await closeStream(s)
    await fs.unlink(s.path).catch(() => {})
  })

  ipcMain.handle(
    'export:streamFinish',
    async (_e, id: string, spec: FinishSpec, outPath: string): Promise<FinishResult> => {
      const s = streams.get(id)
      if (!s) throw new Error('export stream is closed')
      streams.delete(id)
      await closeStream(s)

      // Write beside the destination, then rename: a failure can never leave
      // a broken file where the user expects their video.
      const partial = join(dirname(outPath), `.${basename(outPath)}.${TEMP_PREFIX}partial`)
      try {
        if (!approved.has(outPath)) throw new Error('output path was not chosen in the save dialog')
        if (s.error) throw new Error(`could not write temporary file: ${s.error.message}`)
        const expectedSec = spec.frames / spec.fps

        let audio: FinishResult['audio'] = 'none'
        let audioDetail: string | undefined
        const src = spec.audio ? inRecordings(spec.audio.src) : null
        const hasAudio = src ? (await probeMedia(src)).hasAudio : false

        if (src && hasAudio && spec.audio) {
          try {
            await muxExport(s.path, spec.fps, { src, ranges: spec.audio.ranges }, partial)
            await validateOutput(partial, expectedSec, spec.fps)
            audio = 'ok'
          } catch (e) {
            // Never lose the video over the audio: fall back to picture only
            // and tell the user exactly what went wrong.
            audio = 'failed'
            audioDetail = e instanceof Error ? e.message : String(e)
            console.error('audio mux failed, saving video only', e)
          }
        }
        if (audio !== 'ok') {
          await muxExport(s.path, spec.fps, null, partial)
          await validateOutput(partial, expectedSec, spec.fps)
        }

        await fs.rename(partial, outPath)
        approved.delete(outPath)
        return { filePath: outPath, audio, audioDetail }
      } catch (e) {
        await fs.unlink(partial).catch(() => {})
        throw e
      } finally {
        await fs.unlink(s.path).catch(() => {})
      }
    }
  )
}
