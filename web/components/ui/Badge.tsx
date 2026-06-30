import type { HTMLAttributes } from 'react'

type Tone = 'clear' | 'watch' | 'warning' | 'breach' | 'neutral' | 'info'

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone
}

const tones: Record<Tone, string> = {
  clear: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  watch: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  warning: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
  breach: 'bg-red-500/15 text-red-300 border-red-500/30',
  neutral: 'bg-slate-700/40 text-slate-300 border-slate-600/40',
  info: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
}

// Maps common backend status strings to a tone.
export function statusTone(status?: string): Tone {
  switch ((status ?? '').toLowerCase()) {
    case 'clear':
    case 'active':
    case 'resolved':
    case 'recovered':
    case 'acknowledged':
      return 'clear'
    case 'watch':
    case 'monitoring':
    case 'in-progress':
    case 'in_progress':
    case 'snoozed':
      return 'watch'
    case 'warning':
    case 'onboarding':
    case 'open':
    case 'pending':
      return 'warning'
    case 'breach':
    case 'suspended':
    case 'failed':
    case 'expired':
    case 'late':
      return 'breach'
    default:
      return 'neutral'
  }
}

export function Badge({ tone = 'neutral', className = '', children, ...props }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-xs font-medium ${tones[tone]} ${className}`}
      {...props}
    >
      {children}
    </span>
  )
}

export default Badge
