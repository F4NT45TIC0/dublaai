'use client'

import { characterColor, formatTimecode, type Character, type SpeakerSegment } from '@dubla/shared'
import { Tag } from '@dubla/ui'

export interface SegmentTakeState {
  /** Já existe tomada gravada para esta fala. */
  readonly recorded: boolean
  /** Nota geral da melhor tomada, quando houver. */
  readonly score: number | null
}

export interface SegmentNavigatorProps {
  readonly segments: readonly SpeakerSegment[]
  readonly characters: readonly Character[]
  readonly activeIndex: number
  readonly takes: Readonly<Record<string, SegmentTakeState>>
  readonly disabled?: boolean
  readonly onSelect: (index: number) => void
}

/**
 * Lista das falas da cena, com o estado de cada uma.
 *
 * No modo fala-a-fala esta lista é a espinha da tela: mostra onde a pessoa
 * está, o que já gravou e o que falta. É também o que torna o progresso
 * visível — sem ela, gravar sete falas seria sete telas iguais sem noção de
 * avanço.
 */
export function SegmentNavigator({
  segments,
  characters,
  activeIndex,
  takes,
  disabled = false,
  onSelect,
}: SegmentNavigatorProps) {
  const recorded = segments.filter((segment) => takes[segment.id]?.recorded).length

  return (
    <section className="flex flex-col gap-3" aria-label="Falas da cena">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-body text-[0.6875rem] font-bold uppercase tracking-[0.16em] text-muted">
          Falas
        </h3>
        <span className="font-display text-xs uppercase tracking-widest text-muted">
          {recorded} de {segments.length} gravadas
        </span>
      </div>

      <ol className="flex flex-col gap-1">
        {segments.map((segment, index) => {
          const character = characters.find((entry) => entry.id === segment.characterId)
          const take = takes[segment.id]
          const isActive = index === activeIndex

          return (
            <li key={segment.id}>
              <button
                type="button"
                disabled={disabled}
                aria-current={isActive ? 'step' : undefined}
                onClick={() => {
                  onSelect(index)
                }}
                className={`flex w-full items-center gap-3 border-2 px-3 py-2 text-left transition-colors disabled:opacity-40 ${
                  isActive
                    ? 'border-accent bg-accent/10'
                    : 'border-ink-line hover:border-paper'
                }`}
              >
                <span
                  aria-hidden="true"
                  className="h-8 w-1.5 shrink-0"
                  style={{
                    backgroundColor: character
                      ? characterColor(character.colorToken)
                      : 'var(--color-muted)',
                  }}
                />

                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-display text-xs uppercase tracking-widest text-muted">
                    {index + 1}. {character?.name ?? 'Voz'} · {formatTimecode(segment.startMs)}
                  </span>
                  <span className="truncate text-sm">{segment.text}</span>
                </span>

                {take?.recorded ? (
                  take.score === null ? (
                    <Tag tone="ok">Gravada</Tag>
                  ) : (
                    <span className="font-display text-xl tabular-nums text-ok">
                      {Math.round(take.score)}
                    </span>
                  )
                ) : (
                  <span className="font-display text-xs uppercase tracking-widest text-muted">
                    —
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
