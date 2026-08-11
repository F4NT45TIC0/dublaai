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
  /** Melhor nota já obtida nesta fala, para dar o que superar. */
  readonly bestScore?: number | null
  readonly disabled?: boolean
  onRecord: () => void
  onStop: () => void
  onNext: () => void
  onRetry: () => void
  onToggleOriginal: () => void
}

/**
 * Comando da fala atual: o que ler, e o que fazer em seguida.
 *
 * O ciclo do fala-a-fala é curto e se repete dezenas de vezes — ler, gravar,
 * ouvir, seguir. Tudo de que ele precisa mora aqui, e a barra acompanha a
 * rolagem para que ouvir a nota lá embaixo e emendar a próxima fala não custe
 * uma viagem de volta ao topo.
 *
 * No celular ela fica presa embaixo, na zona do polegar; no desktop, no topo,
 * junto do vídeo. É a mesma barra: quem aprendeu num aparelho não reaprende no
 * outro.
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
  bestScore,
  disabled = false,
  onRecord,
  onStop,
  onNext,
  onRetry,
  onToggleOriginal,
}: SegmentHudProps) {
  const acaoPrincipal =
    phase === 'recording' ? (
      <button
        type="button"
        data-testid="segment-hud-parar"
        onClick={onStop}
        className="min-h-12 flex-1 border-2 border-accent bg-accent px-4 font-display text-base uppercase tracking-widest text-paper sm:flex-none"
      >
        ■ Parar
      </button>
    ) : phase === 'countdown' ? (
      <span
        role="status"
        className="flex min-h-12 flex-1 items-center justify-center border-2 border-accent px-6 font-display text-2xl tabular-nums text-accent sm:flex-none"
      >
        {countdown !== undefined && countdown > 0 ? countdown : 'Já!'}
      </span>
    ) : phase === 'preview' || isOriginal ? (
      <button
        type="button"
        data-testid="segment-hud-proxima"
        disabled={disabled}
        onClick={onNext}
        className="min-h-12 flex-1 border-2 border-accent bg-accent px-4 font-display text-base uppercase tracking-widest text-paper disabled:opacity-40 sm:flex-none"
      >
        {allDone ? 'Cena fechada' : 'Próxima ▶'}
      </button>
    ) : (
      <button
        type="button"
        data-testid="segment-hud-gravar"
        disabled={disabled || phase === 'busy'}
        onClick={onRecord}
        className="min-h-12 flex-1 border-2 border-accent bg-accent px-4 font-display text-base uppercase tracking-widest text-paper disabled:opacity-40 sm:flex-none"
      >
        ● Gravar
      </button>
    )

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 border-t-2 border-ink-line bg-ink/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur sm:sticky sm:inset-x-auto sm:bottom-auto sm:top-0 sm:-mx-8 sm:border-b-2 sm:border-t-0 sm:px-8 sm:pb-3"
      data-testid="segment-hud"
      aria-label={`Fala ${String(index + 1)} de ${String(total)}`}
    >
      <div className="mx-auto flex w-full max-w-[100rem] flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <div className="min-w-0 flex-1">
          <p className="font-body text-[0.6875rem] font-bold uppercase tracking-[0.16em] text-muted">
            Fala {index + 1}/{total} · {formatTimecode(segment.startMs)}–
            {formatTimecode(segment.endMs)}
            {typeof bestScore === 'number' ? (
              <>
                {' · '}
                <span className="text-paper">seu melhor: {bestScore}</span>
              </>
            ) : null}
          </p>
          {/*
            A fala é o texto que a pessoa vai ler em voz alta enquanto assiste.
            Duas linhas cabem quase toda fala de cena e evitam que a barra
            engula a tela do celular; o resto fica no `title`.
          */}
          <p
            className="line-clamp-2 font-display text-xl uppercase leading-tight sm:text-lg"
            title={text ?? undefined}
            data-testid="segment-hud-fala"
          >
            {text ?? (
              <span className="text-muted">Sem texto — descreva as falas para ler aqui</span>
            )}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            aria-pressed={isOriginal}
            title="Deixar esta fala com a voz do vídeo (O)"
            data-testid="segment-hud-original"
            disabled={disabled}
            onClick={onToggleOriginal}
            className={`min-h-12 border-2 px-3 font-display text-xs uppercase tracking-widest disabled:opacity-40 ${
              isOriginal
                ? 'border-accent bg-accent text-paper'
                : 'border-ink-line text-muted hover:border-paper hover:text-paper'
            }`}
          >
            {/*
              O losango sozinho não dizia nada: um ícone sem rótulo obriga a
              clicar para descobrir. O texto fica visível, não escondido para
              leitor de tela.
            */}
            <span aria-hidden="true" className="mr-1">
              ◆
            </span>
            {isOriginal ? 'No original' : 'Voz original'}
          </button>

          {phase === 'preview' ? (
            <button
              type="button"
              title="Gravar esta fala de novo (R)"
              data-testid="segment-hud-regravar"
              disabled={disabled}
              onClick={onRetry}
              className="min-h-12 border-2 border-ink-line px-3 font-display text-xs uppercase tracking-widest text-paper hover:border-paper disabled:opacity-40"
            >
              ↺ De novo
            </button>
          ) : null}

          {acaoPrincipal}
        </div>
      </div>

      <p className="mt-1 hidden font-body text-[0.6875rem] uppercase tracking-[0.14em] text-muted sm:block">
        Espaço grava e avança · R de novo · O voz original · ← → troca de fala · Esc cancela
      </p>
    </div>
  )
}
