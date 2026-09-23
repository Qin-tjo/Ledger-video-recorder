import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  systemPreferences,
  dialog,
  powerSaveBlocker
} from 'electron'
import { join, basename, resolve, sep } from 'path'
import { promises as fs } from 'fs'
import * as fs2 from 'fs'
import { registerRecordingHandlers, createBubbleWindow } from './recording'
import { extractFramesJpeg, muxToMp4, transcodeToMp4 } from './ffmpeg'

let mainWindow: BrowserWindow | null = null

function loadRenderer(win: BrowserWindow, entry: 'index' | 'bubble'): void {
  if (process.env['ELECTRON_RENDERER_URL']) {
    const suffix = entry === 'index' ? '' : `${entry}.html`
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/${suffix}`)
  } else {
    win.loadFile(join(__dirname, `../renderer/${entry}.html`))
  }
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0c10',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // Export composites frames on a timer in the renderer. Chromium normally
      // throttles timers and rAF once a window isn't frontmost, which froze the
      // picture whenever the user switched apps mid-export. Keep us running.
      backgroundThrottling: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  loadRenderer(mainWindow, 'index')
}

// App-wide navigation hardening: the app only ever loads its own local content,
// so block navigation to any external origin and never open in-app child windows
// (hand off safe web links to the OS browser instead). Applies to every window.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    const isLocal = url.startsWith('file://') || (!!devUrl && url.startsWith(devUrl))
    if (!isLocal) event.preventDefault()
  })
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
})

// ---- Permissions ----
ipcMain.handle('permissions:status', async () => {
  if (process.platform !== 'darwin') {
    return { camera: 'granted', microphone: 'granted', screen: 'granted' }
  }
  return {
    camera: systemPreferences.getMediaAccessStatus('camera'),
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
    screen: systemPreferences.getMediaAccessStatus('screen')
  }
})

ipcMain.handle('permissions:request', async (_e, media: 'camera' | 'microphone') => {
  if (process.platform !== 'darwin') return true
  return systemPreferences.askForMediaAccess(media)
})

ipcMain.handle('permissions:openSettings', async (_e, pane: string) => {
  const url =
    pane === 'screen'
      ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
      : pane === 'camera'
        ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera'
        : 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
  await shell.openExternal(url)
})

// ---- File persistence for recordings ----
function recordingsRoot(): string {
  return join(app.getPath('userData'), 'recordings')
}

ipcMain.handle('recordings:newSession', async () => {
  const id = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = join(recordingsRoot(), id)
  await fs.mkdir(dir, { recursive: true })
  return { id, dir }
})

ipcMain.handle(
  'recordings:saveTrack',
  async (_e, dir: string, name: string, data: ArrayBuffer) => {
    // Confine writes to the recordings directory; ignore any path components in
    // `name` and reject a `dir` that escapes the root (defense-in-depth).
    const root = resolve(recordingsRoot())
    const filePath = resolve(join(dir, basename(name)))
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      throw new Error('Invalid recording path')
    }
    await fs.mkdir(resolve(dir), { recursive: true })
    await fs.writeFile(filePath, Buffer.from(data))
    return filePath
  }
)

/** Past sessions on disk, newest first, so a recording is never stranded. */
ipcMain.handle('recordings:list', async () => {
  const root = recordingsRoot()
  let entries: string[] = []
  try {
    entries = await fs.readdir(root)
  } catch {
    return []
  }
  const out: {
    id: string
    dir: string
    screenPath: string
    cameraPath: string | null
    size: number
    modified: number
  }[] = []
  for (const id of entries) {
    const dir = join(root, id)
    const screenPath = join(dir, 'screen.webm')
    try {
      const st = await fs.stat(screenPath)
      if (!st.isFile() || st.size === 0) continue
      let cameraPath: string | null = join(dir, 'camera.webm')
      try {
        await fs.access(cameraPath)
      } catch {
        cameraPath = null
      }
      out.push({
        id,
        dir,
        screenPath,
        cameraPath,
        size: st.size,
        modified: st.mtimeMs
      })
    } catch {
      // not a session dir
    }
  }
  out.sort((a, b) => b.modified - a.modified)
  return out
})

ipcMain.handle('recordings:read', async (_e, filePath: string) => {
  // Only ever read back from inside the recordings folder.
  const root = resolve(recordingsRoot())
  const p = resolve(filePath)
  if (p !== root && !p.startsWith(root + sep)) throw new Error('Invalid path')
  const buf = await fs.readFile(p)
  return new Uint8Array(buf).buffer
})

ipcMain.handle('recordings:reveal', async () => {
  const root = recordingsRoot()
  await fs.mkdir(root, { recursive: true })
  shell.openPath(root)
})

// ---- Export ----
ipcMain.handle(
  'export:save',
  async (_e, data: ArrayBuffer, format: 'webm' | 'mp4', suggested: string) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow!, {
      title: 'Save recording',
      defaultPath: suggested,
      filters: [{ name: format.toUpperCase(), extensions: [format] }]
    })
    if (canceled || !filePath) return { canceled: true }

    if (format === 'mp4') {
      const tmp = join(app.getPath('temp'), `ledger-export-${Date.now()}.webm`)
      await fs.writeFile(tmp, Buffer.from(data))
      await transcodeToMp4(tmp, filePath)
      await fs.unlink(tmp).catch(() => {})
    } else {
      await fs.writeFile(filePath, Buffer.from(data))
    }
    return { canceled: false, filePath }
  }
)

// ---- Offline export pipeline ----
// Frames come from ffmpeg (fast, deterministic) and encoded video is streamed
// straight to a temp file, so a long export never has to hold the whole H.264
// stream in renderer memory — that was exhausting memory and killing the codec.

ipcMain.handle(
  'export:extractFrames',
  async (_e, src: string, startSec: number, count: number, fps: number) => {
    const root = resolve(recordingsRoot())
    const p = resolve(src)
    if (p !== root && !p.startsWith(root + sep)) throw new Error('Invalid source path')
    const buf = await extractFramesJpeg(p, startSec, count, fps)
    return new Uint8Array(buf).buffer
  }
)

const streams = new Map<string, { path: string; fd: fs2.WriteStream }>()

ipcMain.handle('export:streamBegin', async () => {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const path = join(app.getPath('temp'), `lvr-${id}.h264`)
  streams.set(id, { path, fd: fs2.createWriteStream(path) })
  return id
})

ipcMain.handle('export:streamWrite', async (_e, id: string, data: ArrayBuffer) => {
  const s = streams.get(id)
  if (!s) throw new Error('no such export stream')
  await new Promise<void>((res, rej) =>
    s.fd.write(Buffer.from(data), (err) => (err ? rej(err) : res()))
  )
})

ipcMain.handle('export:streamAbort', async (_e, id: string) => {
  const s = streams.get(id)
  if (!s) return
  streams.delete(id)
  await new Promise<void>((res) => s.fd.end(() => res()))
  await fs.unlink(s.path).catch(() => {})
})

ipcMain.handle(
  'export:streamFinish',
  async (_e, id: string, wav: ArrayBuffer | null, fps: number, suggested: string) => {
    const s = streams.get(id)
    if (!s) throw new Error('no such export stream')
    streams.delete(id)
    await new Promise<void>((res) => s.fd.end(() => res()))

    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow!, {
      title: 'Save recording',
      defaultPath: suggested,
      filters: [{ name: 'MP4', extensions: ['mp4'] }]
    })
    if (canceled || !filePath) {
      await fs.unlink(s.path).catch(() => {})
      return { canceled: true }
    }

    const aPath = wav ? join(app.getPath('temp'), `lvr-${id}.wav`) : null
    try {
      if (aPath && wav) await fs.writeFile(aPath, Buffer.from(wav))
      await muxToMp4(s.path, aPath, fps, filePath)
    } finally {
      await fs.unlink(s.path).catch(() => {})
      if (aPath) await fs.unlink(aPath).catch(() => {})
    }
    return { canceled: false, filePath }
  }
)

/** Save a frame-exact render: mux the H.264 + WAV the renderer produced. */
ipcMain.handle(
  'export:saveRendered',
  async (_e, h264: ArrayBuffer, wav: ArrayBuffer | null, fps: number, suggested: string) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow!, {
      title: 'Save recording',
      defaultPath: suggested,
      filters: [{ name: 'MP4', extensions: ['mp4'] }]
    })
    if (canceled || !filePath) return { canceled: true }

    const stamp = Date.now()
    const vPath = join(app.getPath('temp'), `lvr-${stamp}.h264`)
    const aPath = wav ? join(app.getPath('temp'), `lvr-${stamp}.wav`) : null
    try {
      await fs.writeFile(vPath, Buffer.from(h264))
      if (aPath && wav) await fs.writeFile(aPath, Buffer.from(wav))
      await muxToMp4(vPath, aPath, fps, filePath)
    } finally {
      await fs.unlink(vPath).catch(() => {})
      if (aPath) await fs.unlink(aPath).catch(() => {})
    }
    return { canceled: false, filePath }
  }
)

ipcMain.handle('shell:showItem', async (_e, filePath: string) => {
  shell.showItemInFolder(filePath)
})

// ---- Keep the machine awake while exporting ----
// Export renders in real time; if the display sleeps the compositing stalls and
// the output freezes. Hold a blocker for the duration.
let exportBlockerId: number | null = null
ipcMain.handle('power:keepAwake', async (_e, on: boolean) => {
  if (on) {
    if (exportBlockerId === null) {
      exportBlockerId = powerSaveBlocker.start('prevent-display-sleep')
    }
  } else if (exportBlockerId !== null) {
    if (powerSaveBlocker.isStarted(exportBlockerId)) powerSaveBlocker.stop(exportBlockerId)
    exportBlockerId = null
  }
})

// ---- Camera bubble window ----
ipcMain.handle('bubble:open', async (_e, deviceId: string) => {
  createBubbleWindow(loadRenderer, deviceId)
})

app.whenReady().then(() => {
  registerRecordingHandlers()
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
