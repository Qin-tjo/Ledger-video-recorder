import { contextBridge, ipcRenderer } from 'electron'

export interface CaptureSource {
  id: string
  name: string
  thumbnail: string
  type: 'screen' | 'window'
}

export type PermStatus = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'

const api = {
  permissions: {
    status: (): Promise<{ camera: PermStatus; microphone: PermStatus; screen: PermStatus }> =>
      ipcRenderer.invoke('permissions:status'),
    request: (media: 'camera' | 'microphone'): Promise<boolean> =>
      ipcRenderer.invoke('permissions:request', media),
    openSettings: (pane: 'screen' | 'camera' | 'microphone'): Promise<void> =>
      ipcRenderer.invoke('permissions:openSettings', pane)
  },
  sources: {
    list: (): Promise<CaptureSource[]> => ipcRenderer.invoke('sources:list'),
    select: (id: string): Promise<void> => ipcRenderer.invoke('sources:select', id)
  },
  recordings: {
    newSession: (): Promise<{ id: string; dir: string }> =>
      ipcRenderer.invoke('recordings:newSession'),
    saveTrack: (dir: string, name: string, data: ArrayBuffer): Promise<string> =>
      ipcRenderer.invoke('recordings:saveTrack', dir, name, data)
  },
  bubble: {
    open: (deviceId: string): Promise<void> => ipcRenderer.invoke('bubble:open', deviceId),
    close: (): void => ipcRenderer.send('bubble:close')
  },
  export: {
    save: (
      data: ArrayBuffer,
      format: 'webm' | 'mp4',
      suggested: string
    ): Promise<{ canceled: boolean; filePath?: string }> =>
      ipcRenderer.invoke('export:save', data, format, suggested),
    showItem: (filePath: string): Promise<void> => ipcRenderer.invoke('shell:showItem', filePath)
  }
}

contextBridge.exposeInMainWorld('ledger', api)

export type LedgerApi = typeof api
