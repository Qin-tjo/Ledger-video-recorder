import { BrowserWindow, desktopCapturer, ipcMain, screen, session } from 'electron'
import { join } from 'path'

export interface CaptureSource {
  id: string
  name: string
  thumbnail: string
  type: 'screen' | 'window'
}

let bubbleWindow: BrowserWindow | null = null
let selectedSourceId: string | null = null

export function registerRecordingHandlers(): void {
  ipcMain.handle('sources:list', async (): Promise<CaptureSource[]> => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: false
    })
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.toDataURL(),
      type: s.id.startsWith('screen') ? 'screen' : 'window'
    }))
  })

  // The renderer tells us which source it wants just before calling getDisplayMedia.
  ipcMain.handle('sources:select', (_e, id: string) => {
    selectedSourceId = id
  })

  // getDisplayMedia uses ScreenCaptureKit on macOS, which honors setContentProtection
  // (so the floating camera bubble is never captured). Grant the chosen source.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen', 'window'] })
        .then((sources) => {
          const chosen = sources.find((s) => s.id === selectedSourceId) || sources[0]
          callback({ video: chosen })
        })
        .catch(() => callback({}))
    },
    { useSystemPicker: false }
  )
}

export function createBubbleWindow(
  _loadRenderer: (win: BrowserWindow, entry: 'index' | 'bubble') => void,
  deviceId: string
): void {
  if (bubbleWindow && !bubbleWindow.isDestroyed()) {
    bubbleWindow.show()
    return
  }

  const display = screen.getPrimaryDisplay()
  const size = 200
  const margin = 32

  bubbleWindow = new BrowserWindow({
    width: size,
    height: size,
    x: display.workArea.x + margin,
    y: display.workArea.y + display.workArea.height - size - margin,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: undefined,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  bubbleWindow.setAlwaysOnTop(true, 'screen-saver')
  bubbleWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Exclude the bubble from screen capture so it isn't baked into the screen
  // recording — the editor composites its own camera layer on top.
  bubbleWindow.setContentProtection(true)

  const query = `?device=${encodeURIComponent(deviceId)}`
  if (process.env['ELECTRON_RENDERER_URL']) {
    bubbleWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/bubble.html${query}`)
  } else {
    bubbleWindow.loadFile(join(__dirname, '../renderer/bubble.html'), {
      search: `device=${encodeURIComponent(deviceId)}`
    })
  }

  ipcMain.on('bubble:close', () => {
    if (bubbleWindow && !bubbleWindow.isDestroyed()) bubbleWindow.close()
    bubbleWindow = null
  })
}
