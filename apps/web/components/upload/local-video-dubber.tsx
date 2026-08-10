'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useMediaClock } from '@dubla/audio'
import { formatTimecode } from '@dubla/shared'
import { Button, ErrorState, ScoreCard, Tag } from '@dubla/ui'
import { AttemptPlayback } from '@/components/dub/attempt-playback'
import { Countdown } from '@/components/dub/countdown'
import { LevelMeter } from '@/components/dub/level-meter'
import { VideoPlayer, type VideoPlayerHandle } from '@/components/scene/video-player'
import { Waveform } from '@/components/scene/waveform'
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
            MP4 · WebM · MOV · até 60 s e 250 MB
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

  const startVideo = useCallback(async () => {
    const player = playerRef.current
    if (!player) return false
    player.restart()
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
    segments: reference?.segments ?? [],
    referenceFeatures: reference?.referenceFeatures,
    skipAnalysis: reference === null,
    liveWaveformDurationMs: selected.durationMs,
    clockRef,
    onStartVideo: startVideo,
    onStopVideo: stopVideo,
    isVideoBuffered,
  })

  const { state } = recorder
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

        {state.matches('idle') && recorder.supported ? (
          <div className="flex flex-col gap-3">
            <Button
              size="hero"
              data-testid="local-start-dub"
              onClick={() => {
                void recorder.requestDub()
              }}
            >
              ● Começar a dublar{reference ? ' e pontuar' : ''}
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

        {state.matches('preview') && recorder.currentAttempt ? (
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
            <Button size="lg" disabled={exportingVideo} onClick={recorder.retry}>
              Gravar novamente
            </Button>
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
