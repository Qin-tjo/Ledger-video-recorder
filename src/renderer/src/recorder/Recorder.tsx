import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Button, Panel, Field, cn } from '../components/ui'
import { useApp } from '../store'
import { useCapture } from './useCapture'
import type { CaptureSource } from '../../../preload'

interface Device {
  deviceId: string
  label: string
}

export default function Recorder(): JSX.Element {
  const openEditor = useApp((s) => s.openEditor)
  const { status, countdown, elapsed, start, stop } = useCapture()

  const [sources, setSources] = useState<CaptureSource[]>([])
  const [sourceId, setSourceId] = useState<string>('')
  const [cameras, setCameras] = useState<Device[]>([])
  const [mics, setMics] = useState<Device[]>([])
  const [cameraId, setCameraId] = useState<string | null>(null)
  const [micId, setMicId] = useState<string | null>(null)
  const [screenPerm, setScreenPerm] = useState<string>('unknown')
  const [error, setError] = useState<string | null>(null)

  const previewRef = useRef<HTMLVideoElement>(null)
  const previewStream = useRef<MediaStream | null>(null)
  const audioMeter = useAudioMeter(micId)

  // Load sources + devices
  useEffect(() => {
    void refresh()
  }, [])

  async function refresh(): Promise<void> {
    try {
      const perm = await window.ledger.permissions.status()
      setScreenPerm(perm.screen)
      const list = await window.ledger.sources.list()
      setSources(list)
      if (!sourceId && list.length) setSourceId(list[0].id)

      // Prompt camera/mic access so labels populate
      await window.ledger.permissions.request('camera').catch(() => {})
      await window.ledger.permissions.request('microphone').catch(() => {})
      const devices = await navigator.mediaDevices.enumerateDevices()
      const cams = devices
        .filter((d) => d.kind === 'videoinput')
        .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Camera' }))
      const microphones = devices
        .filter((d) => d.kind === 'audioinput')
        .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Microphone' }))
      setCameras(cams)
      setMics(microphones)
      if (cameraId === null && cams.length) setCameraId(cams[0].deviceId)
      if (micId === null && microphones.length) setMicId(microphones[0].deviceId)
    } catch (e) {
      setError(String(e))
    }
  }

  // Live camera preview
  useEffect(() => {
    previewStream.current?.getTracks().forEach((t) => t.stop())
    previewStream.current = null
    if (!cameraId) {
      if (previewRef.current) previewRef.current.srcObject = null
      return
    }
    navigator.mediaDevices
      .getUserMedia({ video: { deviceId: { exact: cameraId } } })
      .then((s) => {
        previewStream.current = s
        if (previewRef.current) previewRef.current.srcObject = s
      })
      .catch(() => {})
    return () => {
      previewStream.current?.getTracks().forEach((t) => t.stop())
    }
  }, [cameraId])

  async function handleStart(): Promise<void> {
    if (!sourceId) return
    setError(null)
    // free preview so the device isn't locked
    previewStream.current?.getTracks().forEach((t) => t.stop())
    if (cameraId) await window.ledger.bubble.open(cameraId)
    try {
      const result = await start({
        sourceId,
        cameraDeviceId: cameraId,
        micDeviceId: micId
      })
      window.ledger.bubble.close()
      openEditor(result)
    } catch (e) {
      window.ledger.bubble.close()
      setError(humanizeError(String(e)))
    }
  }

  const recording = status === 'recording' || status === 'countdown'

  return (
    <div className="h-full overflow-y-auto px-8 py-6">
      <div className="max-w-5xl mx-auto">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">New recording</h1>
          <p className="text-white/45 text-sm mt-1">
            Capture your screen and camera, then polish it in the editor.
          </p>
        </header>

        {screenPerm === 'denied' && <ScreenPermWarning />}
        {error && (
          <div className="mb-6 text-sm text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-xl px-4 py-3">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-6">
          {/* Source picker */}
          <Panel className="p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-white/80">Screen or window</h2>
              <Button size="sm" variant="ghost" onClick={refresh}>
                Refresh
              </Button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 max-h-[360px] overflow-y-auto pr-1">
              {sources.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSourceId(s.id)}
                  className={cn(
                    'group relative rounded-xl overflow-hidden border text-left transition-all duration-150 ease-premium',
                    sourceId === s.id
                      ? 'border-accent shadow-glow'
                      : 'border-white/10 hover:border-white/25'
                  )}
                >
                  <img
                    src={s.thumbnail}
                    alt={s.name}
                    className="w-full aspect-video object-cover bg-black/40"
                  />
                  <div className="px-2.5 py-2 text-[11px] text-white/70 truncate bg-black/30">
                    {s.name}
                  </div>
                </button>
              ))}
              {sources.length === 0 && (
                <div className="col-span-full text-center text-white/40 text-sm py-10">
                  No sources found. Grant screen recording permission and refresh.
                </div>
              )}
            </div>
          </Panel>

          {/* Devices + camera preview */}
          <div className="space-y-6">
            <Panel className="p-5 space-y-4">
              <h2 className="text-sm font-semibold text-white/80">Camera & mic</h2>

              <div className="relative aspect-video rounded-xl overflow-hidden bg-black/50 border border-white/10">
                {cameraId ? (
                  <video
                    ref={previewRef}
                    autoPlay
                    muted
                    playsInline
                    className="w-full h-full object-cover"
                    style={{ transform: 'scaleX(-1)' }}
                  />
                ) : (
                  <div className="absolute inset-0 grid place-items-center text-white/30 text-xs">
                    Camera off
                  </div>
                )}
              </div>

              <Field label="Camera">
                <Select
                  value={cameraId ?? 'off'}
                  onChange={(v) => setCameraId(v === 'off' ? null : v)}
                  options={[
                    { value: 'off', label: 'No camera' },
                    ...cameras.map((c) => ({ value: c.deviceId, label: c.label }))
                  ]}
                />
              </Field>

              <Field label="Microphone">
                <Select
                  value={micId ?? 'off'}
                  onChange={(v) => setMicId(v === 'off' ? null : v)}
                  options={[
                    { value: 'off', label: 'No microphone' },
                    ...mics.map((m) => ({ value: m.deviceId, label: m.label }))
                  ]}
                />
                {micId && <AudioMeter level={audioMeter} />}
              </Field>
            </Panel>
          </div>
        </div>

        {/* Record bar */}
        <div className="mt-8 flex items-center justify-center">
          {!recording ? (
            <Button
              size="lg"
              variant="primary"
              onClick={handleStart}
              disabled={!sourceId || screenPerm === 'denied'}
              className="min-w-[220px]"
            >
              <span className="w-2.5 h-2.5 rounded-full bg-white" />
              Start recording
            </Button>
          ) : (
            <div className="flex items-center gap-4">
              {status === 'countdown' ? (
                <motion.div
                  key={countdown}
                  initial={{ scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  className="text-4xl font-semibold tabular-nums w-16 text-center"
                >
                  {countdown}
                </motion.div>
              ) : (
                <>
                  <div className="flex items-center gap-2 text-sm tabular-nums text-white/80">
                    <motion.span
                      className="w-2.5 h-2.5 rounded-full bg-rose-500"
                      animate={{ opacity: [1, 0.3, 1] }}
                      transition={{ repeat: Infinity, duration: 1.4 }}
                    />
                    {formatTime(elapsed)}
                  </div>
                  <Button size="lg" variant="danger" onClick={stop} className="min-w-[160px]">
                    Stop
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ScreenPermWarning(): JSX.Element {
  return (
    <div className="mb-6 flex items-center justify-between gap-4 text-sm text-amber-200 bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3">
      <span>Screen recording permission is required to capture your screen.</span>
      <Button
        size="sm"
        onClick={() => window.ledger.permissions.openSettings('screen')}
      >
        Open Settings
      </Button>
    </div>
  )
}

function Select({
  value,
  options,
  onChange
}: {
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}): JSX.Element {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="no-drag w-full h-10 rounded-xl bg-black/30 border border-white/10 px-3 text-sm text-white/90 focus:border-accent focus:outline-none"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-ink-700">
          {o.label}
        </option>
      ))}
    </select>
  )
}

function AudioMeter({ level }: { level: number }): JSX.Element {
  return (
    <div className="mt-2 h-1.5 rounded-full bg-white/10 overflow-hidden">
      <div
        className="h-full rounded-full bg-emerald-400 transition-[width] duration-75"
        style={{ width: `${Math.min(100, level * 140)}%` }}
      />
    </div>
  )
}

function useAudioMeter(micId: string | null): number {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    if (!micId) {
      setLevel(0)
      return
    }
    let raf = 0
    let ctx: AudioContext | null = null
    let stream: MediaStream | null = null
    navigator.mediaDevices
      .getUserMedia({ audio: { deviceId: { exact: micId } } })
      .then((s) => {
        stream = s
        ctx = new AudioContext()
        const src = ctx.createMediaStreamSource(s)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 512
        src.connect(analyser)
        const data = new Uint8Array(analyser.frequencyBinCount)
        const tick = (): void => {
          analyser.getByteTimeDomainData(data)
          let sum = 0
          for (const v of data) sum += (v - 128) * (v - 128)
          setLevel(Math.sqrt(sum / data.length) / 128)
          raf = requestAnimationFrame(tick)
        }
        tick()
      })
      .catch(() => {})
    return () => {
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
      ctx?.close().catch(() => {})
    }
  }, [micId])
  return level
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

function humanizeError(msg: string): string {
  if (msg.includes('Permission') || msg.includes('NotAllowed'))
    return 'Permission denied. Check camera, microphone, and screen recording access in System Settings.'
  return `Could not start recording: ${msg}`
}
