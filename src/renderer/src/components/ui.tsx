import { motion } from 'framer-motion'
import { useId, type ButtonHTMLAttributes, type ReactNode } from 'react'

export function cn(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(' ')
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'subtle' | 'danger'
  size?: 'sm' | 'md' | 'lg'
}

export function Button({
  variant = 'subtle',
  size = 'md',
  className,
  children,
  ...rest
}: ButtonProps): JSX.Element {
  const base =
    'no-drag inline-flex items-center justify-center gap-2 font-medium rounded-xl transition-all duration-150 ease-premium select-none disabled:opacity-40 disabled:pointer-events-none'
  const sizes = {
    sm: 'text-[13px] px-3 h-8',
    md: 'text-sm px-4 h-10',
    lg: 'text-[15px] px-6 h-12'
  }
  const variants = {
    primary:
      'bg-accent text-white hover:bg-accent-hover shadow-glow active:scale-[0.98]',
    danger:
      'bg-rose-500 text-white hover:bg-rose-400 active:scale-[0.98]',
    ghost:
      'text-white/70 hover:text-white hover:bg-white/5',
    subtle:
      'bg-white/[0.06] text-white/90 hover:bg-white/[0.1] border border-white/10 active:scale-[0.98]'
  }
  return (
    <button className={cn(base, sizes[size], variants[variant], className)} {...rest}>
      {children}
    </button>
  )
}

export function Panel({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div
      className={cn(
        'rounded-2xl bg-white/[0.03] border border-white/[0.07] backdrop-blur-xl',
        className
      )}
    >
      {children}
    </div>
  )
}

export function Field({
  label,
  children,
  hint
}: {
  label: string
  children: ReactNode
  hint?: string
}): JSX.Element {
  return (
    <label className="block">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[13px] font-medium text-white/70">{label}</span>
        {hint && <span className="text-[11px] text-white/35">{hint}</span>}
      </div>
      {children}
    </label>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (v: T) => void
}): JSX.Element {
  const groupId = useId()
  return (
    <div className="flex gap-1 p-1 rounded-xl bg-black/30 border border-white/[0.06]">
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              'relative flex-1 h-8 rounded-lg text-[13px] font-medium transition-colors',
              active ? 'text-white' : 'text-white/50 hover:text-white/80'
            )}
          >
            {active && (
              <motion.div
                layoutId={`segmented-active-${groupId}`}
                className="absolute inset-0 rounded-lg bg-white/10 border border-white/10"
                transition={{ type: 'spring', stiffness: 400, damping: 32 }}
              />
            )}
            <span className="relative">{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}

export function Slider({
  value,
  min,
  max,
  step = 0.01,
  onChange
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
}): JSX.Element {
  return (
    <input
      type="range"
      className="no-drag w-full"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  )
}
