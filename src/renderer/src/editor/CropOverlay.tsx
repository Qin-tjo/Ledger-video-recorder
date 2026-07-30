import { useRef } from 'react'
import type { CropRect } from '../lib/types'

const MIN = 0.08

interface Props {
  rect: CropRect
  onChange: (r: CropRect) => void
}

type Corner = 'tl' | 'tr' | 'bl' | 'br'

/**
 * Draggable crop rectangle. Sits over the stage while the preview shows the
 * full uncropped frame, so you pick the region directly on the picture.
 * Coordinates are normalized 0..1 against the stage box.
 */
export default function CropOverlay({ rect, onChange }: Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)

  const norm = (clientX: number, clientY: number): { x: number; y: number } => {
    const box = hostRef.current?.getBoundingClientRect()
    if (!box) return { x: 0, y: 0 }
    return {
      x: Math.min(1, Math.max(0, (clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (clientY - box.top) / box.height))
    }
  }

  const drag = (
    e: React.MouseEvent,
    onMove: (p: { x: number; y: number }, start: { x: number; y: number }) => void
  ): void => {
    e.preventDefault()
    e.stopPropagation()
    const start = norm(e.clientX, e.clientY)
    const move = (ev: MouseEvent): void => onMove(norm(ev.clientX, ev.clientY), start)
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // Move the whole rect, keeping it inside the frame.
  const onBodyDown = (e: React.MouseEvent): void => {
    const origin = { ...rect }
    drag(e, (p, start) => {
      const dx = p.x - start.x
      const dy = p.y - start.y
      onChange({
        ...origin,
        x: Math.min(1 - origin.w, Math.max(0, origin.x + dx)),
        y: Math.min(1 - origin.h, Math.max(0, origin.y + dy))
      })
    })
  }

  const onCornerDown = (e: React.MouseEvent, corner: Corner): void => {
    const o = { ...rect }
    const right = o.x + o.w
    const bottom = o.y + o.h
    drag(e, (p) => {
      let { x, y, w, h } = o
      if (corner === 'tl' || corner === 'bl') {
        x = Math.min(right - MIN, p.x)
        w = right - x
      } else {
        w = Math.max(MIN, Math.min(1 - o.x, p.x - o.x))
      }
      if (corner === 'tl' || corner === 'tr') {
        y = Math.min(bottom - MIN, p.y)
        h = bottom - y
      } else {
        h = Math.max(MIN, Math.min(1 - o.y, p.y - o.y))
      }
      onChange({ x, y, w, h })
    })
  }

  const pctBox = {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.w * 100}%`,
    height: `${rect.h * 100}%`
  }

  const handle = (corner: Corner, style: React.CSSProperties): JSX.Element => (
    <div
      onMouseDown={(e) => onCornerDown(e, corner)}
      className="absolute w-4 h-4 bg-white rounded-sm shadow border border-black/30"
      style={style}
    />
  )

  return (
    <div ref={hostRef} className="absolute inset-0 z-30 cursor-crosshair">
      {/* selection with a scrim over everything outside it */}
      <div
        onMouseDown={onBodyDown}
        className="absolute cursor-move border-2 border-white/90"
        style={{ ...pctBox, boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)' }}
      >
        {/* thirds guides */}
        <div className="absolute inset-0 pointer-events-none opacity-40">
          <div className="absolute left-1/3 top-0 bottom-0 w-px bg-white/60" />
          <div className="absolute left-2/3 top-0 bottom-0 w-px bg-white/60" />
          <div className="absolute top-1/3 left-0 right-0 h-px bg-white/60" />
          <div className="absolute top-2/3 left-0 right-0 h-px bg-white/60" />
        </div>
        {handle('tl', { left: -8, top: -8, cursor: 'nwse-resize' })}
        {handle('tr', { right: -8, top: -8, cursor: 'nesw-resize' })}
        {handle('bl', { left: -8, bottom: -8, cursor: 'nesw-resize' })}
        {handle('br', { right: -8, bottom: -8, cursor: 'nwse-resize' })}
      </div>
    </div>
  )
}
