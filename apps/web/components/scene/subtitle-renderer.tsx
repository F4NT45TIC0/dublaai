'use client'

import { useEffect, useRef, useState } from 'react'
import { CharacterBadge } from '@dubla/ui'
import {
  findActiveSubtitleIndex,
  SUBTITLE_LEAD_MS,
  type Character,
  type SubtitleSegment,
  type SpeakerSegment,
} from '@dubla/shared'

export interface SubtitleRendererProps {
  readonly subtitles: readonly SubtitleSegment[]
  readonly speakerSegments: readonly SpeakerSegment[]
  readonly characters: readonly Character[]
  readonly mediaTimeRef: React.RefObject<number>
  /** Antecipação da legenda: ler antes de precisar falar. */
  readonly leadMs?: number
  readonly className?: string
}

/**
 * Legenda sincronizada.
 *
 * A escolha de qual legenda mostrar vive em `findActiveSubtitleIndex`, em
 * `@dubla/shared`, e é coberta por testes. Aqui fica apenas o laço de leitura
 * do relógio — de propósito: lógica de sincronização dentro de um rAF só
 * poderia ser verificada com uma aba visível.
 *
 * O tempo é lido do ref dentro de um rAF e só vira estado quando o segmento
 * ATIVO muda — a re-render acontece algumas vezes por cena, não 60 vezes por
 * segundo.
 */
export function SubtitleRenderer({
  subtitles,
  speakerSegments,
  characters,
  mediaTimeRef,
  leadMs = SUBTITLE_LEAD_MS,
  className,
}: SubtitleRendererProps) {
  const [activeIndex, setActiveIndex] = useState(-1)
  const activeRef = useRef(-1)

  useEffect(() => {
    let rafId = requestAnimationFrame(function tick() {
      const next = findActiveSubtitleIndex(subtitles, mediaTimeRef.current * 1000, leadMs)

      if (next !== activeRef.current) {
        activeRef.current = next
        setActiveIndex(next)
      }
      rafId = requestAnimationFrame(tick)
    })

    return () => {
      cancelAnimationFrame(rafId)
    }
  }, [subtitles, leadMs, mediaTimeRef])

  const active = activeIndex >= 0 ? subtitles[activeIndex] : undefined
  const speaker = active?.speakerSegmentId
    ? speakerSegments.find((segment) => segment.id === active.speakerSegmentId)
    : undefined
  const character = speaker
    ? characters.find((entry) => entry.id === speaker.characterId)
    : undefined

  return (
    <div className={className}>
      {/* Região viva para leitores de tela: anuncia a fala atual sem
          interromper o que já está sendo lido. */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {active && character ? `${character.name}: ${active.text}` : ''}
      </div>

      <div aria-hidden="true" className="flex min-h-[7.5rem] flex-col justify-center gap-3">
        {character ? (
          <CharacterBadge
            name={character.name}
            colorToken={character.colorToken}
            patternToken={character.patternToken}
            active
          />
        ) : (
          <span className="font-display text-sm uppercase tracking-widest opacity-30">—</span>
        )}
        <p className="font-display text-2xl uppercase leading-[1.05] sm:text-4xl">
          {active ? active.text : ''}
        </p>
      </div>
    </div>
  )
}
