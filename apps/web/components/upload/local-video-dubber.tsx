'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMediaClock } from '@dubla/audio'
import { formatTimecode, type Character, type SubtitleSegment } from '@dubla/shared'
import { Button, ErrorState, ScoreCard, Tag } from '@dubla/ui'
import { AttemptPlayback } from '@/components/dub/attempt-playback'
import { Countdown } from '@/components/dub/countdown'
import { DuetSetup, DuetSummary, DuetTurn } from '@/components/dub/duet-panel'
import { LevelMeter } from '@/components/dub/level-meter'
import { SegmentNavigator } from '@/components/dub/segment-navigator'
import { StitchedPlayback } from '@/components/dub/stitched-playback'
import { SubtitleRenderer } from '@/components/scene/subtitle-renderer'
import { VideoPlayer, type VideoPlayerHandle } from '@/components/scene/video-player'
import { Waveform } from '@/components/scene/waveform'
import {
  isComplete,
  MIN_DUET_CHARACTERS,
  nextPendingIndex,
  playableSegments,
  recordTake,
  segmentOwner,
  type DuetSession,
} from '@/lib/duet-session'
import {
  analysisWindowFor,
  bestScoreBySegment,
  orderSegments,
  takeStatesBySegment,
  type TakeMode,
} from '@/lib/take-modes'
import { useRecorder } from '@/lib/use-recorder'
import {
  createLocalVideoId,
  type LocalVideoMetadata,
  validateLocalVideoFile,
  validateLocalVideoMetadata,
} from '@/lib/local-video'
import { prepareVideoReference, type VideoReference } from '@/lib/prepare-video-reference'
import { downloadRemoteVideo, validateRemoteVideoUrl } from '@/lib/remote-video'
import { DubbedVideoExport } from './dubbed-video-export'

interface SelectedVideo extends LocalVideoMetadata {
  readonly id: string
  readonly fileName: string
  readonly fileSize: number
  readonly url: string
  readonly sourceKind: 'file' | 'url'
  readonly reference: VideoReference
}

interface SelectionRequest {
  readonly id: number
  readonly controller: AbortController
}

