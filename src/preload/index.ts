import { contextBridge, ipcRenderer } from 'electron'

export interface CaptureSource {
  id: string
  name: string
  thumbnail: string
  type: 'screen' | 'window'
}

export interface FrameShape {
  crop: { x: number; y: number; w: number; h: number } | null
  width: number
  height: number
}

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
      ipcRenderer.invoke('recordings:saveTrack', dir, name, data),
    list: (): Promise<
      {
        id: string
        dir: string
        screenPath: string
        cameraPath: string | null
        size: number
        modified: number
      }[]
    > => ipcRenderer.invoke('recordings:list'),
    read: (filePath: string): Promise<ArrayBuffer> =>
      ipcRenderer.invoke('recordings:read', filePath),
    reveal: (): Promise<void> => ipcRenderer.invoke('recordings:reveal')
  },
  bubble: {
    open: (deviceId: string): Promise<void> => ipcRenderer.invoke('bubble:open', deviceId),
    close: (): void => ipcRenderer.send('bubble:close')
  },
  export: {
    /** Ask where to save *before* rendering, so a cancel or a bad location
     * never wastes a whole render. Returns null when cancelled. */
    chooseSavePath: (suggested: string): Promise<string | null> =>
      ipcRenderer.invoke('export:chooseSavePath', suggested),
    probe: (
      src: string
    ): Promise<{ hasVideo: boolean; hasAudio: boolean; width: number; height: number }> =>
      ipcRenderer.invoke('export:probe', src),
    extractFrames: (
      src: string,
      startSec: number,
      count: number,
      fps: number,
      shape: FrameShape | null
    ): Promise<ArrayBuffer> =>
      ipcRenderer.invoke('export:extractFrames', src, startSec, count, fps, shape),
    streamBegin: (): Promise<string> => ipcRenderer.invoke('export:streamBegin'),
    streamWrite: (id: string, data: ArrayBuffer): Promise<void> =>
      ipcRenderer.invoke('export:streamWrite', id, data),
    streamAbort: (id: string): Promise<void> => ipcRenderer.invoke('export:streamAbort', id),
    streamFinish: (id: string, spec: FinishSpec, outPath: string): Promise<FinishResult> =>
      ipcRenderer.invoke('export:streamFinish', id, spec, outPath),
    showItem: (filePath: string): Promise<void> => ipcRenderer.invoke('shell:showItem', filePath),
    keepAwake: (on: boolean): Promise<void> => ipcRenderer.invoke('power:keepAwake', on)
  }
}

contextBridge.exposeInMainWorld('ledger', api)

export type LedgerApi = typeof api
