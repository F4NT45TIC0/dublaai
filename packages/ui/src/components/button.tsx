import { Slot } from '@radix-ui/react-slot'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '../lib/cn'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg' | 'hero'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant
  readonly size?: ButtonSize
  /** Renderiza no elemento filho (para envolver um Link sem aninhar botões). */
  readonly asChild?: boolean
  readonly children?: ReactNode
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-paper border-ink hover:bg-accent-dim active:translate-x-[3px] active:translate-y-[3px] active:shadow-none shadow-hard-sm',
  secondary:
    'bg-paper text-ink border-ink hover:bg-paper-dim active:translate-x-[3px] active:translate-y-[3px] active:shadow-none shadow-hard-sm',
  ghost: 'bg-transparent border-transparent hover:border-current',
  danger:
    'bg-danger text-paper border-ink hover:brightness-90 active:translate-x-[3px] active:translate-y-[3px] active:shadow-none shadow-hard-sm',
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-xs',
  md: 'h-12 px-5 text-sm',
  lg: 'h-14 px-7 text-base',
  hero: 'h-16 px-9 text-lg sm:h-20 sm:px-12 sm:text-2xl',
}

/**
 * Botão do design system.
 *
 * O deslocamento no `:active` reproduz a sombra dura sendo "pressionada" —
 * feedback tátil sem animação, o que mantém o comportamento correto sob
 * `prefers-reduced-motion`.
 *
 * `min-h-11` garante alvo de toque de 44px mesmo nos tamanhos pequenos (§6).
 */
export function Button({
  variant = 'primary',
  size = 'md',
  asChild = false,
  className,
  type,
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot : 'button'

  return (
    <Component
      className={cn(
        'inline-flex items-center justify-center gap-2 border-2 font-display uppercase tracking-wide',
        'transition-[transform,box-shadow,background-color] duration-100 ease-snap',
        'disabled:pointer-events-none disabled:opacity-40',
        'min-h-11 cursor-pointer select-none',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...(asChild ? {} : { type: type ?? 'button' })}
      {...props}
    />
  )
}