export function LocalVideoDubber() {
  const selectionRequestRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const [selected, setSelected] = useState<SelectedVideo | null>(null)
  const [remoteUrl, setRemoteUrl] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stageLocked, setStageLocked] = useState(false)
  const busy = status !== null
  const selectionDisabled = busy || stageLocked

  useEffect(() => {
    return () => {
      selectionRequestRef.current += 1
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => {
      if (selected) URL.revokeObjectURL(selected.url)
    }
  }, [selected])

  const beginSelection = (initialStatus: string): SelectionRequest => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const id = selectionRequestRef.current + 1
    selectionRequestRef.current = id
    setError(null)
    setStatus(initialStatus)
    return { id, controller }
  }

  const adoptVideo = async (
    file: File,
    sourceKind: SelectedVideo['sourceKind'],
    request: SelectionRequest,
  ) => {
    const fileError = validateLocalVideoFile(file)
    if (fileError) throw new Error(fileError)

    const url = URL.createObjectURL(file)
    let adopted = false
    try {
      setStatus('Lendo os metadados do vídeo…')
      const metadata = await readVideoMetadata(url, request.controller.signal)
      if (selectionRequestRef.current !== request.id) return

      const metadataError = validateLocalVideoMetadata(metadata)
      if (metadataError) throw new Error(metadataError)

      const id = await createLocalVideoId(file, metadata.durationMs)
      if (request.controller.signal.aborted || selectionRequestRef.current !== request.id) return
      setStatus('Extraindo e analisando o áudio de referência…')
      const reference = await prepareVideoReference(
        file,
        id,
        metadata.durationMs,
        request.controller.signal,
      )
      if (selectionRequestRef.current !== request.id) return

      setSelected({
        ...metadata,
        id,
        fileName: file.name,
        fileSize: file.size,
        url,
        sourceKind,
        reference,
      })
      adopted = true
    } finally {
      if (!adopted) URL.revokeObjectURL(url)
    }
  }

  const finishSelection = (request: SelectionRequest) => {
    if (selectionRequestRef.current !== request.id) return
    if (abortRef.current === request.controller) abortRef.current = null
    setStatus(null)
  }

  const showSelectionError = (cause: unknown, request: SelectionRequest) => {
    if (selectionRequestRef.current !== request.id) return
    if (cause instanceof DOMException && cause.name === 'AbortError') return
    setError(cause instanceof Error ? cause.message : 'Não conseguimos preparar esse vídeo.')
  }

  const cancelSelection = () => {
    const controller = abortRef.current
    if (!controller) return

    // `Blob.arrayBuffer()` e `decodeAudioData()` não podem ser interrompidos.
    // Invalidar a requisição libera a interface imediatamente e impede que o
    // resultado tardio seja adotado quando essas APIs finalmente terminarem.
    selectionRequestRef.current += 1
    abortRef.current = null
    controller.abort()
    setStatus(null)
  }

  const selectFile = async (file: File | undefined) => {
    if (!file) return
    const request = beginSelection('Preparando o arquivo local…')
    try {
      await adoptVideo(file, 'file', request)
    } catch (cause) {
      showSelectionError(cause, request)
    } finally {
      finishSelection(request)
    }
  }

  const selectUrl = async () => {
    const urlError = validateRemoteVideoUrl(remoteUrl)
    if (urlError) {
      setError(urlError)
      return
    }

    const request = beginSelection('Baixando o vídeo da URL…')
    try {
      const file = await downloadRemoteVideo(remoteUrl, {
        signal: request.controller.signal,
        onProgress: (progress) => {
          if (selectionRequestRef.current !== request.id) return
          setStatus(
            progress === null
              ? 'Baixando o vídeo da URL…'
              : `Baixando o vídeo da URL… ${String(Math.min(100, Math.floor(progress * 10) * 10))}%`,
          )
        },
      })
      setRemoteUrl('')
      await adoptVideo(file, 'url', request)
    } catch (cause) {
      showSelectionError(cause, request)
    } finally {
      finishSelection(request)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-5 lg:grid-cols-[1fr_auto_1fr] lg:items-stretch">
        <label
          className="group flex min-h-52 cursor-pointer flex-col items-center justify-center gap-4 border-2 border-dashed border-ink p-6 text-center hover:bg-ink hover:text-paper"
          data-testid="local-video-dropzone"
        >
          <input
            type="file"
            accept="video/*,.mp4,.webm,.mov,.m4v"
            className="sr-only"
            data-testid="local-video-input"
            disabled={selectionDisabled}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              void selectFile(file)
            }}
          />
          <span className="font-display text-4xl uppercase text-accent group-hover:text-accent">
            {selected ? 'Trocar arquivo' : 'Escolher arquivo'}
          </span>
          <span className="max-w-xl text-sm opacity-75">
            Selecione uma cena do computador. O arquivo não é enviado para servidor.
          </span>
          <span className="font-display text-xs uppercase tracking-[0.18em] opacity-60">
            MP4 · WebM · MOV · até 5 min e 1 GB
          </span>
        </label>

        <div className="flex items-center justify-center font-display text-xl uppercase opacity-50">
          ou
        </div>

        <form
          className="flex min-h-52 flex-col justify-center gap-4 border-2 border-ink p-6"
          onSubmit={(event) => {
            event.preventDefault()
            void selectUrl()
          }}
        >
          <label className="flex flex-col gap-2">
            <span className="font-display text-3xl uppercase">URL direta</span>
            <input
              type="url"
              value={remoteUrl}
              disabled={selectionDisabled}
              data-testid="remote-video-url"
              placeholder="https://exemplo.com/cena.mp4"
              onChange={(event) => {
                setRemoteUrl(event.target.value)
              }}
              className="min-h-12 border-2 border-ink bg-paper px-3 text-sm text-ink placeholder:text-muted"
            />
          </label>
          <Button
            type="submit"
            size="lg"
            disabled={selectionDisabled || remoteUrl.trim().length === 0}
          >
            Processar URL
          </Button>
          <p className="text-xs opacity-70">
            Precisa ser o link direto de um MP4, WebM ou MOV com CORS. Links de páginas do YouTube,
            TikTok, Instagram ou Drive não funcionam neste modo.
          </p>
        </form>
      </div>

      {status ? (
        <div
          className="flex flex-wrap items-center gap-3"
          aria-live="polite"
          aria-atomic="true"
        >
          <p className="font-display text-lg uppercase">{status}</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={cancelSelection}
          >
            Cancelar
          </Button>
        </div>
      ) : null}

      {error ? (
        <p className="border-2 border-danger px-4 py-3 text-danger" role="alert">
          {error}
        </p>
      ) : null}

      {selected ? (
        <div
          aria-busy={busy}
          inert={busy}
          className={busy ? 'pointer-events-none opacity-60' : undefined}
        >
          <LocalDubStage
            key={selected.id}
            selected={selected}
            onInteractionLockChange={setStageLocked}
          />
        </div>
      ) : null}
    </div>
  )
}

