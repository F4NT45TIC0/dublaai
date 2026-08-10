'use client'

import { useCallback, useEffect, useRef } from 'react'
import { formatTimecode, type SpeakerSegment } from '@dubla/shared'

export interface TakeStripCell {
  /** Já existe tomada gravada para esta fala. */
  readonly recorded: boolean
  /** Nota geral da melhor tomada, quando houver. */
  readonly score: number | null
  /** A fala foi deixada com a voz original do vídeo. */
  readonly original: boolean
}

export interface TakeStripProps {
  readonly segments: readonly SpeakerSegment[]
  readonly cells: Readonly<Record<string, TakeStripCell | undefined>>
  readonly activeIndex: number
  readonly disabled?: boolean
  readonly onSelect: (index: number) => void
}

/**
 * A cena como uma fita de película: uma célula por fala.
 *
 * É a espinha da tela e o motor de repetição. Uma lista de falas diz onde você
 * está; a fita mostra a cena INTEIRA de uma vez — as células vazias no meio das
 * cheias são o que faz querer fechar o rolo. Sem isso, gravar oito falas são
 * oito telas iguais sem nenhuma sensação de avanço.
 *
 * O estado nunca depende só da cor (§63): célula vazia tem o fundo vazado,
 * gravada mostra a nota, original mostra o losango de "vem do vídeo". Quem não
 * distingue vermelho de verde lê a mesma informação.
 */
export function TakeStrip({
  segments,
  cells,
  activeIndex,
  disabled = false,
  onSelect,
}: TakeStripProps) {
  const listRef = useRef<HTMLUListElement | null>(null)

  // A fita rola sozinha para acompanhar a fala da vez: em cena longa, a célula
  // ativa some da tela e a pessoa perde a referência de onde está.
  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[aria-current="true"]')
    active?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  }, [activeIndex])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLUListElement>) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
      event.preventDefault()
      const delta = event.key === 'ArrowRight' ? 1 : -1
      const next = Math.min(segments.length - 1, Math.max(0, activeIndex + delta))
      onSelect(next)
    },
    [activeIndex, onSelect, segments.length],
  )

  const gravadas = segments.filter((segment) => cells[segment.id]?.recorded).length
  const originais = segments.filter((segment) => cells[segment.id]?.original).length
  const fechadas = gravadas + originais

  return (
    <section aria-labelledby="fita-titulo" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="fita-titulo" className="font-display text-sm uppercase tracking-[0.18em]">
          A cena
        </h2>
        <p className="font-display text-sm uppercase tracking-[0.18em] text-muted" role="status">
          <span className={fechadas === segments.length ? 'text-ok' : 'text-paper'}>
            {fechadas}
          </span>
          /{segments.length} falas
          {originais > 0 ? ` · ${String(originais)} no original` : ''}
        </p>
      </div>

      {/*
        A fita rola na horizontal com encaixe: no celular ela vira o gesto
        natural de percorrer a cena, e no desktop cabe inteira sem empurrar o
        resto da página para baixo.
      */}
      <ul
        ref={listRef}
        onKeyDown={onKeyDown}
        aria-label="Falas da cena"
        className="flex snap-x snap-mandatory gap-1 overflow-x-auto border-y-2 border-dotted border-ink-line py-2"
      >
        {segments.map((segment, index) => {
          const cell = cells[segment.id]
          const ativa = index === activeIndex
          const original = cell?.original === true
          const gravada = cell?.recorded === true

          return (
            <li key={segment.id} className="snap-start">
              <button
                type="button"
                disabled={disabled}
                aria-current={ativa}
                aria-label={`Fala ${String(index + 1)}: ${
                  original ? 'voz original' : gravada ? `gravada, nota ${String(cell.score ?? 0)}` : 'ainda não gravada'
                }`}
                data-testid={`fita-fala-${String(index)}`}
                onClick={() => {
                  onSelect(index)
                }}
                className={`flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-0.5 border-2 disabled:opacity-40 ${
                  ativa
                    ? 'border-accent bg-accent text-paper'
                    : gravada || original
                      ? 'border-ink-line bg-ink-soft text-paper hover:border-paper'
                      : 'border-dashed border-ink-line text-muted hover:border-paper hover:text-paper'
                }`}
              >
                <span className="font-body text-[0.625rem] font-bold tabular-nums opacity-70">
                  {index + 1}
                </span>
                <span className="font-display text-lg leading-none tabular-nums">
                  {original ? '◆' : gravada ? (cell.score ?? '—') : '·'}
                </span>
                <span className="font-body text-[0.5625rem] tabular-nums opacity-60">
                  {formatTimecode(segment.startMs)}
                </span>
              </button>
            </li>
          )
        })}
      </ul>

      <p className="font-body text-[0.6875rem] uppercase tracking-[0.14em] text-muted">
        <span aria-hidden="true">·</span> a gravar · <span aria-hidden="true">◆</span> voz original ·
        número = sua melhor nota
      </p>
    </section>
  )
}
