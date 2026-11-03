/**
 * Electron main process for the export test. Registers the app's real export
 * handlers — only the save dialog is replaced — then runs each case in a
 * hidden window through the app's real exporter.
 */
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { registerExportHandlers } from '../../src/main/exportIpc'
import { ffmpegPath, shapeFilters } from '../../src/main/ffmpeg'

interface Case {
  name: string
  outPath: string
  [k: string]: unknown
}

const dir = process.env.LVR_TEST_DIR
if (!dir) throw new Error('LVR_TEST_DIR is not set')
const cases: Case[] = JSON.parse(readFileSync(join(dir, 'cases.json'), 'utf8'))

let nextOut: string | null = null

app.whenReady().then(async () => {
  registerExportHandlers({
    recordingsRoot: () => join(dir, 'recordings'),
    parentWindow: () => null,
    chooseSavePath: async () => nextOut
  })

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false
    }
  })
  win.webContents.on('console-message', (e) => {
    if (e.level === 'warning' || e.level === 'error') console.log(`  [renderer] ${e.message}`)
  })
  await win.loadFile(join(__dirname, 'harness.html'))

  const results: unknown[] = []
  for (const c of cases) {
    nextOut = c.outPath
    const t0 = Date.now()
    process.stdout.write(`  exporting ${c.name}… `)
    try {
      const result = await win.webContents.executeJavaScript(
        `window.runCase(${JSON.stringify(c)})`,
        true
      )
      const ms = Date.now() - t0
      console.log(`${ms}ms`)
      results.push({ name: c.name, ok: true, result, ms })
      // Quality benchmark: a lossless render of exactly the frames the export
      // drew, through the app's own crop/scale filters, so a comparison
      // measures only what export loses (JPEG hand-over + H.264).
      const ref = c.reference as string | undefined
      if (c.makeReference && ref) {
        const g = result.source
        const shape = {
          content: g?.varies ? { regions: g.regions, aspect: g.aspect, alignX: g.alignX, alignY: g.alignY } : null,
          crop: null,
          width: result.outputWidth,
          height: result.outputHeight
        }
        const vf = [...shapeFilters(shape), 'fps=30'].join(',')
        const r = spawnSync(ffmpegPath, ['-nostdin', '-v', 'error', '-y', '-i', c.screenPath as string,
          '-vf', vf, '-frames:v', String(c.expectFrames), '-c:v', 'ffv1', '-an', ref])
        if (r.status !== 0) console.log(`  reference failed: ${r.stderr}`)
      }
    } catch (e) {
      const ms = Date.now() - t0
      console.log(`threw after ${ms}ms`)
      results.push({ name: c.name, ok: false, error: String(e), ms })
    }
  }
  writeFileSync(join(dir, 'results.json'), JSON.stringify(results, null, 2))
  app.exit(0)
})
