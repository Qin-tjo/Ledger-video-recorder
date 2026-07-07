import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useApp } from '../store'
import { Button, Panel, cn } from '../components/ui'
import { deleteClip, splitAt, totalDuration, trimClip } from '../lib/composite'
import { uid } from '../lib/uid'
import { usePlayback } from './usePlayback'
import { exportProject } from './export'
import Timeline from './Timeline'
import Inspector from './Inspector'

export default function Editor(): JSX.Element {
  const project = useApp((s) => s.project)
  const updateProject = useApp((s) => s.updateProject)
  const goRecorder = useApp((s) => s.goRecorder)
  const undo = useApp((s) => s.undo)
  const redo = useApp((s) => s.redo)
  const commit = useApp((s) => s.commit)
  const canUndo = useApp((s) => s.past.length > 0)
  const canRedo = useApp((s) => s.future.length > 0)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const screenRef = useRef<HTMLVideoElement>(null)
  const cameraRef = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)

  const refs = useMemo(
    () => ({
      get canvas() {
        return canvasRef.current
      },
      get screen() {
        return screenRef.current
      },
      get camera() {
        return cameraRef.current
      }
    }),
    []
  )

  const { playing, sourceTime, outputTime, toggle, seek } = usePlayback(project, refs)

  const [exporting, setExporting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [showExport, setShowExport] = useState(false)
  const [savedPath, setSavedPath] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [selectedZoom, setSelectedZoom] = useState<string | null>(null)
  const [selectedClip, setSelectedClip] = useState<string | null>(null)
  // When set, the next preview click places a zoom: 'new' creates one; a string
  // id re-aims that existing zoom's focus point.
  const [zoomArm, setZoomArm] = useState<null | 'new' | string>(null)

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)
        return
      if (!project) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        redo()
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        toggle()
      } else if (e.key === 'ArrowLeft') {
        seek(outputTime - (e.shiftKey ? 1 : 1 / 30))
      } else if (e.key === 'ArrowRight') {
        seek(outputTime + (e.shiftKey ? 1 : 1 / 30))
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        deleteSelected()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, outputTime, selectedClip, toggle, undo, redo])

  if (!project) return <div />

  const total = totalDuration(project)

  // Split the clip under the playhead into two.
  function splitHere(): void {
    updateProject((p) => {
      const res = splitAt(p, outputTime)
      p.clips = res.clips
      if (res.newId) setTimeout(() => setSelectedClip(res.newId), 0)
    })
  }

  // Delete the selected clip (ripple). No-op if nothing selected or only one clip.
  function deleteSelected(): void {
    if (!selectedClip || !project || project.clips.length <= 1) return
    updateProject((p) => (p.clips = deleteClip(p.clips, selectedClip)))
    setSelectedClip(null)
  }

  // Camera drag on the stage
  function onCameraDrag(e: React.MouseEvent): void {
    if (!project || !project.camera.enabled || !project.cameraSrc) return
    e.preventDefault()
    const stage = stageRef.current
    if (!stage) return
    // Half the bubble's footprint in normalized stage units, so it stays fully inside.
    const halfW = project.camera.size / (project.outputWidth / project.outputHeight) / 2
    const halfH = project.camera.size / 2
    const margin = 0.02
    const move = (ev: MouseEvent): void => {
      const rect = stage.getBoundingClientRect()
      let x = (ev.clientX - rect.left) / rect.width
      let y = (ev.clientY - rect.top) / rect.height
      // Magnetic corner snapping.
      const snap = 0.06
      const snapX = [halfW + margin, 1 - halfW - margin]
      const snapY = [halfH + margin, 1 - halfH - margin]
      let corner: typeof project.camera.corner = 'custom'
      const nx = snapX.find((s) => Math.abs(x - s) < snap)
      const ny = snapY.find((s) => Math.abs(y - s) < snap)
      if (nx !== undefined) x = nx
      if (ny !== undefined) y = ny
      if (nx !== undefined && ny !== undefined) {
        const left = nx === snapX[0]
        const top = ny === snapY[0]
        corner = `${top ? 't' : 'b'}${left ? 'l' : 'r'}` as typeof corner
      }
      updateProject(
        (p) => {
          p.camera.x = clamp(x, halfW + margin, 1 - halfW - margin)
          p.camera.y = clamp(y, halfH + margin, 1 - halfH - margin)
          p.camera.corner = corner
        },
        { coalesce: true }
      )
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // Clicking the preview while "armed" places a zoom: create a new punch-in at
  // the playhead, or re-aim an existing one's focus point.
  function onStageClick(e: React.MouseEvent): void {
    if (!zoomArm || !project) return
    const stage = stageRef.current
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    const fx = clamp((e.clientX - rect.left) / rect.width, 0, 1)
    const fy = clamp((e.clientY - rect.top) / rect.height, 0, 1)
    if (zoomArm === 'new') {
      const id = uid()
      const start = sourceTime
      const end = Math.min(sourceTime + 2, project.duration)
      updateProject((p) => {
        p.zooms.push({ id, start, end, scale: 1.8, focusX: fx, focusY: fy })
        p.zooms.sort((a, b) => a.start - b.start)
      })
      setSelectedZoom(id)
      // Move the playhead into the "hold" of the punch-in so the zoom shows now.
      if (end - start > 0.9) seek(outputTime + 0.7)
    } else {
      updateProject((p) => {
        const z = p.zooms.find((z) => z.id === zoomArm)
        if (z) {
          z.focusX = fx
          z.focusY = fy
        }
      })
    }
    setZoomArm(null)
  }

  const activeZoom =
    project.zooms.find(
      (z) => z.id === selectedZoom || (zoomArm !== null && zoomArm !== 'new' && z.id === zoomArm)
    ) || null

  async function handleExport(format: 'webm' | 'mp4'): Promise<void> {
    if (!screenRef.current) return
    setExporting(true)
    setProgress(0)
    setSavedPath(null)
    setExportError(null)
    try {
      const blob = await exportProject(project!, screenRef.current, cameraRef.current, {
        onProgress: setProgress
      })
      const buf = await blob.arrayBuffer()
      const suggested = `recording.${format}`
      const res = await window.ledger.export.save(buf, format, suggested)
      if (!res.canceled && res.filePath) setSavedPath(res.filePath)
    } catch (e) {
      console.error(e)
      setExportError(String(e))
    } finally {
      setExporting(false)
    }
  }

  const camSize = project.camera.size
  const aspect = project.outputWidth / project.outputHeight

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <header className="shrink-0 flex items-center justify-between px-6 py-3 border-b border-white/[0.06]">
        <Button variant="ghost" size="sm" onClick={goRecorder}>
          ← New recording
        </Button>
        <h1 className="text-sm font-medium text-white/60">Editor</h1>
        <Button variant="primary" size="sm" onClick={() => setShowExport(true)}>
          Export
        </Button>
      </header>

      <div className="flex-1 min-h-0 flex">
        {/* Main */}
        <div className="flex-1 min-w-0 flex flex-col p-6 gap-4">
          {/* Stage */}
          <div className="flex-1 min-h-0 grid place-items-center">
            <div
              ref={stageRef}
              onClick={onStageClick}
              className={cn(
                'relative max-h-full max-w-full rounded-2xl overflow-hidden shadow-soft bg-black',
                zoomArm && 'cursor-crosshair ring-2 ring-sky-400'
              )}
              style={{ aspectRatio: String(aspect), width: 'min(100%, calc((100vh - 320px) * ' + aspect + '))' }}
            >
              <canvas
                ref={canvasRef}
                width={project.outputWidth}
                height={project.outputHeight}
                className="w-full h-full block"
              />
              {zoomArm && (
                <div className="absolute inset-0 grid place-items-center bg-black/30 pointer-events-none">
                  <span className="text-sky-200 text-sm font-medium bg-black/60 px-3 py-1.5 rounded-lg">
                    {zoomArm === 'new'
                      ? 'Click the spot to zoom into'
                      : 'Click the new focus point'}
                  </span>
                </div>
              )}
              {/* Focus marker for the active zoom */}
              {activeZoom && (
                <div
                  className="absolute w-5 h-5 rounded-full border-2 border-sky-300 pointer-events-none"
                  style={{
                    left: `${activeZoom.focusX * 100}%`,
                    top: `${activeZoom.focusY * 100}%`,
                    transform: 'translate(-50%,-50%)',
                    boxShadow: '0 0 0 2px rgba(0,0,0,0.4)'
                  }}
                />
              )}
              {/* Camera drag handle overlay */}
              {project.camera.enabled && project.cameraSrc && (
                <div
                  onMouseDown={onCameraDrag}
                  role="button"
                  aria-label="Drag to reposition camera"
                  className={cn(
                    'absolute cursor-grab active:cursor-grabbing rounded-full ring-2 ring-white/0 hover:ring-accent/60 transition',
                    zoomArm && 'pointer-events-none'
                  )}
                  style={{
                    left: `${project.camera.x * 100}%`,
                    top: `${project.camera.y * 100}%`,
                    // size is a fraction of output HEIGHT; convert to stage-width fraction
                    width: `${(camSize / aspect) * 100}%`,
                    aspectRatio: '1',
                    transform: 'translate(-50%,-50%)'
                  }}
                  title="Drag to reposition camera"
                />
              )}
            </div>
          </div>

          {/* Transport */}
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="md"
              aria-label="Restart"
              onClick={() => seek(0)}
              className="w-11"
            >
              ⟲
            </Button>
            <Button variant="subtle" size="md" onClick={toggle} className="w-24">
              {playing ? 'Pause' : 'Play'}
            </Button>
            <span className="text-[13px] tabular-nums text-white/50 w-28">
              {fmt(outputTime)} / {fmt(total)}
            </span>
            <div className="flex-1" />
            <div className="hidden md:block text-[11px] text-white/35">
              Click a clip to select · Split at the playhead · drag a selected clip's ends to trim
            </div>
          </div>

          {/* Timeline */}
          <Timeline
            project={project}
            outputTime={outputTime}
            selectedClip={selectedClip}
            onSeek={seek}
            onSelectClip={setSelectedClip}
            onTrim={(id, side, sourceT, coalesce) =>
              updateProject((p) => (p.clips = trimClip(p.clips, id, side, sourceT, p.duration)), {
                coalesce
              })
            }
            onCommit={commit}
            onSelectZoom={(id) => setSelectedZoom(id)}
            selectedZoom={selectedZoom}
          />

          {/* Editing toolbar */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1 p-1 rounded-xl bg-white/[0.04] border border-white/[0.06]">
              <Button
                variant="ghost"
                size="sm"
                aria-label="Undo"
                title="Undo (⌘Z)"
                disabled={!canUndo}
                onClick={undo}
              >
                ↩ Undo
              </Button>
              <div className="w-px h-5 bg-white/10" />
              <Button
                variant="ghost"
                size="sm"
                aria-label="Redo"
                title="Redo (⇧⌘Z)"
                disabled={!canRedo}
                onClick={redo}
              >
                Redo ↪
              </Button>
            </div>

            <div className="flex items-center gap-2">
              <Button size="sm" variant="subtle" onClick={splitHere}>
                ✂ Split
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={!selectedClip || project.clips.length <= 1}
                onClick={deleteSelected}
              >
                🗑 Delete clip
              </Button>
            </div>
            <div className="w-[150px]" />
          </div>
        </div>

        {/* Inspector */}
        <aside className="w-[320px] shrink-0 border-l border-white/[0.06] overflow-y-auto p-5">
          <Inspector
            project={project}
            update={updateProject}
            selectedZoom={selectedZoom}
            onSelectZoom={setSelectedZoom}
            onAddZoom={() => setZoomArm('new')}
            onRefocusZoom={(id) => setZoomArm(id)}
          />
        </aside>
      </div>

      {/* Hidden media elements. preload=auto + a tiny seek on load forces the first
          frame to decode so the canvas isn't black/white before the user hits Play. */}
      <video
        ref={screenRef}
        src={project.screenSrc}
        className="hidden"
        preload="auto"
        playsInline
        onLoadedData={() => primeFrame(screenRef.current)}
      />
      {project.cameraSrc && (
        <video
          ref={cameraRef}
          src={project.cameraSrc}
          className="hidden"
          preload="auto"
          muted
          playsInline
          onLoadedData={() => primeFrame(cameraRef.current)}
        />
      )}

      {/* Export sheet */}
      <AnimatePresence>
        {showExport && (
          <motion.div
            className="absolute inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onMouseDown={() => !exporting && setShowExport(false)}
          >
            <motion.div
              onMouseDown={(e) => e.stopPropagation()}
              initial={{ scale: 0.94, y: 12 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.96, opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            >
              <Panel className="p-6 w-[400px]">
                <h2 className="text-lg font-semibold mb-1">Export recording</h2>
                <p className="text-sm text-white/45 mb-5">
                  {fmt(total)} · {project.outputWidth}×{project.outputHeight}
                </p>

                {exporting ? (
                  <div className="space-y-3">
                    <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                      <div
                        className="h-full bg-accent transition-[width]"
                        style={{ width: `${Math.round(progress * 100)}%` }}
                      />
                    </div>
                    <p className="text-[13px] text-white/50 text-center tabular-nums">
                      Rendering… {Math.round(progress * 100)}%
                    </p>
                  </div>
                ) : savedPath ? (
                  <div className="space-y-4">
                    <p className="text-sm text-emerald-300">Saved successfully.</p>
                    <div className="flex gap-2">
                      <Button
                        variant="subtle"
                        className="flex-1"
                        onClick={() => window.ledger.export.showItem(savedPath)}
                      >
                        Show in Finder
                      </Button>
                      <Button
                        variant="ghost"
                        className="flex-1"
                        onClick={() => setShowExport(false)}
                      >
                        Done
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {exportError && (
                      <p className="text-[13px] text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-xl px-3 py-2">
                        Export failed: {exportError}
                      </p>
                    )}
                    <Button
                      variant="primary"
                      className="w-full"
                      onClick={() => handleExport('mp4')}
                    >
                      Export as MP4
                    </Button>
                    <Button
                      variant="subtle"
                      className="w-full"
                      onClick={() => handleExport('webm')}
                    >
                      Export as WebM
                    </Button>
                    <p className="text-[11px] text-white/35 text-center pt-1">
                      Rendering runs in real time to preserve audio sync.
                    </p>
                  </div>
                )}
              </Panel>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

// Nudge currentTime so the decoder produces a frame the canvas can draw before play.
function primeFrame(v: HTMLVideoElement | null): void {
  if (!v) return
  if (v.currentTime < 0.02) v.currentTime = 0.04
}

function fmt(s: number): string {
  if (!isFinite(s)) s = 0
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}
