import { create } from 'zustand'
import { defaultProject, type Project } from './lib/types'
import { makeClips } from './lib/composite'

export interface Recording {
  screenSrc: string
  cameraSrc: string | null
  duration: number
}

interface AppState {
  view: 'recorder' | 'editor'
  project: Project | null
  past: Project[]
  future: Project[]
  _lastPush: number

  goRecorder: () => void
  openEditor: (rec: Recording) => void
  updateProject: (fn: (p: Project) => void, opts?: { coalesce?: boolean }) => void
  commit: () => void
  undo: () => void
  redo: () => void
}

const HISTORY_LIMIT = 60

export const useApp = create<AppState>((set) => ({
  view: 'recorder',
  project: null,
  past: [],
  future: [],
  _lastPush: 0,

  goRecorder: () => set({ view: 'recorder' }),

  openEditor: (rec) =>
    set(() => {
      const p = defaultProject()
      p.screenSrc = rec.screenSrc
      p.cameraSrc = rec.cameraSrc
      p.camera.enabled = !!rec.cameraSrc
      p.duration = rec.duration
      p.clips = makeClips(rec.duration)
      return { view: 'editor', project: p, past: [], future: [], _lastPush: 0 }
    }),

  // Every edit goes through here. Rapid consecutive edits (e.g. a slider drag)
  // within a short window collapse into a single undo step.
  updateProject: (fn, opts) =>
    set((s) => {
      if (!s.project) return s
      const next = structuredClone(s.project)
      fn(next)
      const now = Date.now()
      const coalesce = opts?.coalesce && now - s._lastPush < 600
      return {
        project: next,
        past: coalesce ? s.past : [...s.past, s.project].slice(-HISTORY_LIMIT),
        future: [],
        _lastPush: now
      }
    }),

  // End a drag's coalescing window so the next edit starts a fresh undo step.
  commit: () => set({ _lastPush: 0 }),

  undo: () =>
    set((s) => {
      if (!s.project || s.past.length === 0) return s
      const previous = s.past[s.past.length - 1]
      return {
        project: previous,
        past: s.past.slice(0, -1),
        future: [s.project, ...s.future].slice(0, HISTORY_LIMIT),
        _lastPush: 0
      }
    }),

  redo: () =>
    set((s) => {
      if (!s.project || s.future.length === 0) return s
      const nextProj = s.future[0]
      return {
        project: nextProj,
        past: [...s.past, s.project].slice(-HISTORY_LIMIT),
        future: s.future.slice(1),
        _lastPush: 0
      }
    })
}))
