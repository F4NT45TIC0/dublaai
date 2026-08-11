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
        <h2 id="modo-titulo" className="font-display text-2xl uppercase">
          Como você quer dublar
        </h2>
        <p className="mt-1 text-sm text-muted">
          Dá para trocar a qualquer momento. O áudio original fica mudo enquanto você grava.
        </p>
      </div>

      {/*
        Radiogroup de verdade, e não uma fileira de botões: com leitor de tela a
        pessoa ouve "opção 1 de 2, selecionada" e navega com as setas, que é o
        comportamento que ela já conhece de qualquer formulário.
      */}
      <div role="radiogroup" aria-labelledby="modo-titulo" className="grid gap-2 sm:grid-cols-2">
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
              className={`flex min-h-24 flex-col items-start gap-1 border-2 p-4 text-left disabled:opacity-40 ${
                escolhido
                  ? 'border-accent bg-accent text-paper'
                  : 'border-ink-line hover:border-paper'
              }`}
            >
              <span className="flex w-full items-center justify-between gap-2">
                <span className="font-display text-lg uppercase tracking-wide">{modo.nome}</span>
                {/*
                  A marca de escolhido é texto, não só cor de fundo: quem não
                  distingue as cores precisa saber onde está.
                */}
                <span className="font-body text-[0.625rem] font-bold uppercase tracking-[0.16em]">
                  {escolhido ? 'Escolhido' : ''}
                </span>
              </span>
              <span className="font-body text-sm">{modo.resumo}</span>
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
