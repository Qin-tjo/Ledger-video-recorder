import { app, shell, BrowserWindow, ipcMain, systemPreferences, dialog } from 'electron'
import { join, basename, resolve, sep } from 'path'
import { promises as fs } from 'fs'
import { registerRecordingHandlers, createBubbleWindow } from './recording'
import { transcodeToMp4 } from './ffmpeg'

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
      webSecurity: true
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

ipcMain.handle('shell:showItem', async (_e, filePath: string) => {
  shell.showItemInFolder(filePath)
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
