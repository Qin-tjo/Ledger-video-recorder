import type { Project } from '../lib/types'
import { Button, Field, Segmented, Slider, cn } from '../components/ui'

interface Props {
  project: Project
  update: (fn: (p: Project) => void, opts?: { coalesce?: boolean }) => void
  selectedZoom: string | null
  onSelectZoom: (id: string | null) => void
  onAddZoom: () => void
  onRefocusZoom: (id: string) => void
}

export default function Inspector({
  project,
  update,
  selectedZoom,
  onSelectZoom,
  onAddZoom,
  onRefocusZoom
}: Props): JSX.Element {
  const slide = (fn: (p: Project) => void): void => update(fn, { coalesce: true })
  const cam = project.camera
  const bg = project.background

  return (
    <div className="space-y-6">
      {/* Camera */}
      <section>
        <SectionHeader
          title="Camera"
          right={
            <Toggle
              on={cam.enabled}
              onChange={(v) => update((p) => (p.camera.enabled = v))}
            />
          }
        />
        {cam.enabled && project.cameraSrc && (
          <div className="space-y-4">
            <Field label="Shape">
              <Segmented
                value={cam.shape}
                onChange={(v) => update((p) => (p.camera.shape = v))}
                options={[
                  { value: 'circle', label: 'Circle' },
                  { value: 'rounded', label: 'Rounded' },
                  { value: 'square', label: 'Square' }
                ]}
              />
            </Field>
            <Field label="Size" hint={`${Math.round(cam.size * 100)}%`}>
              <Slider
                min={0.1}
                max={0.45}
                value={cam.size}
                onChange={(v) => slide((p) => (p.camera.size = v))}
              />
            </Field>
            <Field label="Zoom" hint={`${(cam.zoom || 1).toFixed(1)}×`}>
              <Slider
                min={1}
                max={2}
                step={0.05}
                value={cam.zoom || 1}
                onChange={(v) => slide((p) => (p.camera.zoom = v))}
              />
            </Field>
            <Field label="Position">
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ['tl', 'Top left', 0.13, 0.16],
                    ['tr', 'Top right', 0.87, 0.16],
                    ['bl', 'Bottom left', 0.13, 0.84],
                    ['br', 'Bottom right', 0.87, 0.84]
                  ] as const
                ).map(([corner, label, x, y]) => (
                  <Button
                    key={corner}
                    size="sm"
                    variant={cam.corner === corner ? 'primary' : 'subtle'}
                    onClick={() =>
                      update((p) => {
                        p.camera.corner = corner
                        p.camera.x = x
                        p.camera.y = y
                      })
                    }
                  >
                    {label}
                  </Button>
                ))}
              </div>
              <p className="text-[11px] text-white/35 mt-2">
                Or drag the bubble directly on the preview.
              </p>
            </Field>
            <div className="flex gap-2">
              <MiniToggle
                label="Mirror"
                on={cam.mirror}
                onChange={(v) => update((p) => (p.camera.mirror = v))}
              />
              <MiniToggle
                label="Border"
                on={cam.border}
                onChange={(v) => update((p) => (p.camera.border = v))}
              />
            </div>
          </div>
        )}
        {cam.enabled && !project.cameraSrc && (
          <p className="text-[12px] text-white/35">No camera was recorded.</p>
        )}
      </section>

      <Divider />

      {/* Background */}
      <section>
        <SectionHeader title="Background" />
        <div className="space-y-4">
          <Segmented
            value={bg.mode}
            onChange={(v) => update((p) => (p.background.mode = v))}
            options={[
              { value: 'none', label: 'None' },
              { value: 'solid', label: 'Solid' },
              { value: 'gradient', label: 'Gradient' }
            ]}
          />
          {bg.mode !== 'none' && (
            <>
              <div className="flex gap-3">
                <ColorField
                  label="Color"
                  value={bg.color}
                  onChange={(v) => update((p) => (p.background.color = v))}
                />
                {bg.mode === 'gradient' && (
                  <ColorField
                    label="Color 2"
                    value={bg.color2}
                    onChange={(v) => update((p) => (p.background.color2 = v))}
                  />
                )}
              </div>
              <Field label="Padding" hint={`${Math.round(bg.padding * 100)}%`}>
                <Slider
                  min={0}
                  max={0.15}
                  value={bg.padding}
                  onChange={(v) => slide((p) => (p.background.padding = v))}
                />
              </Field>
              <Field label="Corner radius" hint={`${Math.round(bg.radius)}px`}>
                <Slider
                  min={0}
                  max={48}
                  step={1}
                  value={bg.radius}
                  onChange={(v) => slide((p) => (p.background.radius = v))}
                />
              </Field>
            </>
          )}
        </div>
      </section>

      <Divider />

      {/* Zoom punch-ins */}
      <section>
        <SectionHeader
          title="Zoom & pan"
          right={
            <Button size="sm" onClick={onAddZoom}>
              + Add zoom
            </Button>
          }
        />
        <div className="space-y-2">
          {project.zooms.length === 0 && (
            <p className="text-[12px] text-white/35">
              Click <span className="text-white/60">+ Add zoom</span>, then click the spot
              on the preview to zoom into. It smoothly zooms in, holds, and zooms back out.
            </p>
          )}
          {project.zooms.map((z) => {
            const selected = z.id === selectedZoom
            const len = Math.max(0.1, z.end - z.start)
            return (
              <div
                key={z.id}
                onClick={() => onSelectZoom(z.id)}
                className={cn(
                  'rounded-xl border p-3 space-y-3 cursor-pointer transition-colors',
                  selected
                    ? 'bg-sky-400/10 border-sky-400/40'
                    : 'bg-black/25 border-white/[0.06] hover:border-white/15'
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-white/60 tabular-nums">
                    @ {z.start.toFixed(1)}s · {z.scale.toFixed(1)}×
                  </span>
                  <button
                    aria-label="Remove zoom"
                    className="text-white/40 hover:text-rose-300 text-xs no-drag"
                    onClick={(e) => {
                      e.stopPropagation()
                      update((p) => {
                        p.zooms = p.zooms.filter((k) => k.id !== z.id)
                      })
                    }}
                  >
                    Remove
                  </button>
                </div>
                <Field label="Amount" hint={`${z.scale.toFixed(1)}×`}>
                  <Slider
                    min={1.1}
                    max={3}
                    step={0.1}
                    value={z.scale}
                    onChange={(v) =>
                      slide((p) => {
                        const k = p.zooms.find((k) => k.id === z.id)
                        if (k) k.scale = v
                      })
                    }
                  />
                </Field>
                <Field label="Duration" hint={`${len.toFixed(1)}s`}>
                  <Slider
                    min={0.6}
                    max={6}
                    step={0.1}
                    value={len}
                    onChange={(v) =>
                      slide((p) => {
                        const k = p.zooms.find((k) => k.id === z.id)
                        if (k) k.end = Math.min(p.duration, k.start + v)
                      })
                    }
                  />
                </Field>
                <Button
                  size="sm"
                  variant="subtle"
                  className="w-full"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRefocusZoom(z.id)
                  }}
                >
                  Move focus point
                </Button>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}

function SectionHeader({
  title,
  right
}: {
  title: string
  right?: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex items-center justify-between mb-3">
      <h3 className="text-[13px] font-semibold text-white/80 uppercase tracking-wide">
        {title}
      </h3>
      {right}
    </div>
  )
}

function Divider(): JSX.Element {
  return <div className="h-px bg-white/[0.06]" />
}

function Toggle({
  on,
  onChange
}: {
  on: boolean
  onChange: (v: boolean) => void
}): JSX.Element {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label="Toggle"
      onClick={() => onChange(!on)}
      className={`no-drag w-10 h-6 rounded-full transition-colors ${
        on ? 'bg-accent' : 'bg-white/15'
      } relative`}
    >
      <span
        className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
          on ? 'left-[18px]' : 'left-0.5'
        }`}
      />
    </button>
  )
}

function MiniToggle({
  label,
  on,
  onChange
}: {
  label: string
  on: boolean
  onChange: (v: boolean) => void
}): JSX.Element {
  return (
    <button
      onClick={() => onChange(!on)}
      className={`no-drag flex-1 h-9 rounded-xl text-[13px] font-medium border transition-colors ${
        on
          ? 'bg-accent-soft border-accent/40 text-white'
          : 'bg-white/[0.04] border-white/10 text-white/50'
      }`}
    >
      {label}
    </button>
  )
}

function ColorField({
  label,
  value,
  onChange
}: {
  label: string
  value: string
  onChange: (v: string) => void
}): JSX.Element {
  return (
    <label className="flex-1">
      <span className="block text-[13px] font-medium text-white/70 mb-2">{label}</span>
      <div className="flex items-center gap-2 h-10 px-2 rounded-xl bg-black/30 border border-white/10">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="no-drag w-7 h-7 rounded-md bg-transparent cursor-pointer border-0"
        />
        <span className="text-[12px] text-white/50 tabular-nums">{value}</span>
      </div>
    </label>
  )
}
