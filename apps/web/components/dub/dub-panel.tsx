'use client'

import { useEffect, useMemo, useState } from 'react'
import type { DubMode, SceneDetail } from '@dubla/shared'
import { Button, ErrorState, ScoreCard, Tag } from '@dubla/ui'
import type { MediaClock } from '@dubla/audio'
import { useRecorder } from '@/lib/use-recorder'
import { Countdown } from './countdown'
import { LevelMeter } from './level-meter'
import { AttemptPlayback } from './attempt-playback'
import { SegmentNavigator } from './segment-navigator'
import { StitchedPlayback } from './stitched-playback'
import {
  analysisWindowFor,
  bestScoreBySegment,
  orderSegments,
  takeStatesBySegment,
  visibleAttemptsFor,
  type TakeMode,
} from '@/lib/take-modes'
import { DuetSetup, DuetSummary, DuetTurn } from './duet-panel'
import {
  isComplete,
  MIN_DUET_CHARACTERS,
  nextPendingIndex,
  playableSegments,
  recordTake,
  segmentOwner,
  type DuetSession,
} from '@/lib/duet-session'

export interface DubPanelProps {
  readonly scene: SceneDetail
  readonly featuresUrl: string
  readonly video: HTMLVideoElement | null
  readonly clockRef: React.RefObject<MediaClock | null>
  readonly onStartVideo: (fromMs: number) => Promise<boolean>
  readonly onStopVideo: () => void
  readonly isVideoBuffered: () => boolean
}

const MODES: readonly { value: DubMode; label: string; hint: string }[] = [
  {
    value: 'original',
    label: 'Original',
    hint: 'Chegue o mais perto possível da entrega original.',
  },
  {
    value: 'parody',
    label: 'Paródia',
    hint: 'Fale o que quiser. Só o encaixe na cena é avaliado.',
  },
]

