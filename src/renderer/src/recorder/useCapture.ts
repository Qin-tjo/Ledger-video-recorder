import { useCallback, useRef, useState } from 'react'

interface CaptureConfig {
  sourceId: string
  cameraDeviceId: string | null
  micDeviceId: string | null
}

interface CaptureResult {
  screenSrc: string
  cameraSrc: string | null
  duration: number
}

async function getScreenStream(sourceId: string, mic: MediaStreamTrack | null): Promise<MediaStream> {
  // Tell the main process which source to grant, then capture via getDisplayMedia.
  // getDisplayMedia (ScreenCaptureKit on macOS) honors setContentProtection, so the
  // floating camera bubble is excluded from the recording.
  await window.ledger.sources.select(sourceId)
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 30 },
    audio: false
  })
  if (mic) stream.addTrack(mic)
  return stream
}

function pickMime(): string {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ]
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || 'video/webm'
}

export function useCapture() {
  const [status, setStatus] = useState<'idle' | 'countdown' | 'recording'>('idle')
  const [countdown, setCountdown] = useState(0)
  const [elapsed, setElapsed] = useState(0)

  const screenRec = useRef<MediaRecorder | null>(null)
  const cameraRec = useRef<MediaRecorder | null>(null)
  const screenChunks = useRef<Blob[]>([])
  const cameraChunks = useRef<Blob[]>([])
  const streams = useRef<MediaStream[]>([])
  const startedAt = useRef(0)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const resolver = useRef<((r: CaptureResult) => void) | null>(null)

  const cleanup = useCallback(() => {
    streams.current.forEach((s) => s.getTracks().forEach((t) => t.stop()))
    streams.current = []
    if (timer.current) clearInterval(timer.current)
    timer.current = null
  }, [])

  const finalizedRef = useRef(false)

  const finalize = useCallback(async () => {
    const mime = pickMime()
    const screenBlob = new Blob(screenChunks.current, { type: mime })
    const screenSrc = URL.createObjectURL(screenBlob)

    let cameraSrc: string | null = null
    if (cameraChunks.current.length) {
      const cameraBlob = new Blob(cameraChunks.current, { type: mime })
      cameraSrc = URL.createObjectURL(cameraBlob)
    }

    // Persist raw tracks to disk (best-effort) for durability.
    try {
      const session = await window.ledger.recordings.newSession()
      await window.ledger.recordings.saveTrack(
        session.dir,
        'screen.webm',
        await screenBlob.arrayBuffer()
      )
    } catch (e) {
      console.warn('persist failed', e)
    }

    const duration = await measureDuration(screenSrc)
    cleanup()
    setStatus('idle')
    setElapsed(0)
    resolver.current?.({ screenSrc, cameraSrc, duration })
    resolver.current = null
  }, [cleanup])

  // Finalize exactly once, only after every active recorder has fully stopped
  // (MediaRecorder flushes its last chunk before firing onstop).
  const maybeFinalize = useCallback(() => {
    const s = screenRec.current
    const c = cameraRec.current
    const sDone = !s || s.state === 'inactive'
    const cDone = !c || c.state === 'inactive'
    if (sDone && cDone && !finalizedRef.current) {
      finalizedRef.current = true
      void finalize()
    }
  }, [finalize])

  const start = useCallback(
    (cfg: CaptureConfig): Promise<CaptureResult> => {
      return new Promise(async (resolve, reject) => {
        try {
          resolver.current = resolve
          screenChunks.current = []
          cameraChunks.current = []
          finalizedRef.current = false
          const mime = pickMime()

          let micTrack: MediaStreamTrack | null = null
          let cameraStream: MediaStream | null = null

          if (cfg.cameraDeviceId || cfg.micDeviceId) {
            const camStream = await navigator.mediaDevices.getUserMedia({
              video: cfg.cameraDeviceId
                ? { deviceId: { exact: cfg.cameraDeviceId }, width: 1280, height: 720 }
                : false,
              audio: cfg.micDeviceId ? { deviceId: { exact: cfg.micDeviceId } } : false
            })
            streams.current.push(camStream)
            micTrack = camStream.getAudioTracks()[0] || null
            if (cfg.cameraDeviceId && camStream.getVideoTracks().length) {
              cameraStream = new MediaStream(camStream.getVideoTracks())
            }
          }

          const screenStream = await getScreenStream(cfg.sourceId, micTrack)
          streams.current.push(screenStream)

          // Countdown
          setStatus('countdown')
          for (let n = 3; n >= 1; n--) {
            setCountdown(n)
            await wait(700)
          }
          setCountdown(0)

          // Screen recorder (video + mic audio)
          const sRec = new MediaRecorder(screenStream, { mimeType: mime })
          sRec.ondataavailable = (e) => e.data.size && screenChunks.current.push(e.data)
          sRec.onstop = maybeFinalize
          screenRec.current = sRec

          if (cameraStream) {
            const cRec = new MediaRecorder(cameraStream, { mimeType: mime })
            cRec.ondataavailable = (e) => e.data.size && cameraChunks.current.push(e.data)
            cRec.onstop = maybeFinalize
            cameraRec.current = cRec
            cRec.start(1000)
          } else {
            cameraRec.current = null
          }

          startedAt.current = Date.now()
          sRec.start(1000)
          setStatus('recording')
          timer.current = setInterval(
            () => setElapsed((Date.now() - startedAt.current) / 1000),
            200
          )
        } catch (e) {
          cleanup()
          setStatus('idle')
          reject(e)
        }
      })
    },
    [cleanup, maybeFinalize]
  )

  const stop = useCallback(() => {
    if (timer.current) clearInterval(timer.current)
    // Stop every active recorder; each fires onstop → maybeFinalize, which runs
    // finalize() once, after the last one has flushed.
    for (const rec of [screenRec.current, cameraRec.current]) {
      if (rec && rec.state !== 'inactive') rec.stop()
    }
    maybeFinalize()
  }, [maybeFinalize])

  return { status, countdown, elapsed, start, stop }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function measureDuration(src: string): Promise<number> {
  return new Promise((resolve) => {
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.src = src
    v.onloadedmetadata = () => {
      // WebM from MediaRecorder often reports Infinity until seeked
      if (v.duration === Infinity || isNaN(v.duration)) {
        v.currentTime = 1e101
        v.ontimeupdate = () => {
          v.ontimeupdate = null
          resolve(v.duration)
        }
      } else {
        resolve(v.duration)
      }
    }
    v.onerror = () => resolve(0)
  })
}
