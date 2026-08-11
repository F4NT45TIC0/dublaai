'use client'

import type { TakeMode } from '@/lib/take-modes'

export interface ModePickerProps {
  readonly value: TakeMode
  readonly disabled?: boolean
  readonly onChange: (mode: TakeMode) => void
}

interface ModoDescrito {
  readonly value: TakeMode
  readonly nome: string
  readonly resumo: string
  readonly detalhe: string
}

/**
 * Os dois jeitos de dublar um vídeo individual, ditos por extenso.
 *
 * Antes eram quatro botões com uma palavra cada e uma legenda que trocava
 * embaixo: para saber o que cada opção fazia era preciso clicar e ver o que
 * acontecia. Cada cartão diz o que é e o que muda na prática, porque
 * escolher o modo é a primeira decisão da tela e a única difícil de desfazer
 * depois de já ter gravado.
 */
const MODOS: readonly ModoDescrito[] = [
  {
    value: 'segment',
    nome: 'Fala a fala',
    resumo: 'Uma fala por vez, com nota em cada',
    detalhe: 'Dá para repetir só o que ficou ruim e deixar falas na voz original.',
  },
  {
    value: 'full',
    nome: 'Cena inteira',
    resumo: 'Uma tomada do começo ao fim',
    detalhe: 'Mais difícil: errou no meio, recomeça. Uma nota para a cena toda.',
  },
]

export function ModePicker({ value, disabled = false, onChange }: ModePickerProps) {
  return (
    <section aria-labelledby="modo-titulo" className="flex flex-col gap-3">
      <div>
        <h2 id="modo-titulo" className="font-display text-lg uppercase tracking-wide">
          Como você quer dublar
        </h2>
        <p className="mt-0.5 text-xs text-muted">
          Dá para trocar a qualquer momento. A referência toca baixa enquanto você grava.
        </p>
      </div>

      <div role="radiogroup" aria-labelledby="modo-titulo" className="flex flex-col gap-2">
        {MODOS.map((modo) => {
          const escolhido = value === modo.value
          return (
            <button
              key={modo.value}
              type="button"
              role="radio"
              aria-checked={escolhido}
              disabled={disabled}
              data-testid={`local-take-mode-${modo.value}`}
              onClick={() => {
                onChange(modo.value)
              }}
              className={`flex flex-col items-start gap-1 border-2 p-3 text-left transition-colors disabled:opacity-40 ${
                escolhido
                  ? 'border-accent bg-accent/10 border-l-4 border-l-accent text-paper'
                  : 'border-ink-line bg-ink-soft/20 hover:border-paper'
              }`}
            >
              <span className="flex w-full items-center justify-between gap-2">
                <span className="font-display text-base uppercase tracking-wide">{modo.nome}</span>
                <span className="font-body text-[0.625rem] font-bold uppercase tracking-[0.16em] text-accent">
                  {escolhido ? '✓ Escolhido' : ''}
                </span>
              </span>
              <span className="font-body text-xs font-semibold">{modo.resumo}</span>
              <span className={`font-body text-xs ${escolhido ? 'text-paper/80' : 'text-muted'}`}>
                {modo.detalhe}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
