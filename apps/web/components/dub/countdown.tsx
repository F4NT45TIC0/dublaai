'use client'

export interface CountdownProps {
  readonly value: number
  readonly onCancel: () => void
}

/**
 * Contagem regressiva.
 *
 * Ocupa a tela inteira de propósito: o §3 pede que nada distraia durante a
 * preparação. O número é grande o bastante para ser lido pela visão
 * periférica, porque o usuário deveria estar olhando para o vídeo.
 */
export function Countdown({ value, onCancel }: CountdownProps) {
  const label = value > 0 ? String(value) : 'GRAVANDO'

  return (
    <div className="fixed inset-0 z-40 flex flex-col items-center justify-center bg-ink/95">
      {/* Anuncia a contagem sem depender da visão. */}
      <p aria-live="assertive" className="sr-only">
        {value > 0 ? `Gravação em ${String(value)}` : 'Gravando'}
      </p>

      <p aria-hidden="true" className="font-display text-mega leading-none text-paper">
        {label}
      </p>

      <button
        type="button"
        onClick={onCancel}
        className="mt-10 min-h-11 border-2 border-paper px-6 font-display text-sm uppercase tracking-widest text-paper hover:bg-paper hover:text-ink"
      >
        Cancelar (Esc)
      </button>
    </div>
  )
}
