import type { ReactNode } from 'react'
import { cn } from '../lib/cn'

export interface TagProps {
  readonly children: ReactNode
  readonly tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'
  readonly className?: string
}

const TONES = {
  neutral: 'border-current text-current',
  accent: 'border-accent text-accent',
  ok: 'border-ok text-ok',
  warn: 'border-warn text-warn',
  danger: 'border-danger text-danger',
} as const

export function Tag({ children, tone = 'neutral', className }: TagProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center border px-2 py-0.5 font-body text-[0.6875rem] font-bold uppercase tracking-[0.12em]',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}
