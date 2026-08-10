import { characterColor } from '@dubla/shared'
import { cn } from '../lib/cn'

export interface CharacterBadgeProps {
  readonly name: string
  readonly colorToken: string
  readonly patternToken: string
  readonly active?: boolean
  readonly className?: string
}

/**
 * Identificação de personagem.
 *
 * A cor vem sempre acompanhada do NOME e de um padrão visual (§63). Um
 * dublador daltônico, ou alguém vendo a tela sob sol forte, ainda distingue
 * quem fala — a cor é reforço, nunca a informação em si.
 */
export function CharacterBadge({
  name,
  colorToken,
  patternToken,
  active = false,
  className,
}: CharacterBadgeProps) {
  const color = characterColor(colorToken)

  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 font-display text-sm uppercase tracking-wider',
        active ? 'opacity-100' : 'opacity-55',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="h-4 w-4 shrink-0 border-2 border-current"
        style={{ backgroundColor: color, backgroundImage: patternFor(patternToken, color) }}
      />
      <span style={{ color: active ? color : undefined }}>{name}</span>
    </span>
  )
}

function patternFor(token: string, color: string): string | undefined {
  const ink = 'rgba(15,14,12,0.85)'
  switch (token) {
    case 'stripes':
      return `repeating-linear-gradient(45deg, ${ink} 0 2px, ${color} 2px 5px)`
    case 'dots':
      return `radial-gradient(${ink} 1.2px, ${color} 1.3px)`
    case 'grid':
      return `linear-gradient(${ink} 1px, transparent 1px), linear-gradient(90deg, ${ink} 1px, ${color} 1px)`
    default:
      return undefined
  }
}