export function DubPanel({
  scene,
  featuresUrl,
  video,
  clockRef,
  onStartVideo,
  onStopVideo,
  isVideoBuffered,
}: DubPanelProps) {
  const [takeMode, setTakeMode] = useState<TakeMode>('full')
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(0)
  const [duet, setDuet] = useState<DuetSession | null>(null)

  const orderedSegments = useMemo(() => orderSegments(scene.speakerSegments), [scene.speakerSegments])
  /** Dueto exige personagens suficientes para dois donos distintos. */
  const duetAvailable = scene.characters.length >= MIN_DUET_CHARACTERS

  /** No dueto, a fala da vez é decidida pelo rodízio, não pela pessoa. */
  const duetSegment = useMemo(() => {
    if (takeMode !== 'duet' || !duet) return undefined
    const playable = playableSegments(orderedSegments, duet.players)
    const index = nextPendingIndex(orderedSegments, duet)
    return index === -1 ? undefined : playable[index]
  }, [takeMode, duet, orderedSegments])

  const duetFinished = takeMode === 'duet' && duet !== null && isComplete(orderedSegments, duet)

  // Só existe quando se grava uma fala por vez; `undefined` significa cena
  // inteira, e o TypeScript estreita o resto do componente a partir disto.
  const activeSegment =
    takeMode === 'segment'
      ? (orderedSegments[activeSegmentIndex] ?? orderedSegments[0])
      : takeMode === 'duet'
        ? duetSegment
      : undefined
  const bySegment = activeSegment !== undefined

  /** Trecho gravado e analisado. Ausente no modo cena inteira. */
  const analysisWindow = useMemo(
    () => (activeSegment ? analysisWindowFor(activeSegment, scene.durationMs) : undefined),
    [activeSegment, scene.durationMs],
  )

  const recorder = useRecorder({
    sceneId: scene.id,
    // No modo fala-a-fala só a fala corrente é pontuada; as outras nem entram
    // na conta, para que nenhuma nota seja afirmada sobre o que não foi gravado.
    segments: activeSegment ? [activeSegment] : scene.speakerSegments,
    featuresUrl,
    clockRef,
    onStartVideo,
    onStopVideo,
    isVideoBuffered,
    ...(analysisWindow === undefined ? {} : { analysisWindow }),
    ...(activeSegment ? { segmentId: activeSegment.id } : {}),
  })

  const { state } = recorder
  const mode = state.context.mode
  const isRecording = state.matches('recording')
  const stopRecording = recorder.stop

  /**
   * Encerra a tomada ao fim da janela da fala.
   *
   * No modo cena inteira quem para a gravação é o fim do vídeo. Aqui o vídeo
   * segue rodando, então o limite precisa ser observado — senão a tomada
   * invadiria a fala seguinte, que é de outra pessoa.
   */
  useEffect(() => {
    if (!isRecording || !analysisWindow || !video) return

    let rafId = requestAnimationFrame(function tick() {
      if (video.currentTime * 1000 >= analysisWindow.endMs) {
        stopRecording()
        return
      }
      rafId = requestAnimationFrame(tick)
    })

    return () => {
      cancelAnimationFrame(rafId)
    }
  }, [isRecording, analysisWindow, video, stopRecording])

  /**
   * Registra a tomada na sessão de dueto e passa a vez.
   *
   * O gatilho é a tomada existir no histórico, não o clique em parar: assim
   * uma gravação recusada por estar inaudível (§100) não consome o turno.
   */
  useEffect(() => {
    if (takeMode !== 'duet' || !duet || !duetSegment) return
    const owner = segmentOwner(duetSegment, duet.players)
    if (!owner) return

    const hasTake = recorder.attempts.some((attempt) => attempt.segmentId === duetSegment.id)
    if (!hasTake) return

    setDuet((current) =>
      current && current.takes[duetSegment.id] === undefined
        ? recordTake(current, duetSegment.id, owner.id)
        : current,
    )
  }, [takeMode, duet, duetSegment, recorder.attempts])

  /** Nota de cada fala, para o placar do dueto. */
  const scoreBySegment = useMemo(() => bestScoreBySegment(recorder.attempts), [recorder.attempts])

  /** Melhor tomada por fala, para o navegador mostrar o progresso. */
  const takesBySegment = useMemo(() => takeStatesBySegment(recorder.attempts), [recorder.attempts])

  /** No modo fala-a-fala, o histórico mostrado é o da fala corrente. */
  const visibleAttempts = useMemo(
    () => visibleAttemptsFor(recorder.attempts, activeSegment?.id),
    [recorder.attempts, activeSegment],
  )

  // §64 — atalhos de teclado. Ignorados quando o foco está num campo de texto.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return

      if (event.key === 'Escape') {
        if (state.matches('countdown')) recorder.cancel()
        else if (state.matches('recording')) recorder.stop()
      }
      if (event.key.toLowerCase() === 'r' && state.matches('idle')) {
        event.preventDefault()
        void recorder.requestDub()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [recorder, state])

  // `null` enquanto a detecção não rodou no cliente. Renderizar o painel antes
  // disso divergiria do HTML do servidor e quebraria a hidratação.
  if (recorder.supported === null) {
    return <p className="font-display text-lg uppercase text-muted">Preparando…</p>
  }

  if (!recorder.supported) {
    return <ErrorState code="BROWSER_UNSUPPORTED" className="text-paper" />
  }

  if (state.matches('failed') && state.context.errorCode) {
    return (
      <ErrorState
        code={state.context.errorCode}
        className="text-paper"
        onRetry={() => {
          recorder.retry()
        }}
        secondary={
          <Button
            variant="secondary"
            onClick={() => {
              recorder.send({ type: 'RESET' })
            }}
          >
            Voltar
          </Button>
        }
      />
    )
  }

  return (
    <div
      className="flex flex-col gap-6"
      data-testid="dub-panel"
      data-state={typeof state.value === 'string' ? state.value : JSON.stringify(state.value)}
    >
      {recorder.storageError ? (
        <p className="border-2 border-warn px-3 py-2 text-xs text-warn">
          Não conseguimos guardar esta gravação no seu aparelho, mas ela continua disponível
          enquanto esta página estiver aberta.
        </p>
      ) : null}

      {state.matches('countdown') ? (
        <Countdown value={state.context.countdown} onCancel={recorder.cancel} />
      ) : null}

      {(state.matches('idle') || state.matches('preview')) && orderedSegments.length > 1 && (
        <fieldset className="flex flex-col gap-3">
          <legend className="font-body text-[0.6875rem] font-bold uppercase tracking-[0.16em] text-muted">
            Como gravar
          </legend>
          <div className="flex flex-wrap gap-2">
            {(
              [
                { value: 'full', label: 'Cena inteira' },
                { value: 'segment', label: 'Fala a fala' },
                ...(duetAvailable ? [{ value: 'duet', label: 'Em dupla' } as const] : []),
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={takeMode === option.value}
                data-testid={`take-mode-${option.value}`}
                onClick={() => {
                  setTakeMode(option.value)
                }}
                className={`min-h-11 border-2 px-4 font-display text-sm uppercase tracking-widest ${
                  takeMode === option.value
                    ? 'border-accent bg-accent text-paper'
                    : 'border-ink-line hover:border-paper'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="text-sm text-muted">
            {takeMode === 'segment'
              ? 'Cada fala é gravada e avaliada separadamente. Você repete só a que não ficou boa.'
              : takeMode === 'duet'
                ? 'Dois jogadores no mesmo aparelho, revezando as falas até fechar a cena.'
                : 'Uma tomada do começo ao fim da cena.'}
          </p>
          {!duetAvailable && orderedSegments.length > 1 ? (
            <p className="text-xs text-muted">
              O modo em dupla precisa de uma cena com dois personagens ou mais.
            </p>
          ) : null}
        </fieldset>
      )}

      {takeMode === 'duet' && !duet ? (
        <DuetSetup
          sceneId={scene.id}
          characters={scene.characters}
          onStart={(session) => {
            setDuet(session)
          }}
        />
      ) : null}

      {takeMode === 'duet' && duet && !duetFinished ? (
        <DuetTurn
          session={duet}
          segments={orderedSegments}
          characters={scene.characters}
          currentSegment={duetSegment ?? null}
          onReset={() => {
            setDuet(null)
            recorder.send({ type: 'RESET' })
          }}
        />
      ) : null}

      {takeMode !== 'full' && (state.matches('idle') || state.matches('preview')) ? (
        <StitchedPlayback
          attempts={recorder.attempts}
          segments={orderedSegments}
          durationMs={scene.durationMs}
          video={video}
        />
      ) : null}

      {takeMode === 'duet' && duet && duetFinished ? (
        <DuetSummary
          session={duet}
          segments={orderedSegments}
          scoreBySegment={scoreBySegment}
          onRestart={() => {
            setDuet(null)
            recorder.send({ type: 'RESET' })
          }}
        />
      ) : null}

      {takeMode === 'segment' && bySegment && (state.matches('idle') || state.matches('preview')) ? (
        <SegmentNavigator
          segments={orderedSegments}
          characters={scene.characters}
          activeIndex={activeSegmentIndex}
          takes={takesBySegment}
          onSelect={(index) => {
            setActiveSegmentIndex(index)
            recorder.send({ type: 'RESET' })
          }}
        />
      ) : null}

      {(state.matches('idle') || state.matches('preview')) && (
        <fieldset className="flex flex-col gap-3">
          <legend className="font-body text-[0.6875rem] font-bold uppercase tracking-[0.16em] text-muted">
            Modo
          </legend>
          <div className="flex flex-wrap gap-2">
            {MODES.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={mode === option.value}
                onClick={() => {
                  recorder.setMode(option.value)
                }}
                className={`min-h-11 border-2 px-4 font-display text-sm uppercase tracking-widest ${
                  mode === option.value
                    ? 'border-accent bg-accent text-paper'
                    : 'border-ink-line hover:border-paper'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="text-sm text-muted">
            {MODES.find((option) => option.value === mode)?.hint}
          </p>
        </fieldset>
      )}

      {(state.matches('preparing') ||
        state.matches('countdown') ||
        state.matches('recording')) && (
        <LevelMeter peak={recorder.level} recording={state.matches('recording')} />
      )}

      {state.matches('idle') && !duetFinished && !(takeMode === 'duet' && !duet) ? (
        <div className="flex flex-col gap-3">
          <Button
            size="hero"
            data-testid="start-dub"
            onClick={() => {
              void recorder.requestDub()
            }}
          >
            {activeSegment
              ? `● Dublar a fala ${String(activeSegmentIndex + 1)}`
              : '● Dublar esta cena'}
          </Button>
          <p className="text-xs text-muted">
            Vamos pedir seu microfone. Nada é enviado — a gravação e a análise acontecem no seu
            aparelho.
          </p>
        </div>
      ) : null}

      {state.matches('requestingPermission') ? (
        <p className="font-display text-lg uppercase">Aguardando o microfone…</p>
      ) : null}

      {state.matches('preparing') ? (
        <div className="flex flex-col gap-2">
          <p className="font-display text-lg uppercase">Preparando…</p>
          <ul className="flex flex-wrap gap-2 text-xs">
            <GuardChip ok={state.context.guards.micLive} label="Microfone" />
            <GuardChip ok={state.context.guards.contextRunning} label="Áudio" />
            <GuardChip ok={state.context.guards.videoBuffered} label="Vídeo carregado" />
            <GuardChip ok={state.context.guards.visible} label="Aba visível" />
          </ul>
          <p className="text-xs text-muted">
            A contagem só começa quando tudo estiver pronto — assim o vídeo não trava no meio da
            sua dublagem.
          </p>
        </div>
      ) : null}

      {state.matches('recording') ? (
        <Button size="hero" variant="danger" data-testid="stop-dub" onClick={recorder.stop}>
          ■ Parar
        </Button>
      ) : null}

      {state.matches('stopping') || state.matches('analyzing') ? (
        <p className="font-display text-lg uppercase">
          {state.matches('stopping') ? 'Finalizando…' : 'Analisando sua voz…'}
        </p>
      ) : null}

      {state.matches('preview') && recorder.currentAttempt && !duetFinished ? (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-3">
            <Tag tone="accent">Tentativa {recorder.currentAttempt.attemptNumber}</Tag>
            {recorder.bestAttempt?.attemptNumber === recorder.currentAttempt.attemptNumber &&
            visibleAttempts.length > 1 ? (
              <Tag tone="ok">Melhor até agora</Tag>
            ) : null}
            {!state.context.continuityOk ? <Tag tone="warn">Aba saiu de foco</Tag> : null}
          </div>

          <AttemptPlayback attempt={recorder.currentAttempt} video={video} />

          {recorder.currentAttempt.result ? (
            <ScoreCard result={recorder.currentAttempt.result} />
          ) : state.context.errorCode === 'ANALYSIS_FAILED' ? (
            <ErrorState code="ANALYSIS_FAILED" className="text-paper" />
          ) : null}

          <div className="flex flex-wrap gap-3">
            {/* O bloco inteiro já é escondido quando o dueto fecha, então
                aqui só importa o modo. */}
            {takeMode === 'duet' ? (
              // No dueto o turno já avançou quando o resultado aparece; um
              // "tentar novamente" aqui gravaria a fala do OUTRO jogador.
              // A troca de mãos é explícita: o aparelho passa junto do botão.
              <Button
                size="lg"
                data-testid="duet-pass"
                onClick={() => {
                  recorder.send({ type: 'RESET' })
                }}
              >
                {duetSegment && duet
                  ? `Passar a vez — ${segmentOwner(duetSegment, duet.players)?.name ?? 'próximo'}`
                  : 'Continuar'}
              </Button>
            ) : (
              <Button
                size="lg"
                onClick={() => {
                  recorder.retry()
                }}
              >
                Tentar novamente
              </Button>
            )}
          </div>

          {visibleAttempts.length > 1 ? (
            <section className="border-t-2 border-ink-line pt-4">
              <h3 className="font-body text-[0.6875rem] font-bold uppercase tracking-[0.16em] text-muted">
                Suas tentativas
              </h3>
              <ol className="mt-3 flex flex-col gap-1">
                {visibleAttempts.map((attempt) => (
                  <li
                    key={attempt.attemptNumber}
                    className="flex items-baseline justify-between gap-4 border-b border-ink-line py-1"
                  >
                    <span className="font-display text-sm uppercase">
                      Tentativa {attempt.attemptNumber}
                    </span>
                    <span className="font-display text-xl tabular-nums">
                      {attempt.result?.overall.value === null ||
                      attempt.result?.overall.value === undefined
                        ? '—'
                        : Math.round(attempt.result.overall.value)}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </div>
      ) : null}

      {recorder.devices.length > 1 && (state.matches('idle') || state.matches('preview')) ? (
        <label className="flex flex-col gap-2">
          <span className="font-body text-[0.6875rem] font-bold uppercase tracking-[0.16em] text-muted">
            Microfone
          </span>
          <select
            value={recorder.deviceId ?? ''}
            onChange={(event) => {
              recorder.setDeviceId(event.target.value || undefined)
            }}
            className="min-h-11 border-2 border-ink-line bg-ink-soft px-3 font-body text-sm text-paper"
          >
            <option value="">Padrão do sistema</option>
            {recorder.devices.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  )
}

function GuardChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li
      className={`border-2 px-2 py-0.5 font-display uppercase tracking-widest ${
        ok ? 'border-ok text-ok' : 'border-ink-line text-muted'
      }`}
    >
      {ok ? '✓' : '…'} {label}
    </li>
  )
}
