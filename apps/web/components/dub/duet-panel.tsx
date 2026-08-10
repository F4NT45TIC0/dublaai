'use client'

import { useMemo, useState } from 'react'
import type { Character, SpeakerSegment } from '@dubla/shared'
import { formatScore } from '@dubla/shared'
import { Button, CharacterBadge, Tag } from '@dubla/ui'
import {
  createDuetSession,
  playableSegments,
  progressByPlayer,
  segmentOwner,
  type DuetPlayer,
  type DuetSession,
} from '@/lib/duet-session'

export interface DuetSetupProps {
  readonly sceneId: string
  readonly characters: readonly Character[]
  readonly onStart: (session: DuetSession) => void
}

const DEFAULT_NAMES = ['Jogador 1', 'Jogador 2'] as const

/**
 * Escolha de personagem.
 *
 * Um personagem por jogador, e nunca o mesmo para os dois: se ambos dublassem
 * a mesma voz, metade da cena ficaria sem dono e o rodízio nunca terminaria.
 */
export function DuetSetup({ sceneId, characters, onStart }: DuetSetupProps) {
  const [names, setNames] = useState<[string, string]>([...DEFAULT_NAMES])
  const [picks, setPicks] = useState<[string, string]>([
    characters[0]?.id ?? '',
    characters[1]?.id ?? '',
  ])

  const clash = picks[0] === picks[1]
  const ready = picks[0] !== '' && picks[1] !== '' && !clash

  return (
    <div className="flex flex-col gap-5" data-testid="duet-setup">
      <p className="text-sm text-muted">
        Vocês dois no mesmo aparelho, revezando. Quem está na vez ouve o que o outro já dublou
        antes de gravar a própria fala.
      </p>

      {[0, 1].map((slot) => (
        <fieldset key={slot} className="flex flex-col gap-2 border-2 border-ink-line p-4">
          <legend className="px-2 font-display text-xs uppercase tracking-widest text-muted">
            Jogador {slot + 1}
          </legend>

          <label className="flex flex-col gap-1">
            <span className="font-body text-[0.6875rem] font-bold uppercase tracking-[0.16em] text-muted">
              Nome
            </span>
            <input
              type="text"
              value={names[slot]}
              maxLength={20}
              data-testid={`duet-name-${String(slot)}`}
              onChange={(event) => {
                const next: [string, string] = [...names]
                next[slot] = event.target.value
                setNames(next)
              }}
              className="min-h-11 border-2 border-ink-line bg-ink-soft px-3 font-body text-sm text-paper"
            />
          </label>

          <div className="flex flex-wrap gap-2 pt-1">
            {characters.map((character) => (
              <button
                key={character.id}
                type="button"
                aria-pressed={picks[slot] === character.id}
                data-testid={`duet-pick-${String(slot)}-${character.id}`}
                onClick={() => {
                  const next: [string, string] = [...picks]
                  next[slot] = character.id
                  setPicks(next)
                }}
                className={`min-h-11 border-2 px-3 ${
                  picks[slot] === character.id
                    ? 'border-accent bg-accent/10'
                    : 'border-ink-line hover:border-paper'
                }`}
              >
                <CharacterBadge
                  name={character.name}
                  colorToken={character.colorToken}
                  patternToken={character.patternToken}
                  active={picks[slot] === character.id}
                />
              </button>
            ))}
          </div>
        </fieldset>
      ))}

      {clash ? (
        <p className="border-2 border-warn px-3 py-2 text-xs text-warn">
          Cada jogador precisa de um personagem diferente — senão metade da cena fica sem dono.
        </p>
      ) : null}

      <Button
        size="lg"
        disabled={!ready}
        data-testid="duet-start"
        onClick={() => {
          const players: DuetPlayer[] = ([0, 1] as const).map((slot) => ({
            id: `p${String(slot + 1)}`,
            name: names[slot].trim().length > 0 ? names[slot].trim() : DEFAULT_NAMES[slot],
            characterId: picks[slot],
          }))
          onStart(createDuetSession(sceneId, players))
        }}
      >
        Começar o dueto
      </Button>
    </div>
  )
}

export interface DuetTurnProps {
  readonly session: DuetSession
  readonly segments: readonly SpeakerSegment[]
  readonly characters: readonly Character[]
  readonly currentSegment: SpeakerSegment | null
  readonly onReset: () => void
}