function LocalDubStage({
  selected,
  onInteractionLockChange,
}: {
  selected: SelectedVideo
  onInteractionLockChange: (locked: boolean) => void
}) {
  const playerRef = useRef<VideoPlayerHandle | null>(null)
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null)
  const [exportingVideo, setExportingVideo] = useState(false)

  const attachVideo = useCallback((handle: VideoPlayerHandle | null) => {
    playerRef.current = handle
    setVideoElement(handle?.element ?? null)
  }, [])

  const { clockRef, mediaTimeRef } = useMediaClock(videoElement)
  const reference = selected.reference.status === 'ready' ? selected.reference : null
  const unavailableReason =
    selected.reference.status === 'unavailable' ? selected.reference.reason : null

  const [takeMode, setTakeMode] = useState<TakeMode>('full')
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(0)
  const [duet, setDuet] = useState<DuetSession | null>(null)

  /**
   * Falas digitadas pela pessoa, por trecho detectado.
   *
   * Não existe transcrição automática aqui — o projeto decidiu não usar STT, e
   * mandar o áudio para um serviço externo quebraria a promessa de que nada
   * sai do aparelho. O texto vem de quem conhece a cena, e fica guardado por
   * vídeo para sobreviver a recarregar a página.
   */
  const [texts, setTexts] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem(`dublaai:falas:${selected.id}`)
      return raw ? (JSON.parse(raw) as Record<string, string>) : {}
    } catch {
      return {}
    }
  })
  const updateText = useCallback(
    (segmentId: string, text: string) => {
      setTexts((previous) => {
        const next = { ...previous, [segmentId]: text }
        try {
          localStorage.setItem(`dublaai:falas:${selected.id}`, JSON.stringify(next))
        } catch {
          // Sem espaço para guardar não pode impedir de digitar.
        }
        return next
      })
    },
    [selected.id],
  )

  /** Trechos em ordem, com o texto digitado no lugar do rótulo genérico. */
  const orderedSegments = useMemo(() => {
    const base = reference ? orderSegments(reference.segments) : []
    return base.map((segment) => {
      const typed = texts[segment.id]?.trim()
      return typed !== undefined && typed.length > 0 ? { ...segment, text: typed } : segment
    })
  }, [reference, texts])

  /**
   * Personagens derivados das vozes detectadas.
   *
   * A detecção é estimativa (vozes parecidas e música quebram o método), por
   * isso os nomes são genéricos e as falas continuam funcionando mesmo que a
   * contagem esteja errada.
   */
  const characters = useMemo<Character[]>(() => {
    const ids = [...new Set(orderedSegments.map((segment) => segment.characterId))]
    const patterns = ['solid', 'stripes', 'dots', 'grid'] as const
    return ids.map((id, index) => ({
      id,
      workId: selected.id,
      name: id === 'reference-voice' ? 'VOZ' : `VOZ ${id.replace('voz-', '')}`,
      colorToken: `character-${String((index % 6) + 1)}`,
      patternToken: patterns[index % patterns.length] ?? 'solid',
    }))
  }, [orderedSegments, selected.id])

  const duetAvailable = characters.length >= MIN_DUET_CHARACTERS

  /** No dueto, a fala da vez é decidida pelo rodízio, não pela pessoa. */
  const duetSegment = useMemo(() => {
    if (takeMode !== 'duet' || !duet) return undefined
    const playable = playableSegments(orderedSegments, duet.players)
    const index = nextPendingIndex(orderedSegments, duet)
    return index === -1 ? undefined : playable[index]
  }, [takeMode, duet, orderedSegments])

  const duetFinished = takeMode === 'duet' && duet !== null && isComplete(orderedSegments, duet)

  const activeSegment =
    takeMode === 'segment'
      ? (orderedSegments[activeSegmentIndex] ?? orderedSegments[0])
      : takeMode === 'duet'
        ? duetSegment
        : undefined

  const analysisWindow = useMemo(
    () => (activeSegment ? analysisWindowFor(activeSegment, selected.durationMs) : undefined),
    [activeSegment, selected.durationMs],
  )

  /**
   * Avança para a próxima fala sem obrigar a rolar a página.
   *
   * Dublar trecho a trecho é um ciclo curto e repetitivo: gravar, ouvir,
   * seguir. Se a única forma de trocar de fala for subir até a lista, o modo
   * fala-a-fala fica cansativo justamente onde deveria ser ágil.
   */
  const goToSegment = useCallback(
    (index: number) => {
      setActiveSegmentIndex(index)
      recorderResetRef.current?.()
    },
    [],
  )
  const recorderResetRef = useRef<(() => void) | null>(null)

  const nextPendingSegmentIndex = useCallback(
    (fromIndex: number, recorded: Record<string, unknown>) => {
      // Primeiro procura adiante; depois volta ao começo, para fechar as que
      // ficaram para trás sem obrigar a pessoa a caçá-las na lista.
      for (let index = fromIndex + 1; index < orderedSegments.length; index += 1) {
        const segment = orderedSegments[index]
        if (segment && recorded[segment.id] === undefined) return index
      }
      for (let index = 0; index <= fromIndex; index += 1) {
        const segment = orderedSegments[index]
        if (segment && recorded[segment.id] === undefined) return index
      }
      return -1
    },
    [orderedSegments],
  )

  /** Legendas sincronizadas: só os trechos em que a pessoa digitou o texto. */
  const subtitles = useMemo<SubtitleSegment[]>(
    () =>
      orderedSegments
        .filter((segment) => texts[segment.id]?.trim())
        .map((segment) => ({
          id: `${segment.id}--sub`,
          sceneId: selected.id,
          speakerSegmentId: segment.id,
          startMs: segment.startMs,
          endMs: segment.endMs,
          text: segment.text,
        })),
    [orderedSegments, texts, selected.id],
  )

  const startVideo = useCallback(async (fromMs: number) => {
    const player = playerRef.current
    if (!player) return false
    // No modo fala-a-fala a tomada não começa no zero da cena.
    if (fromMs > 0) player.seekMs(fromMs)
    else player.restart()
    player.setMuted(true)
    try {
      await player.play()
      return true
    } catch {
      player.setMuted(false)
      return false
    }
  }, [])

  const stopVideo = useCallback(() => {
    playerRef.current?.pause()
    playerRef.current?.setMuted(false)
  }, [])

  const seekVideo = useCallback((ms: number) => {
    playerRef.current?.seekMs(ms)
  }, [])

  const isVideoBuffered = useCallback(() => {
    const video = playerRef.current?.element
    if (!video) return false
    return (
      video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA ||
      (playerRef.current?.isBuffered(0, Math.min(selected.durationMs, 10_000)) ?? false)
    )
  }, [selected.durationMs])

  const recorder = useRecorder({
    sceneId: selected.id,
    // Nos modos por fala, só a fala corrente é pontuada; nada é afirmado
    // sobre o que a pessoa não gravou.
    segments: activeSegment ? [activeSegment] : orderedSegments,
    referenceFeatures: reference?.referenceFeatures,
    skipAnalysis: reference === null,
    liveWaveformDurationMs: selected.durationMs,
    clockRef,
    onStartVideo: startVideo,
    onStopVideo: stopVideo,
    isVideoBuffered,
    ...(analysisWindow === undefined ? {} : { analysisWindow }),
    ...(activeSegment ? { segmentId: activeSegment.id } : {}),
  })

  const { state } = recorder
  const isRecording = state.matches('recording')
  const stopRecording = recorder.stop

  /**
   * Encerra a tomada ao fim da janela da fala (o vídeo segue rodando; sem
   * este limite, a tomada invadiria a fala seguinte).
   */
  useEffect(() => {
    if (!isRecording || !analysisWindow || !videoElement) return
    let rafId = requestAnimationFrame(function tick() {
      if (videoElement.currentTime * 1000 >= analysisWindow.endMs) {
        stopRecording()
        return
      }
      rafId = requestAnimationFrame(tick)
    })
    return () => {
      cancelAnimationFrame(rafId)
    }
  }, [isRecording, analysisWindow, videoElement, stopRecording])

  /** Registra a tomada no dueto e passa a vez (§100: inaudível não consome turno). */
  useEffect(() => {
    if (takeMode !== 'duet' || !duet || !duetSegment) return
    const owner = segmentOwner(duetSegment, duet.players)
    if (!owner) return
    if (!recorder.attempts.some((attempt) => attempt.segmentId === duetSegment.id)) return
    setDuet((current) =>
      current && current.takes[duetSegment.id] === undefined
        ? recordTake(current, duetSegment.id, owner.id)
        : current,
    )
  }, [takeMode, duet, duetSegment, recorder.attempts])

  const scoreBySegment = useMemo(() => bestScoreBySegment(recorder.attempts), [recorder.attempts])
  const takesBySegment = useMemo(() => takeStatesBySegment(recorder.attempts), [recorder.attempts])

  // O navegador de falas precisa reiniciar a máquina, mas ele é declarado
  // antes do recorder existir; o ref costura os dois sem inverter a ordem.
  const sendRecorder = recorder.send
  useEffect(() => {
    recorderResetRef.current = () => {
      sendRecorder({ type: 'RESET' })
    }
  }, [sendRecorder])

  const liveWaveformActive =
    state.matches('preparing') || state.matches('countdown') || state.matches('recording')
  const workflowLocked =
    state.matches('requestingPermission') ||
    state.matches('preparing') ||
    state.matches('countdown') ||
    state.matches('recording') ||
    state.matches('stopping') ||
    state.matches('analyzing')
  const mediaInteractionLocked = workflowLocked || exportingVideo

  useEffect(() => {
    onInteractionLockChange(mediaInteractionLocked)
  }, [mediaInteractionLocked, onInteractionLockChange])

  useEffect(() => {
    return () => {
      onInteractionLockChange(false)
    }
  }, [onInteractionLockChange])

  return (
    <section className="surface-dark -mx-4 flex flex-col gap-6 px-4 py-8 sm:-mx-8 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="font-body text-xs font-bold uppercase tracking-[0.16em] text-muted">
            {selected.sourceKind === 'url' ? 'Cena recebida por URL' : 'Cena do computador'}
          </p>
          <h2 className="mt-1 truncate font-display text-3xl uppercase" title={selected.fileName}>
            {selected.fileName}
          </h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <Tag tone="accent">{formatTimecode(selected.durationMs)}</Tag>
          <Tag>{formatFileSize(selected.fileSize)}</Tag>
          <Tag tone={reference ? 'ok' : 'warn'}>
            {reference ? 'Referência analisada' : 'Sem referência sonora'}
          </Tag>
        </div>
      </div>

      <VideoPlayer
        ref={attachVideo}
        src={selected.url}
        durationMs={selected.durationMs}
        title={`Vídeo para dublagem: ${selected.fileName}`}
        controlsHidden={mediaInteractionLocked}
        onEnded={() => {
          recorder.send({ type: 'VIDEO_ENDED' })
        }}
      />

      {subtitles.length > 0 ? (
        <SubtitleRenderer
          subtitles={subtitles}
          speakerSegments={orderedSegments}
          characters={characters}
          mediaTimeRef={mediaTimeRef}
        />
      ) : null}

      {reference ? (
        <section className="flex flex-col gap-3" aria-labelledby="referencia-enviada-titulo">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="referencia-enviada-titulo" className="font-display text-2xl uppercase">
                Referência vocal
              </h2>
              <p className="mt-1 text-xs text-muted">
                A onda segue a cena. Durante a dublagem, sua voz real aparece em verde por cima.
              </p>
            </div>
            <Tag tone={reference.speechRatio >= 0.08 ? 'ok' : 'warn'}>
              {reference.segments.length === 1
                ? '1 trecho detectado'
                : `${String(reference.segments.length)} trechos detectados`}
            </Tag>
          </div>

          <div className="h-24 border-2 border-ink-line bg-ink-soft">
            <Waveform
              peaks={reference.peaks}
              durationMs={selected.durationMs}
              mediaTimeRef={mediaTimeRef}
              liveOverlayRef={recorder.liveWaveformRef}
              liveOverlayActive={liveWaveformActive}
              onSeek={mediaInteractionLocked ? undefined : seekVideo}
              label={
                liveWaveformActive
                  ? 'Forma de onda da referência com sua voz ao vivo'
                  : 'Forma de onda da referência do vídeo enviado'
              }
            />
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted" aria-label="Legenda da onda">
            <span className="inline-flex items-center gap-2">
              <span className="h-2 w-5 bg-muted" aria-hidden="true" /> Referência
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="h-2 w-5 bg-ok" aria-hidden="true" /> Sua voz ao vivo
            </span>
          </div>
          <p className="text-xs text-muted">
            A pontuação compara sua voz com o áudio completo do vídeo. Música, efeitos e várias
            pessoas podem reduzir a precisão. Articulação fica indisponível porque esta cena não
            possui o corpus necessário para uma calibração honesta.
          </p>
        </section>
      ) : (
        <p className="border-2 border-warn px-4 py-3 text-sm text-warn" role="status">
          {unavailableReason}
        </p>
      )}

      <div
        className="flex flex-col gap-5 border-t-2 border-ink-line pt-6"
        data-testid="local-dub-panel"
        data-state={typeof state.value === 'string' ? state.value : JSON.stringify(state.value)}
      >
        <div>
          <h2 className="font-display text-title uppercase">Grave a sua dublagem</h2>
          <p className="mt-2 max-w-2xl text-sm text-muted">
            O áudio original fica mudo durante a gravação. Fale junto com a cena; depois você poderá
            ouvir, receber as pontuações disponíveis e baixar o vídeo com a sua voz.
          </p>
        </div>

        {recorder.storageError ? (
          <p className="border-2 border-warn px-3 py-2 text-xs text-warn">
            A gravação continua nesta aba, mas não conseguimos salvá-la no armazenamento local.
          </p>
        ) : null}

        {recorder.supported === null ? (
          <p className="font-display text-lg uppercase text-muted">Preparando…</p>
        ) : null}

        {recorder.supported === false ? (
          <ErrorState code="BROWSER_UNSUPPORTED" className="text-paper" />
        ) : null}

        {state.matches('failed') && state.context.errorCode ? (
          <ErrorState
            code={state.context.errorCode}
            className="text-paper"
            onRetry={() => {
              recorder.send({ type: 'RESET' })
            }}
          />
        ) : null}

        {state.matches('countdown') ? (
          <Countdown value={state.context.countdown} onCancel={recorder.cancel} />
        ) : null}

        {(state.matches('preparing') || state.matches('countdown') || state.matches('recording')) && (
          <LevelMeter peak={recorder.level} recording={state.matches('recording')} />
        )}

        {reference && orderedSegments.length > 1 && (state.matches('idle') || state.matches('preview')) ? (
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
                  data-testid={`local-take-mode-${option.value}`}
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
                ? 'Cada trecho detectado é gravado e avaliado separadamente.'
                : takeMode === 'duet'
                  ? 'Dois jogadores no mesmo aparelho, revezando as vozes detectadas.'
                  : 'Uma tomada do começo ao fim.'}
            </p>
            {!duetAvailable ? (
              <p className="text-xs text-muted">
                O modo em dupla precisa de duas vozes detectadas no vídeo — neste arquivo
                identificamos só uma.
              </p>
            ) : null}
          </fieldset>
        ) : null}

        {reference && (state.matches('idle') || state.matches('preview')) ? (
          <details className="border-2 border-ink-line">
            <summary className="cursor-pointer px-4 py-3 font-display text-sm uppercase tracking-widest">
              Falas da cena ({subtitles.length} de {orderedSegments.length} preenchidas)
            </summary>
            <div className="flex flex-col gap-2 border-t-2 border-ink-line p-4">
              <p className="text-xs text-muted">
                Digite o que é dito em cada trecho para a legenda acompanhar a cena durante a
                dublagem. Nada é transcrito automaticamente — sua cena não sai do aparelho.
              </p>
              {orderedSegments.map((segment, index) => (
                <label key={segment.id} className="flex flex-col gap-1">
                  <span className="font-body text-[0.6875rem] font-bold uppercase tracking-[0.16em] text-muted">
                    {index + 1}. {formatTimecode(segment.startMs)} –{' '}
                    {formatTimecode(segment.endMs)}
                  </span>
                  <input
                    type="text"
                    maxLength={300}
                    value={texts[segment.id] ?? ''}
                    placeholder="O que é dito neste trecho?"
                    data-testid={`local-fala-${String(index)}`}
                    onChange={(event) => {
                      updateText(segment.id, event.target.value)
                    }}
                    className="min-h-11 border-2 border-ink-line bg-ink-soft px-3 font-body text-sm text-paper placeholder:text-muted"
                  />
                </label>
              ))}
            </div>
          </details>
        ) : null}

        {takeMode === 'segment' && activeSegment && (state.matches('idle') || state.matches('preview')) ? (
          <SegmentNavigator
            segments={orderedSegments}
            characters={characters}
            activeIndex={activeSegmentIndex}
            takes={takesBySegment}
            onSelect={goToSegment}
          />
        ) : null}

        {takeMode === 'duet' && !duet ? (
          <DuetSetup
            sceneId={selected.id}
            characters={characters}
            onStart={(session) => {
              setDuet(session)
            }}
          />
        ) : null}

        {takeMode === 'duet' && duet && !duetFinished ? (
          <DuetTurn
            session={duet}
            segments={orderedSegments}
            characters={characters}
            currentSegment={duetSegment ?? null}
            onReset={() => {
              setDuet(null)
              recorder.send({ type: 'RESET' })
            }}
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

        {takeMode !== 'full' && (state.matches('idle') || state.matches('preview')) ? (
          <StitchedPlayback
            attempts={recorder.attempts}
            segments={orderedSegments}
            durationMs={selected.durationMs}
            video={videoElement}
          />
        ) : null}

        {state.matches('idle') && recorder.supported && !duetFinished && !(takeMode === 'duet' && !duet) ? (
          <div className="flex flex-col gap-3">
            <Button
              size="hero"
              data-testid="local-start-dub"
              onClick={() => {
                void recorder.requestDub()
              }}
            >
              {activeSegment
                ? `● Dublar o trecho ${String(orderedSegments.findIndex((entry) => entry.id === activeSegment.id) + 1)}`
                : `● Começar a dublar${reference ? ' e pontuar' : ''}`}
            </Button>
            <p className="text-xs text-muted">
              Vamos pedir acesso ao microfone. Sua voz não é enviada para nenhum servidor.
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
          </div>
        ) : null}

        {state.matches('recording') ? (
          <Button size="hero" variant="danger" data-testid="local-stop-dub" onClick={recorder.stop}>
            ■ Parar
          </Button>
        ) : null}

        {state.matches('stopping') || state.matches('analyzing') ? (
          <p className="font-display text-lg uppercase">
            {state.matches('analyzing') ? 'Analisando sua dublagem…' : 'Finalizando…'}
          </p>
        ) : null}

        {state.matches('preview') && recorder.currentAttempt && !duetFinished ? (
          <div className="flex flex-col gap-6">
            <div
              inert={exportingVideo}
              className={exportingVideo ? 'pointer-events-none opacity-60' : undefined}
            >
              <AttemptPlayback attempt={recorder.currentAttempt} video={videoElement} />
            </div>

            {recorder.currentAttempt.result ? (
              <ScoreCard result={recorder.currentAttempt.result} />
            ) : state.context.errorCode === 'ANALYSIS_FAILED' ? (
              <ErrorState code="ANALYSIS_FAILED" className="text-paper" />
            ) : null}

            <DubbedVideoExport
              key={recorder.currentAttempt.id}
              attempt={recorder.currentAttempt}
              video={videoElement}
              sourceFileName={selected.fileName}
              onExportingChange={setExportingVideo}
            />
            {takeMode === 'segment' && activeSegment ? (
              <Button
                size="lg"
                disabled={exportingVideo}
                data-testid="local-next-segment"
                onClick={() => {
                  const next = nextPendingSegmentIndex(activeSegmentIndex, takesBySegment)
                  goToSegment(next === -1 ? Math.min(activeSegmentIndex + 1, orderedSegments.length - 1) : next)
                }}
              >
                {nextPendingSegmentIndex(activeSegmentIndex, takesBySegment) === -1
                  ? 'Todas as falas gravadas'
                  : 'Próxima fala ▶'}
              </Button>
            ) : null}

            {takeMode === 'duet' ? (
              // No dueto o turno já avançou; regravar aqui pegaria a fala do
              // OUTRO jogador. A troca de mãos é explícita.
              <Button
                size="lg"
                disabled={exportingVideo}
                data-testid="local-duet-pass"
                onClick={() => {
                  recorder.send({ type: 'RESET' })
                }}
              >
                {duetSegment && duet
                  ? `Passar a vez — ${segmentOwner(duetSegment, duet.players)?.name ?? 'próximo'}`
                  : 'Continuar'}
              </Button>
            ) : (
              <Button size="lg" disabled={exportingVideo} onClick={recorder.retry}>
                Gravar novamente
              </Button>
            )}
          </div>
        ) : null}

        {recorder.devices.length > 1 && (state.matches('idle') || state.matches('preview')) ? (
          <label className="flex flex-col gap-2">
            <span className="font-body text-xs font-bold uppercase tracking-[0.16em] text-muted">
              Microfone
            </span>
            <select
              value={recorder.deviceId ?? ''}
              onChange={(event) => {
                recorder.setDeviceId(event.target.value || undefined)
              }}
              className="min-h-11 border-2 border-ink-line bg-ink-soft px-3 text-sm text-paper"
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
    </section>
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

function readVideoMetadata(url: string, signal?: AbortSignal): Promise<LocalVideoMetadata> {
  return new Promise<LocalVideoMetadata>((resolve, reject) => {
    const video = document.createElement('video')
    const timeoutId = setTimeout(() => {
      cleanup()
      reject(new Error('Tempo esgotado ao ler o vídeo.'))
    }, 15_000)

    const cleanup = () => {
      clearTimeout(timeoutId)
      signal?.removeEventListener('abort', onAbort)
      video.onloadedmetadata = null
      video.onerror = null
      video.removeAttribute('src')
      video.load()
    }
    const onAbort = () => {
      cleanup()
      reject(new DOMException('Leitura cancelada.', 'AbortError'))
    }

    video.preload = 'metadata'
    video.muted = true
    video.onloadedmetadata = () => {
      const metadata = {
        durationMs: video.duration * 1_000,
        width: video.videoWidth,
        height: video.videoHeight,
      }
      cleanup()
      resolve(metadata)
    }
    video.onerror = () => {
      cleanup()
      reject(new Error('Não conseguimos abrir esse vídeo. Tente MP4, WebM ou MOV.'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    video.src = url
  })
}

function formatFileSize(bytes: number): string {
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(0)} KB`
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`
}
