'use client'

import { formatTimecode, type SpeakerSegment } from '@dubla/shared'

export type SegmentPhase = 'idle' | 'countdown' | 'recording' | 'preview' | 'busy'

export interface SegmentHudProps {
  readonly segment: SpeakerSegment
  readonly index: number
  readonly total: number
  /** Texto da fala. `null` quando ninguém descreveu nem transcreveu ainda. */
  readonly text: string | null
  readonly phase: SegmentPhase
  readonly countdown?: number
  readonly isOriginal: boolean
  readonly allDone: boolean
  readonly disabled?: boolean
  onRecord: () => void
  onStop: () => void
  onNext: () => void
  onToggleOriginal: () => void
}

/**
 * Barra de comando da fala atual, grudada no topo.
 *
 * O ciclo do modo fala-a-fala é curto e se repete dezenas de vezes: ler a
 * fala, gravar, ouvir, seguir. Quando o botão de seguir mora no fim da página,
 * cada volta desse ciclo custa uma rolagem para baixo e outra para cima — o que
 * cansa exatamente onde o modo deveria ser ágil.
 *
 * Sendo `sticky`, a barra acompanha a rolagem: dá para ouvir a pontuação lá
 * embaixo e emendar a próxima fala sem voltar. O texto da fala vem junto porque
 * é o que a pessoa precisa ler ANTES de gravar, não depois.
 */
export function SegmentHud({
  segment,
  index,
  total,
  text,
  phase,
  countdown,
  isOriginal,
  allDone,
  disabled = false,
  onRecord,
  onStop,
  onNext,
  onToggleOriginal,
}: SegmentHudProps) {
  return (
    <div
      className="sticky top-0 z-30 -mx-4 border-b-2 border-ink-line bg-ink/95 px-4 py-3 backdrop-blur sm:-mx-8 sm:px-8"
      data-testid="segment-hud"
      aria-label={`Fala ${String(index + 1)} de ${String(total)}`}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="font-body text-[0.6875rem] font-bold uppercase tracking-[0.16em] text-muted">
          Fala {index + 1}/{total} · {formatTimecode(segment.startMs)}–
          {formatTimecode(segment.endMs)}
        </span>

        <p
          className="min-w-0 flex-1 truncate font-display text-lg uppercase"
          title={text ?? undefined}
          data-testid="segment-hud-fala"
        >
          {text ?? <span className="text-muted">Sem texto — descreva as falas para ler aqui</span>}
        </p>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            aria-pressed={isOriginal}
            data-testid="segment-hud-original"
            disabled={disabled}
            onClick={onToggleOriginal}
            className={`min-h-11 border-2 px-3 font-display text-xs uppercase tracking-widest disabled:opacity-40 ${
              isOriginal
                ? 'border-accent bg-accent text-paper'
                : 'border-ink-line text-muted hover:border-paper hover:text-paper'
            }`}
          >
            {isOriginal ? 'Voz original' : 'Usar voz original'}
          </button>

          {phase === 'recording' ? (
            <button
              type="button"
              data-testid="segment-hud-parar"
              onClick={onStop}
              className="min-h-11 border-2 border-accent bg-accent px-4 font-display text-sm uppercase tracking-widest text-paper"
            >
              Parar
            </button>
          ) : phase === 'countdown' ? (
            <span
              className="min-h-11 border-2 border-ink-line px-4 py-2 font-display text-sm uppercase tracking-widest text-muted"
              role="status"
            >
              {countdown !== undefined && countdown > 0 ? countdown : 'Já!'}
            </span>
          ) : phase === 'preview' || isOriginal ? (
            <button
              type="button"
              data-testid="segment-hud-proxima"
              disabled={disabled}
              onClick={onNext}
              className="min-h-11 border-2 border-accent bg-accent px-4 font-display text-sm uppercase tracking-widest text-paper disabled:opacity-40"
            >
              {allDone ? 'Tudo gravado' : 'Próxima fala ▶'}
            </button>
          ) : (
            <button
              type="button"
              data-testid="segment-hud-gravar"
              disabled={disabled || phase === 'busy'}
              onClick={onRecord}
              className="min-h-11 border-2 border-accent bg-accent px-4 font-display text-sm uppercase tracking-widest text-paper disabled:opacity-40"
            >
              ● Gravar
            </button>
          )}
        </div>
      </div>

      <p className="mt-1 font-body text-[0.6875rem] uppercase tracking-[0.14em] text-muted">
        Espaço grava · Esc cancela
      </p>
    </div>
  )
}