/** Cabeçalho da vez: de quem é, qual fala, e como cada um está. */
export function DuetTurn({
  session,
  segments,
  characters,
  currentSegment,
  onReset,
}: DuetTurnProps) {
  const progress = useMemo(
    () => progressByPlayer(segments, session),
    [segments, session],
  )
  const ordered = useMemo(
    () => playableSegments(segments, session.players),
    [segments, session],
  )

  const owner = currentSegment ? segmentOwner(currentSegment, session.players) : undefined
  const character = characters.find((entry) => entry.id === currentSegment?.characterId)
  const position = currentSegment
    ? ordered.findIndex((entry) => entry.id === currentSegment.id) + 1
    : ordered.length

  return (
    <div className="flex flex-col gap-4" data-testid="duet-turn">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {progress.map((entry) => (
            <Tag
              key={entry.player.id}
              tone={entry.player.id === owner?.id ? 'accent' : 'neutral'}
            >
              {entry.player.name} {entry.recorded}/{entry.total}
            </Tag>
          ))}
        </div>
        <button
          type="button"
          onClick={onReset}
          className="font-display text-xs uppercase tracking-widest text-muted underline hover:text-paper"
        >
          Trocar personagens
        </button>
      </div>

      {currentSegment && owner ? (
        <div className="border-2 border-accent p-4">
          <p
            className="font-body text-[0.6875rem] font-bold uppercase tracking-[0.16em] text-muted"
            data-testid="duet-turn-label"
          >
            Vez de {owner.name} · fala {position} de {ordered.length}
          </p>
          {character ? (
            <div className="mt-2">
              <CharacterBadge
                name={character.name}
                colorToken={character.colorToken}
                patternToken={character.patternToken}
                active
              />
            </div>
          ) : null}
          <p className="mt-2 font-display text-xl uppercase leading-tight">
            {currentSegment.text}
          </p>
        </div>
      ) : null}
    </div>
  )
}

export interface DuetSummaryProps {
  readonly session: DuetSession
  readonly segments: readonly SpeakerSegment[]
  /** Nota geral por fala, quando pôde ser calculada. */
  readonly scoreBySegment: Readonly<Record<string, number | null>>
  readonly onRestart: () => void
}

/**
 * Resultado do dueto.
 *
 * Cada jogador tem a própria média, ponderada pela duração das falas — uma
 * pessoa com falas longas não pode ser comparada a outra com interjeições.
 * Falas sem nota calculável ficam de fora da média em vez de contar zero (§12).
 */
export function DuetSummary({
  session,
  segments,
  scoreBySegment,
  onRestart,
}: DuetSummaryProps) {
  const results = useMemo(() => {
    const playable = playableSegments(segments, session.players)

    return session.players.map((player) => {
      const owned = playable.filter(
        (segment) => segmentOwner(segment, session.players)?.id === player.id,
      )

      let weighted = 0
      let weight = 0
      let missing = 0

      for (const segment of owned) {
        const score = scoreBySegment[segment.id]
        if (score === null || score === undefined) {
          missing += 1
          continue
        }
        const duration = Math.max(1, segment.endMs - segment.startMs)
        weighted += score * duration
        weight += duration
      }

      return {
        player,
        score: weight === 0 ? null : weighted / weight,
        missing,
        total: owned.length,
      }
    })
  }, [segments, session, scoreBySegment])

  return (
    <section className="flex flex-col gap-5" data-testid="duet-summary">
      <h3 className="font-display text-giant uppercase">Cena fechada</h3>

      <ul className="flex flex-col gap-3">
        {results.map((entry) => (
          <li
            key={entry.player.id}
            className="flex items-baseline justify-between gap-4 border-b-2 border-ink-line pb-2"
          >
            <span className="font-display text-xl uppercase">{entry.player.name}</span>
            <span className="flex items-baseline gap-3">
              {entry.missing > 0 ? (
                <span className="text-xs text-muted">
                  {entry.missing} de {entry.total} sem nota
                </span>
              ) : null}
              <span className="font-display text-4xl tabular-nums">
                {formatScore(entry.score)}
              </span>
            </span>
          </li>
        ))}
      </ul>

      <Button variant="secondary" onClick={onRestart}>
        Jogar de novo
      </Button>
    </section>
  )
}
