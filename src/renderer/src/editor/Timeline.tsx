import { useRef } from 'react'
import type { Clip, Project } from '../lib/types'
import { cn } from '../components/ui'
import { clipDur, clipLayout, clipToOutput, totalDuration } from '../lib/composite'
import { useThumbnails } from './useThumbnails'

interface Props {
  project: Project
  outputTime: number
  selectedClip: string | null
  onSeek: (outT: number) => void
  onSelectClip: (id: string | null) => void
  onTrim: (id: string, side: 'in' | 'out', sourceT: number, coalesce: boolean) => void
  onCommit: () => void
  onSelectZoom: (id: string) => void
  selectedZoom: string | null
}

export default function Timeline({
  project,
  outputTime,
  selectedClip,
  onSeek,
  onSelectClip,
  onTrim,
  onCommit,
  onSelectZoom,
  selectedZoom
}: Props): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const total = Math.max(0.001, totalDuration(project))
  const pct = (t: number): number => (t / total) * 100
  const thumbs = useThumbnails(project.screenSrc, project.duration)
  const boxes = clipLayout(project)

  const outFromX = (clientX: number): number => {
    const el = trackRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    const x = Math.min(Math.max(0, clientX - rect.left), rect.width)
    return (x / rect.width) * total
  }

  // Scrub the playhead (drag on ruler / playhead knob).
  const scrub = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onSeek(outFromX(e.clientX))
    const move = (ev: MouseEvent): void => onSeek(outFromX(ev.clientX))
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // Trim a clip edge with a frozen pixels-per-second scale (stable while total changes).
  const startTrim = (e: React.MouseEvent, clip: Clip, side: 'in' | 'out'): void => {
    e.stopPropagation()
    e.preventDefault()
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect) return
    const pxPerSec = rect.width / total
    const startX = e.clientX
    const inv = clip.inPoint
    const outv = clip.outPoint
    const move = (ev: MouseEvent): void => {
      const dSec = (ev.clientX - startX) / pxPerSec
      if (side === 'in') onTrim(clip.id, 'in', inv + dSec, true)
      else onTrim(clip.id, 'out', outv + dSec, true)
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      onCommit()
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const ticks = buildTicks(total)
  const nearestThumb = (src: number): string => {
    if (!thumbs.length) return ''
    const i = Math.round((src / Math.max(0.001, project.duration)) * thumbs.length - 0.5)
    return thumbs[Math.max(0, Math.min(thumbs.length - 1, i))] || ''
  }

  return (
    <div className="select-none space-y-1">
      {/* Ruler (click/drag to scrub) */}
      <div
        className="relative h-4 text-[10px] text-white/35 cursor-ew-resize"
        onMouseDown={scrub}
      >
        {ticks.map((t) => (
          <div
            key={t}
            className="absolute -translate-x-1/2 tabular-nums pointer-events-none"
            style={{ left: `${pct(t)}%` }}
          >
            {fmt(t)}
          </div>
        ))}
      </div>

      <div
        ref={trackRef}
        className="relative h-16 rounded-xl bg-black/40 border border-white/[0.07] overflow-hidden"
        onMouseDown={() => onSelectClip(null)}
      >
        {/* Clips packed in output order */}
        {boxes.map(({ clip, outStart }) => {
          const selected = clip.id === selectedClip
          const width = pct(clipDur(clip))
          return (
            <div
              key={clip.id}
              onMouseDown={(e) => {
                e.stopPropagation()
                onSelectClip(clip.id)
              }}
              className={cn(
                'absolute inset-y-0 overflow-hidden rounded-md border-2 cursor-pointer',
                selected ? 'border-accent z-10 shadow-glow' : 'border-white/10'
              )}
              style={{ left: `calc(${pct(outStart)}% + 1px)`, width: `calc(${width}% - 2px)` }}
            >
              <img
                src={nearestThumb(clip.inPoint)}
                alt=""
                className="absolute inset-0 w-full h-full object-cover opacity-60"
                draggable={false}
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
              <span className="absolute bottom-1 left-2 text-[10px] text-white/80 tabular-nums">
                {clipDur(clip).toFixed(1)}s
              </span>

              {selected && (
                <>
                  <div
                    onMouseDown={(e) => startTrim(e, clip, 'in')}
                    className="absolute left-0 inset-y-0 w-3 bg-accent/90 cursor-ew-resize flex items-center justify-center"
                  >
                    <div className="w-0.5 h-5 bg-white/90 rounded" />
                  </div>
                  <div
                    onMouseDown={(e) => startTrim(e, clip, 'out')}
                    className="absolute right-0 inset-y-0 w-3 bg-accent/90 cursor-ew-resize flex items-center justify-center"
                  >
                    <div className="w-0.5 h-5 bg-white/90 rounded" />
                  </div>
                </>
              )}
            </div>
          )
        })}

        {/* zoom punch-in regions (positioned in output time) */}
        {project.zooms.map((z) => {
          const bi = boxes.find((b) => z.start >= b.clip.inPoint && z.start < b.clip.outPoint)
          if (!bi) return null
          const s = clipToOutput(project, bi.index, z.start)
          const e = clipToOutput(project, bi.index, Math.min(z.end, bi.clip.outPoint))
          const selected = selectedZoom === z.id
          return (
            <button
              key={z.id}
              aria-label="Zoom effect"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(ev) => {
                ev.stopPropagation()
                onSelectZoom(z.id)
                onSeek(s)
              }}
              className={cn(
                'absolute top-1 h-3 rounded-full border z-20 flex items-center justify-center',
                selected
                  ? 'bg-sky-300/90 border-sky-100'
                  : 'bg-sky-400/70 border-sky-200/50 hover:bg-sky-300/80'
              )}
              style={{ left: `${pct(s)}%`, width: `${Math.max(1.5, pct(e - s))}%` }}
              title={`Zoom ${z.scale.toFixed(1)}×`}
            >
              <span className="text-[8px] text-sky-950 font-bold">⌕</span>
            </button>
          )
        })}

        {/* playhead — grab the knob to scrub */}
        <div
          className="absolute top-0 bottom-0 w-[2px] bg-white z-30 pointer-events-none"
          style={{ left: `${pct(outputTime)}%` }}
        >
          <div
            onMouseDown={scrub}
            className="absolute -top-2 left-1/2 -translate-x-1/2 w-4 h-4 rounded-full bg-white shadow cursor-grab active:cursor-grabbing hover:scale-110 transition-transform pointer-events-auto"
          />
        </div>
      </div>
    </div>
  )
}

function buildTicks(dur: number): number[] {
  const target = 8
  const raw = dur / target
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  const step = steps.find((s) => s >= raw) ?? 600
  const out: number[] = []
  for (let t = 0; t <= dur + 0.001; t += step) out.push(Math.round(t))
  return out
}

function fmt(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}
