'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMediaClock } from '@dubla/audio'
import {
  formatTimecode,
  type Character,
  type SpeakerSegment,
  type SubtitleSegment,
} from '@dubla/shared'
import { Button, ErrorState, ScoreCard, Tag } from '@dubla/ui'
import { AttemptPlayback } from '@/components/dub/attempt-playback'
import { Countdown } from '@/components/dub/countdown'
import { CharacterSetupDialog } from '@/components/dub/character-setup-dialog'
import { LevelMeter } from '@/components/dub/level-meter'
import { SegmentHud, type SegmentPhase } from '@/components/dub/segment-hud'
import { ModePicker } from '@/components/dub/mode-picker'
import { SceneReviewPanel } from '@/components/dub/scene-review-panel'
import { TakeStrip, type TakeStripCell } from '@/components/dub/take-strip'
import { StitchedPlayback } from '@/components/dub/stitched-playback'
import { VideoPlayer, type VideoPlayerHandle } from '@/components/scene/video-player'
import { Waveform } from '@/components/scene/waveform'
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
import { decodeVideoMonoAudio, prepareVideoReference } from '@/lib/prepare-video-reference'
import { assignTranscript, untranscribedCount } from '@/lib/assign-transcript'
import { transcribeReference } from '@/lib/transcribe-reference'
import { assignVoice, segmentsFromTranscript } from '@/lib/segments-from-transcript'
import { isOriginal, type SegmentSource } from '@/lib/segment-sources'
import { OnlineMatchPanel } from '@/components/dub/online-match-panel'
import { useOnlineMatch, type OnlineMatch } from '@/lib/use-online-match'
import type { VideoReference } from '@/lib/prepare-video-reference'
import { downloadRemoteVideo, validateRemoteVideoUrl } from '@/lib/remote-video'
import { DubbedVideoExport } from './dubbed-video-export'

interface SelectedVideo extends LocalVideoMetadata {
  readonly id: string
  readonly fileName: string
  readonly fileSize: number
  readonly url: string
  readonly sourceKind: 'file' | 'url'
  /**
   * Endereço de onde a cena veio, quando veio de um link.
   *
   * Guardado para o modo online: se o anfitrião abriu o vídeo por URL, a
   * partida leva o link, e quem entra baixa da mesma fonte. Sai mais barato e
   * mais rápido do que empurrar o arquivo inteiro pelo nosso servidor.
   */
  readonly sourceUrl?: string
  readonly reference: VideoReference
}

interface SelectionRequest {
  readonly id: number
  readonly controller: AbortController
}

export interface LocalVideoDubberProps {
  readonly experience?: 'solo' | 'multiplayer'
}

export function LocalVideoDubber({ experience = 'solo' }: LocalVideoDubberProps) {
  const multiplayer = experience === 'multiplayer'
  const match = useOnlineMatch(multiplayer)
  const selectionRequestRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const matchDownloadRef = useRef('')
  const autoReadyRef = useRef('')
  const [selected, setSelected] = useState<SelectedVideo | null>(null)
  const [remoteUrl, setRemoteUrl] = useState('')
  const [matchCode, setMatchCode] = useState('')
  const [multiplayerAction, setMultiplayerAction] = useState<'choose' | 'create'>('choose')
  /** O seletor volta à tela só quando a pessoa pede para trocar de vídeo. */
  const [trocandoVideo, setTrocandoVideo] = useState(false)
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

  const beginSelection = useCallback((initialStatus: string): SelectionRequest => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const id = selectionRequestRef.current + 1
    selectionRequestRef.current = id
    setError(null)
    setStatus(initialStatus)
    return { id, controller }
  }, [])

  const adoptVideo = useCallback(
    async (
      file: File,
      sourceKind: SelectedVideo['sourceKind'],
      request: SelectionRequest,
      sourceUrl?: string,
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

        setTrocandoVideo(false)
        setSelected({
          ...metadata,
          id,
          fileName: file.name,
          fileSize: file.size,
          url,
          sourceKind,
          ...(sourceUrl === undefined ? {} : { sourceUrl }),
          reference,
        })
        adopted = true
      } finally {
        if (!adopted) URL.revokeObjectURL(url)
      }
    },
    [],
  )

  const finishSelection = useCallback((request: SelectionRequest) => {
    if (selectionRequestRef.current !== request.id) return
    if (abortRef.current === request.controller) abortRef.current = null
    setStatus(null)
  }, [])

  const showSelectionError = useCallback((cause: unknown, request: SelectionRequest) => {
    if (selectionRequestRef.current !== request.id) return
    if (cause instanceof DOMException && cause.name === 'AbortError') return
    setError(cause instanceof Error ? cause.message : 'Não conseguimos preparar esse vídeo.')
  }, [])

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

  /**
   * Abre um vídeo que chegou pronto, sem passar pelo seletor.
   *
   * É o caminho do modo online: quem entra numa partida recebe o arquivo do
   * anfitrião e cai direto na cena, sem ter de achar o mesmo vídeo no próprio
   * computador.
   */
  const adoptFromMatch = useCallback(
    async (file: File) => {
      const request = beginSelection('Abrindo o vídeo da partida…')
      try {
        await adoptVideo(file, 'file', request)
        return true
      } catch (cause) {
        showSelectionError(cause, request)
        return false
      } finally {
        finishSelection(request)
      }
    },
    [adoptVideo, beginSelection, finishSelection, showSelectionError],
  )

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
      const origem = remoteUrl.trim()
      setRemoteUrl('')
      await adoptVideo(file, 'url', request, origem)
    } catch (cause) {
      showSelectionError(cause, request)
    } finally {
      finishSelection(request)
    }
  }

  // Quem entra com código recebe o vídeo automaticamente. O hook da sala vive
  // acima do stage, então adotar o arquivo não apaga código, vaga nem turno.
  const matchState = match.state
  const pullVideoFromMatch = match.pullVideo
  useEffect(() => {
    const room = matchState
    if (!multiplayer || selected || !room) return
    if (room.videoShared !== true && room.videoUrl === undefined) return
    const downloadKey = `${room.code}:${String(room.videoShared)}:${room.videoUrl ?? ''}`
    if (matchDownloadRef.current === downloadKey) return
    matchDownloadRef.current = downloadKey

    const download = async () => {
      const file = await pullVideoFromMatch(room)
      const adopted = file ? await adoptFromMatch(file) : false
      // Falha transitória não pode condenar este código para sempre. Um novo
      // heartbeat ou uma nova entrada tenta baixar novamente.
      if (!adopted) matchDownloadRef.current = ''
    }
    void download()
  }, [adoptFromMatch, matchState, multiplayer, pullVideoFromMatch, selected])

  // No refresh, o servidor marca este aparelho como preparando antes de
  // devolver a sala. Só o coloca pronto novamente depois que o vídeo local já
  // foi baixado, validado e analisado por inteiro.
  useEffect(() => {
    const room = match.state
    if (!multiplayer || !selected || !room || match.busy) return
    const me = room.players.find((player) => player.id === match.playerId)
    if (!me || me.ready) return
    const key = `${room.code}:${selected.id}:${me.id}`
    if (autoReadyRef.current === key) return
    autoReadyRef.current = key
    void match.ready()
  }, [match, multiplayer, selected])

  const leaveMatchScreen = useCallback(async () => {
    if (!(await match.leave())) return
    matchDownloadRef.current = ''
    autoReadyRef.current = ''
    setMatchCode('')
    setMultiplayerAction('choose')
    setSelected(null)
  }, [match])

  const escolhendo = !selected || trocandoVideo
  const multiplayerLanding =
    multiplayer && !selected && !match.state && multiplayerAction === 'choose'
  const multiplayerWaiting =
    multiplayer && !selected && match.state !== null && multiplayerAction === 'choose'
  const hostNeedsVideo =
    multiplayerWaiting &&
    match.state.hostId === match.playerId &&
    match.state.videoShared !== true &&
    match.state.videoUrl === undefined
  const showVideoPicker = escolhendo && (!multiplayer || multiplayerAction === 'create')

  return (
    /*
      `pb-32` no celular abre espaço para a barra de comando, que fica presa
      no rodapé: sem isso ela cobriria o último bloco da página.
    */
    <div className="flex flex-col gap-6 pb-32 sm:pb-0">
      {selected && !escolhendo ? (
        // Depois que o vídeo entra, o seletor sai da frente. Ele ocupava três
        // telas de celular acima do que a pessoa veio fazer.
        <div className="flex flex-wrap items-center justify-between gap-3 border-2 border-ink-line px-4 py-3">
          <p className="min-w-0 flex-1">
            <span className="block font-body text-[0.6875rem] font-bold uppercase tracking-[0.16em] text-muted">
              {multiplayer ? 'Vídeo da partida' : 'Dublando'}
            </span>
            <span
              className="block truncate font-display text-lg uppercase"
              title={selected.fileName}
            >
              {selected.fileName}
            </span>
          </p>
          {!multiplayer || !match.state ? (
            <Button
              variant="secondary"
              data-testid="trocar-video"
              onClick={() => {
                setTrocandoVideo(true)
              }}
            >
              Trocar vídeo
            </Button>
          ) : null}
        </div>
      ) : null}

      {multiplayerLanding ? (
        <>
          <header>
            <p className="font-display text-sm uppercase tracking-[0.2em] text-accent">
              Dois aparelhos · um código
            </p>
            <h1 className="mt-2 max-w-5xl font-display text-giant uppercase">Multiplayer</h1>
            <p className="mt-4 max-w-2xl text-base leading-relaxed opacity-80 sm:text-lg">
              Uma pessoa cria a partida com o vídeo. A outra entra só com o código. A primeira fala
              fica bloqueada até os dois estarem na sala e com a cena pronta.
            </p>
          </header>

          <div className="grid gap-5 lg:grid-cols-2">
            <section className="flex min-h-56 flex-col items-start justify-between gap-5 border-2 border-accent p-6">
              <div>
                <p className="font-display text-sm uppercase tracking-[0.18em] text-accent">
                  Vou convidar
                </p>
                <h2 className="mt-2 font-display text-4xl uppercase">Criar partida</h2>
                <p className="mt-3 max-w-lg text-sm opacity-75">
                  Escolha o vídeo da sala, confira as duas vozes e gere o código para compartilhar.
                </p>
              </div>
              <Button
                size="hero"
                data-testid="multiplayer-criar"
                onClick={() => {
                  setMultiplayerAction('create')
                }}
              >
                Criar partida
              </Button>
            </section>

            <form
              className="flex min-h-56 flex-col justify-between gap-5 border-2 border-ink p-6"
              onSubmit={(event) => {
                event.preventDefault()
                void match.peek(matchCode)
              }}
            >
              <div>
                <p className="font-display text-sm uppercase tracking-[0.18em] opacity-60">
                  Recebi um convite
                </p>
                <h2 className="mt-2 font-display text-4xl uppercase">Entrar com código</h2>
                <label className="mt-4 flex flex-col gap-2">
                  <span className="font-body text-[0.6875rem] font-bold uppercase tracking-[0.16em] opacity-70">
                    Código da partida
                  </span>
                  <input
                    type="text"
                    value={matchCode}
                    maxLength={20}
                    placeholder="K7M2-9XQP-4TVB"
                    data-testid="online-codigo"
                    onChange={(event) => {
                      setMatchCode(event.target.value)
                      match.clearError()
                    }}
                    className="min-h-14 border-2 border-ink bg-paper px-3 font-display text-lg uppercase tracking-[0.18em] text-ink placeholder:text-muted"
                  />
                </label>
              </div>
              {match.error ? (
                <p className="border-2 border-danger px-3 py-2 text-sm text-danger" role="alert">
                  {match.error}
                </p>
              ) : null}
              <Button
                type="submit"
                size="hero"
                variant="secondary"
                data-testid="online-entrar-codigo"
                disabled={match.busy || matchCode.trim() === ''}
              >
                {match.busy ? 'Procurando sala…' : 'Entrar na partida'}
              </Button>
            </form>
          </div>
        </>
      ) : null}

      {multiplayerWaiting ? (
        <section className="flex flex-col gap-4 border-2 border-accent p-6" aria-live="polite">
          <p className="font-display text-sm uppercase tracking-[0.2em] text-accent">
            Partida encontrada
          </p>
          <h1 className="font-display text-4xl uppercase">
            {hostNeedsVideo ? 'Reabra o vídeo da sala' : 'Preparando o vídeo da sala…'}
          </h1>
          <p className="max-w-2xl text-sm opacity-75">
            {hostNeedsVideo
              ? 'A página foi recarregada antes do envio terminar. Escolha novamente o mesmo arquivo para concluir esta sala.'
              : 'Você não precisa escolher arquivo nenhum. Assim que o vídeo do anfitrião estiver pronto, ele baixa aqui e a partida continua automaticamente.'}
          </p>
          {match.error ? (
            <p className="border-2 border-danger px-4 py-3 text-danger" role="alert">
              {match.error}
            </p>
          ) : null}
          {hostNeedsVideo ? (
            <Button
              onClick={() => {
                setMultiplayerAction('create')
              }}
            >
              Escolher o vídeo novamente
            </Button>
          ) : null}
          <Button
            variant="secondary"
            disabled={match.busy}
            onClick={() => {
              void leaveMatchScreen()
            }}
          >
            Voltar
          </Button>
        </section>
      ) : null}

      {showVideoPicker ? (
        <header>
          <p className="font-display text-sm uppercase tracking-[0.2em] text-accent">
            {multiplayer ? 'Passo 1 de 2 · vídeo da sala' : 'Arquivo ou URL direta'}
          </p>
          <h1 className="mt-2 max-w-5xl font-display text-giant uppercase">
            {multiplayer ? 'Crie a partida' : 'Duble a sua própria cena'}
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-relaxed opacity-80 sm:text-lg">
            {multiplayer
              ? 'Escolha um vídeo de até 5 minutos. Ele será a única cena da sala; quem receber o código não precisa ter arquivo nenhum.'
              : 'Escolha um vídeo de até 5 minutos ou cole uma URL direta. A gente separa as falas, mostra onde você entrou na hora e devolve o vídeo com a sua voz — tudo no navegador.'}
          </p>
        </header>
      ) : null}

      {showVideoPicker ? (
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
              {multiplayer
                ? 'O vídeo será compartilhado somente com quem entrar nesta partida.'
                : 'Selecione uma cena do computador. O arquivo não é enviado para servidor.'}
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
              Precisa ser o link direto de um MP4, WebM ou MOV com CORS. Links de páginas do
              YouTube, TikTok, Instagram ou Drive não funcionam neste modo.
            </p>
          </form>
        </div>
      ) : null}

      {status ? (
        <div className="flex flex-wrap items-center gap-3" aria-live="polite" aria-atomic="true">
          <p className="font-display text-lg uppercase">{status}</p>
          <Button variant="ghost" size="sm" onClick={cancelSelection}>
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
            multiplayer={multiplayer}
            match={match}
            onLeaveMatch={() => {
              void leaveMatchScreen()
            }}
          />
        </div>
      ) : null}
    </div>
  )
}

/** Nome curto do modo, para o resumo da gaveta de ajustes. */
const MODE_LABELS: Record<TakeMode, string> = {
  full: 'Cena inteira',
  segment: 'Fala a fala',
  online: 'Multiplayer',
}

const RECORDING_REFERENCE_VOLUME = 0.1

function LocalDubStage({
  selected,
  onInteractionLockChange,
  multiplayer,
  match,
  onLeaveMatch,
}: {
  selected: SelectedVideo
  onInteractionLockChange: (locked: boolean) => void
  multiplayer: boolean
  match: OnlineMatch
  onLeaveMatch: () => void
}) {
  const playerRef = useRef<VideoPlayerHandle | null>(null)
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null)
  const [exportingVideo, setExportingVideo] = useState(false)

  const attachVideo = useCallback((handle: VideoPlayerHandle | null) => {
    playerRef.current = handle
    handle?.setVolume(RECORDING_REFERENCE_VOLUME)
    setVideoElement(handle?.element ?? null)
  }, [])

  const { clockRef, mediaTimeRef } = useMediaClock(videoElement)
  const reference = selected.reference.status === 'ready' ? selected.reference : null
  const unavailableReason =
    selected.reference.status === 'unavailable' ? selected.reference.reason : null

  /**
   * Pontes entre partes da tela que nascem em ordens diferentes.
   *
   * A barra fixa e os atalhos de teclado são montados antes de o gravador e a
   * lista de tomadas existirem. Guardar as versões atuais em refs evita tanto
   * inverter a ordem do componente quanto remontar o `keydown` a cada tomada.
   */
  const segmentsRef = useRef<readonly SpeakerSegment[]>([])
  const takesBySegmentRef = useRef<Record<string, unknown>>({})
  const goToNextPendingRef = useRef<(() => void) | null>(null)
  const useOriginalRef = useRef<(() => void) | null>(null)
  const stepSegmentRef = useRef<((delta: number) => void) | null>(null)

  /** Quantos personagens a cena tem. Quem sabe é a pessoa, não o algoritmo. */
  const [voiceCount, setVoiceCount] = useState(2)
  const [characterNames, setCharacterNames] = useState<readonly string[]>([
    'Personagem 1',
    'Personagem 2',
  ])
  const [castDialogOpen, setCastDialogOpen] = useState(false)
  const [castDialogBusy, setCastDialogBusy] = useState(false)
  const transcriptionAbortRef = useRef<AbortController | null>(null)

  const [takeMode, setTakeMode] = useState<TakeMode>(multiplayer ? 'online' : 'full')
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(0)

  /**
   * Falas digitadas pela pessoa, por trecho detectado.
   *
   * A transcrição automática escreve aqui dentro, no mesmo lugar em que a
   * pessoa digita. Isso é de propósito: o que o Whisper entendeu é um palpite
   * e precisa ser corrigível na hora, sem virar um campo separado e travado.
   * Fica guardado por vídeo para sobreviver a recarregar a página.
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

  /** Passa esta fala para o próximo personagem. */
  const cycleVoice = useCallback(
    (segmentId: string) => {
      setTranscriptSegments((previous) =>
        previous ? assignVoice(previous, segmentId, voiceCount) : previous,
      )
    },
    [voiceCount],
  )

  /** Escreve várias falas de uma vez sem disparar um salvamento por trecho. */
  const mergeTexts = useCallback(
    (entries: Record<string, string>) => {
      setTexts((previous) => {
        const next = { ...previous, ...entries }
        try {
          localStorage.setItem(`dublaai:falas:${selected.id}`, JSON.stringify(next))
        } catch {
          // Sem espaço para guardar não pode impedir de dublar.
        }
        return next
      })
    },
    [selected.id],
  )

  /**
   * Trecho a trecho: gravar ou manter a voz original do vídeo.
   *
   * Deixar um personagem no original é o que permite entrar só na voz do outro
   * — dublar um lado da conversa e responder a si mesmo. Guardado por vídeo,
   * junto das falas, para sobreviver a recarregar a página.
   */
  const [sources, setSources] = useState<Record<string, SegmentSource>>(() => {
    try {
      const raw = localStorage.getItem(`dublaai:fontes:${selected.id}`)
      return raw ? (JSON.parse(raw) as Record<string, SegmentSource>) : {}
    } catch {
      return {}
    }
  })
  const toggleSource = useCallback(
    (segmentId: string) => {
      setSources((previous) => {
        const next: Record<string, SegmentSource> = {
          ...previous,
          [segmentId]: previous[segmentId] === 'original' ? 'record' : 'original',
        }
        try {
          localStorage.setItem(`dublaai:fontes:${selected.id}`, JSON.stringify(next))
        } catch {
          // Sem espaço para guardar não pode impedir de escolher.
        }
        return next
      })
    },
    [selected.id],
  )

  /** Decodifica o áudio do vídeo sob demanda, para os trechos no original. */
  const loadOriginalAudio = useCallback(async () => {
    const video = await (await fetch(selected.url)).blob()
    return await decodeVideoMonoAudio(video, selected.durationMs)
  }, [selected.durationMs, selected.url])

  /**
   * Falas derivadas da transcrição.
   *
   * Quando existem, mandam nas do detector de energia: o VAD corta em toda
   * respiração e produzia frases picadas, impossíveis de dublar. `null` até a
   * pessoa pedir o reconhecimento.
   */
  const [transcriptSegments, setTranscriptSegments] = useState<readonly SpeakerSegment[] | null>(
    null,
  )
  const [transcription, setTranscription] = useState<
    | { readonly phase: 'idle' }
    | { readonly phase: 'running'; readonly loadedRatio: number }
    | { readonly phase: 'done'; readonly filled: number; readonly missing: number }
    | { readonly phase: 'failed'; readonly message: string }
  >({ phase: 'idle' })

  /**
   * Transcreve o áudio do vídeo no próprio aparelho.
   *
   * É explícito, e não automático no upload, por dois motivos: o modelo custa
   * uma dezena de MB na primeira vez, e nem todo mundo quer legenda — obrigar
   * o download antes de deixar a pessoa dublar inverteria a prioridade.
   */
  const runTranscription = useCallback(
    async (names: readonly string[]) => {
      if (!reference) return
      transcriptionAbortRef.current?.abort()
      const controller = new AbortController()
      transcriptionAbortRef.current = controller
      setTranscription({ phase: 'running', loadedRatio: 0 })
      const count = Math.max(1, names.length)
      const withCast = (segments: readonly SpeakerSegment[]) =>
        segments.map((segment, index) => ({
          ...segment,
          // O Whisper reconhece texto, não quem falou. Alternar é apenas um
          // ponto de partida previsível; o painel deixa cada fala corrigível.
          characterId: `voz-${String((index % count) + 1)}`,
        }))

      try {
        // O vídeo (enviado ou baixado da URL) já vive como object URL local,
        // então isto lê da memória da aba — não há requisição de rede aqui.
        const video = await (await fetch(selected.url, { signal: controller.signal })).blob()
        const audio = await decodeVideoMonoAudio(video, selected.durationMs)
        if (controller.signal.aborted) return
        const chunks = await transcribeReference(
          audio.samples,
          audio.sampleRate,
          ({ loadedRatio }) => {
            if (!controller.signal.aborted) setTranscription({ phase: 'running', loadedRatio })
          },
          controller.signal,
        )

        // Preferimos recortar a cena pela transcrição: o Whisper corta onde a
        // FRASE acaba, que é a unidade que se dubla. Só quando ele não entende
        // nada é que caímos de volta nos trechos do detector de energia.
        let recognized = withCast(
          segmentsFromTranscript(chunks, selected.id, selected.durationMs),
        )
        // Uma sala precisa de dois turnos/vozes. Se o Whisper fundiu o diálogo
        // inteiro numa frase, o detector local ainda pode oferecer cortes
        // revisáveis em vez de bloquear a criação sem explicação.
        if (multiplayer && count === 2 && recognized.length < 2) {
          const fallback = withCast(orderSegments(reference.segments))
          if (fallback.length >= 2) recognized = fallback
        }
        if (recognized.length > 0) {
          setTranscriptSegments(recognized)
          const entries: Record<string, string> = {}
          for (const segment of recognized) entries[segment.id] = segment.text
          mergeTexts(entries)
          setActiveSegmentIndex(0)
          playerRef.current?.seekMs(Math.max(0, (recognized[0]?.startMs ?? 0) - 400))
          if (multiplayer && count === 2 && recognized.length < 2) {
            setTranscription({
              phase: 'failed',
              message:
                'Esta cena tem apenas uma fala. Para uma partida, escolha um trecho com ao menos duas falas.',
            })
            return
          }
          setTranscription({ phase: 'done', filled: recognized.length, missing: 0 })
          return
        }

        const base = orderSegments(reference.segments)
        const described = withCast(assignTranscript(base, chunks))
        const missing = untranscribedCount(base, described)
        setTranscriptSegments(described)

        const entries: Record<string, string> = {}
        for (const [index, segment] of described.entries()) {
          if (segment.text !== base[index]?.text) entries[segment.id] = segment.text
        }
        mergeTexts(entries)
        setActiveSegmentIndex(0)
        playerRef.current?.seekMs(Math.max(0, (described[0]?.startMs ?? 0) - 400))
        setTranscription({ phase: 'done', filled: described.length - missing, missing })
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return
        const fallback = withCast(orderSegments(reference.segments))
        setTranscriptSegments(fallback)
        setActiveSegmentIndex(0)
        playerRef.current?.seekMs(Math.max(0, (fallback[0]?.startMs ?? 0) - 400))
        setTranscription({
          phase: 'failed',
          message:
            cause instanceof Error
              ? `${cause.message} Criamos cortes aproximados para você revisar manualmente.`
              : 'Não conseguimos transcrever este vídeo. Criamos cortes aproximados para você revisar manualmente.',
        })
      } finally {
        if (transcriptionAbortRef.current === controller) transcriptionAbortRef.current = null
      }
    },
    [mergeTexts, multiplayer, reference, selected.durationMs, selected.id, selected.url],
  )

  useEffect(() => {
    return () => {
      transcriptionAbortRef.current?.abort()
    }
  }, [])

  /** Trechos em ordem, com o texto digitado no lugar do rótulo genérico. */
  const orderedSegments = useMemo(() => {
    if (multiplayer && match.state) {
      return match.state.segments.map((segment, index) => ({
        ...segment,
        sceneId: selected.id,
        orderIndex: index,
      }))
    }
    const base = transcriptSegments ?? (reference ? orderSegments(reference.segments) : [])
    return base.map((segment) => {
      const typed = texts[segment.id]?.trim()
      return typed !== undefined && typed.length > 0 ? { ...segment, text: typed } : segment
    })
  }, [match.state, multiplayer, reference, selected.id, texts, transcriptSegments])

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
      name:
        id === 'reference-voice'
          ? 'VOZ'
          : (match.state?.characterNames?.[Number(id.replace('voz-', '')) - 1] ??
            characterNames[Number(id.replace('voz-', '')) - 1] ??
            `VOZ ${id.replace('voz-', '')}`),
      colorToken: `character-${String((index % 6) + 1)}`,
      patternToken: patterns[index % patterns.length] ?? 'solid',
    }))
  }, [characterNames, match.state?.characterNames, orderedSegments, selected.id])

  /**
   * Cena da partida online.
   *
   * O servidor guarda esta configuração como a versão canônica da sala. O
   * arquivo sobe separadamente, direto para o Blob, ou continua na URL de origem.
   */
  const onlineScene = useMemo(
    () => ({
      videoId: selected.id,
      videoName: selected.fileName,
      durationMs: Math.round(selected.durationMs),
      ...(selected.sourceUrl === undefined ? {} : { videoUrl: selected.sourceUrl }),
      ...(characterNames.length === 2 ? { characterNames } : {}),
      segments: orderedSegments.map((segment) => ({
        id: segment.id,
        characterId: segment.characterId,
        startMs: Math.round(segment.startMs),
        endMs: Math.round(segment.endMs),
        text: segment.text.slice(0, 300),
      })),
    }),
    [
      characterNames,
      orderedSegments,
      selected.durationMs,
      selected.fileName,
      selected.id,
      selected.sourceUrl,
    ],
  )
  /** Tomadas da partida, dos dois jogadores, prontas para a costura. */
  const onlineTakes = useMemo(() => {
    if (takeMode !== 'online' || !match.state) return undefined
    return Object.entries(match.state.takes).flatMap(([segmentId, take]) =>
      take ? [{ segmentId, url: take.url, mediaStartOffsetMs: take.mediaStartOffsetMs }] : [],
    )
  }, [takeMode, match.state])

  /** No online, quem manda na fala da vez é o servidor, não esta tela. */
  const onlineSegment = useMemo(() => {
    if (takeMode !== 'online' || !match.activeSegment) return undefined
    return orderedSegments.find((segment) => segment.id === match.activeSegment?.id)
  }, [takeMode, match.activeSegment, orderedSegments])

  const activeSegment =
    takeMode === 'segment'
      ? (orderedSegments[activeSegmentIndex] ?? orderedSegments[0])
      : takeMode === 'online'
        ? onlineSegment
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
  const goToSegment = useCallback((index: number) => {
    setActiveSegmentIndex(index)
    recorderResetRef.current?.()
    // Levar o vídeo até a fala é metade da explicação: a pessoa lê o texto na
    // barra e vê o quadro em que aquilo é dito, antes de apertar gravar.
    const segment = segmentsRef.current[index]
    if (segment) playerRef.current?.seekMs(Math.max(0, segment.startMs - 400))
  }, [])
  const recorderResetRef = useRef<(() => void) | null>(null)

  const nextPendingSegmentIndex = useCallback(
    (fromIndex: number, recorded: Record<string, unknown>) => {
      // Primeiro procura adiante; depois volta ao começo, para fechar as que
      // ficaram para trás sem obrigar a pessoa a caçá-las na lista.
      const pending = (index: number) => {
        const segment = orderedSegments[index]
        // Trecho no original já está resolvido: mandar gravar ali seria desfazer
        // a escolha da pessoa.
        return (
          segment !== undefined &&
          !isOriginal(sources, segment.id) &&
          recorded[segment.id] === undefined
        )
      }
      for (let index = fromIndex + 1; index < orderedSegments.length; index += 1) {
        if (pending(index)) return index
      }
      for (let index = 0; index <= fromIndex; index += 1) {
        if (pending(index)) return index
      }
      return -1
    },
    [orderedSegments, sources],
  )

  segmentsRef.current = orderedSegments

  /** Vai para a próxima fala pendente; se não houver, para na seguinte. */
  const goToNextPending = useCallback(() => {
    const next = nextPendingSegmentIndex(activeSegmentIndex, takesBySegmentRef.current)
    goToSegment(next === -1 ? Math.min(activeSegmentIndex + 1, orderedSegments.length - 1) : next)
  }, [activeSegmentIndex, goToSegment, nextPendingSegmentIndex, orderedSegments.length])

  /**
   * Marca a fala como original e já emenda na próxima.
   *
   * Quem escolhe não dublar um trecho quer seguir, não ficar parado nele —
   * então a troca e o avanço são o mesmo gesto. Desmarcar não avança: aí a
   * pessoa mudou de ideia e vai gravar ali mesmo.
   */
  const useOriginalAndAdvance = useCallback(() => {
    const segment = orderedSegments[activeSegmentIndex]
    if (!segment) return
    const passandoAOriginal = !isOriginal(sources, segment.id)
    toggleSource(segment.id)
    if (passandoAOriginal) goToNextPending()
  }, [activeSegmentIndex, goToNextPending, orderedSegments, sources, toggleSource])

  /** Legendas sincronizadas: só os trechos em que a pessoa digitou o texto. */
  const subtitles = useMemo<SubtitleSegment[]>(
    () =>
      orderedSegments
        .filter((segment) =>
          multiplayer && match.state
            ? segment.text.trim().length > 0
            : Boolean(texts[segment.id]?.trim()),
        )
        .map((segment) => ({
          id: `${segment.id}--sub`,
          sceneId: selected.id,
          speakerSegmentId: segment.id,
          startMs: segment.startMs,
          endMs: segment.endMs,
          text: segment.text,
        })),
    [match.state, multiplayer, orderedSegments, texts, selected.id],
  )

  const startVideo = useCallback(async (fromMs: number) => {
    const player = playerRef.current
    if (!player) return false
    // No modo fala-a-fala a tomada não começa no zero da cena.
    if (fromMs > 0) player.seekMs(fromMs)
    else player.restart()
    player.setVolume(RECORDING_REFERENCE_VOLUME)
    player.setMuted(true)
    try {
      await player.play()
      // Começar mudo mantém o `play()` compatível com autoplay; assim que a
      // imagem roda, liberamos a referência em volume baixo.
      player.setMuted(false)
      return true
    } catch {
      player.setVolume(RECORDING_REFERENCE_VOLUME)
      player.setMuted(false)
      return false
    }
  }, [])

  const stopVideo = useCallback(() => {
    playerRef.current?.pause()
    playerRef.current?.setVolume(RECORDING_REFERENCE_VOLUME)
    playerRef.current?.setMuted(false)
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

  const openCastDialog = useCallback(() => {
    if (castDialogBusy) return
    setCastDialogOpen(true)
  }, [castDialogBusy])

  const handleModeChange = useCallback(
    (mode: TakeMode) => {
      if (mode === 'segment') {
        openCastDialog()
        return
      }
      transcriptionAbortRef.current?.abort()
      setTakeMode(mode)
    },
    [openCastDialog],
  )

  const confirmCast = useCallback(
    (names: readonly string[]) => {
      const normalized = names.map(
        (name, index) => name.trim() || `Personagem ${String(index + 1)}`,
      )
      setCastDialogBusy(true)
      void (async () => {
        transcriptionAbortRef.current?.abort()
        await recorder.clearAttempts()

        // Toda nova entrada em fala-a-fala é uma sessão limpa: nenhuma
        // tomada, texto ou escolha antiga reaparece por causa do mesmo arquivo.
        try {
          localStorage.removeItem(`dublaai:falas:${selected.id}`)
          localStorage.removeItem(`dublaai:fontes:${selected.id}`)
        } catch {
          // Falha no armazenamento não impede reiniciar a sessão visível.
        }
        setTexts({})
        setSources({})
        setTranscriptSegments(null)
        setTranscription({ phase: 'idle' })
        setActiveSegmentIndex(0)
        setVoiceCount(normalized.length)
        setCharacterNames(normalized)
        if (!multiplayer) setTakeMode('segment')
        playerRef.current?.seekMs(0)
        setCastDialogOpen(false)
        setCastDialogBusy(false)
        await runTranscription(normalized)
      })().catch(() => {
        setCastDialogBusy(false)
      })
    },
    [multiplayer, recorder, runTranscription, selected.id],
  )

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

  const scoreBySegment = useMemo(() => bestScoreBySegment(recorder.attempts), [recorder.attempts])
  const takesBySegment = useMemo(() => takeStatesBySegment(recorder.attempts), [recorder.attempts])
  takesBySegmentRef.current = takesBySegment
  // O atalho de teclado é montado antes desta função existir; o ref costura os
  // dois sem obrigar o efeito a se remontar a cada tomada nova.
  goToNextPendingRef.current = goToNextPending
  useOriginalRef.current = useOriginalAndAdvance
  stepSegmentRef.current = (delta: number) => {
    goToSegment(Math.min(orderedSegments.length - 1, Math.max(0, activeSegmentIndex + delta)))
  }

  /** O que cada célula da fita mostra. */
  const stripCells = useMemo(() => {
    const cells: Record<string, TakeStripCell> = {}
    for (const segment of orderedSegments) {
      const take = takesBySegment[segment.id]
      cells[segment.id] = {
        recorded: take?.recorded ?? false,
        score: take?.score ?? null,
        original: isOriginal(sources, segment.id),
      }
    }
    return cells
  }, [orderedSegments, takesBySegment, sources])

  /** Fase da barra fixa, traduzida da máquina de gravação. */
  const hudPhase: SegmentPhase = state.matches('recording')
    ? 'recording'
    : state.matches('countdown')
      ? 'countdown'
      : state.matches('preview')
        ? 'preview'
        : state.matches('idle')
          ? 'idle'
          : 'busy'

  /**
   * Espaço grava, Esc cancela.
   *
   * O ciclo do fala-a-fala é feito de dezenas de repetições; tirar a mão do
   * teclado a cada volta é o que torna o modo cansativo. O atalho é ignorado
   * enquanto a pessoa escreve numa fala — ali o espaço é espaço.
   */
  useEffect(() => {
    if (takeMode !== 'segment') return

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      const editing =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (editing || event.metaKey || event.ctrlKey || event.altKey) return

      if (event.code === 'Space') {
        event.preventDefault()
        if (state.matches('idle')) void recorder.requestDub()
        else if (state.matches('recording')) recorder.stop()
        else if (state.matches('preview')) goToNextPendingRef.current?.()
        return
      }
      if (event.key === 'Escape' && (state.matches('countdown') || state.matches('recording'))) {
        event.preventDefault()
        recorder.cancel()
        return
      }
      // Só valem parados: trocar de fala no meio de uma gravação jogaria a
      // tomada fora sem a pessoa ter pedido.
      if (!state.matches('idle') && !state.matches('preview')) return

      const key = event.key.toLowerCase()
      if (key === 'r') {
        event.preventDefault()
        void recorder.requestDub()
      } else if (key === 'o') {
        event.preventDefault()
        useOriginalRef.current?.()
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault()
        stepSegmentRef.current?.(event.key === 'ArrowRight' ? 1 : -1)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [takeMode, state, recorder])

  // O navegador de falas precisa reiniciar a máquina, mas ele é declarado
  // antes do recorder existir; o ref costura os dois sem inverter a ordem.
  const sendRecorder = recorder.send
  useEffect(() => {
    recorderResetRef.current = () => {
      sendRecorder({ type: 'RESET' })
    }
  }, [sendRecorder])

  // Se o servidor aceitou a fala, mas a resposta do POST se perdeu, o polling
  // ainda traz a tomada canônica. Descartar a prévia antiga impede que esse WAV
  // seja reenviado por engano como a próxima fala do mesmo personagem.
  const previewSegmentId = recorder.currentAttempt?.segmentId
  useEffect(() => {
    if (
      takeMode === 'online' &&
      previewSegmentId !== undefined &&
      match.state?.takes[previewSegmentId] !== undefined
    ) {
      sendRecorder({ type: 'RESET' })
    }
  }, [match.state?.takes, previewSegmentId, sendRecorder, takeMode])

  const workflowLocked =
    state.matches('requestingPermission') ||
    state.matches('preparing') ||
    state.matches('countdown') ||
    state.matches('recording') ||
    state.matches('stopping') ||
    state.matches('analyzing')
  const mediaInteractionLocked = workflowLocked || exportingVideo
  const showSceneReview =
    !match.state && (takeMode === 'segment' || (multiplayer && transcription.phase !== 'idle'))
  const reviewedSegments = transcriptSegments ? orderedSegments : []

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
      <CharacterSetupDialog
        open={castDialogOpen}
        busy={castDialogBusy}
        initialNames={characterNames}
        {...(multiplayer ? { fixedCount: 2 } : {})}
        onCancel={() => {
          if (!castDialogBusy) setCastDialogOpen(false)
        }}
        onConfirm={confirmCast}
      />

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
        </div>
      </div>

      {takeMode === 'segment' &&
      transcription.phase !== 'running' &&
      transcriptSegments &&
      activeSegment &&
      recorder.supported ? (
        <SegmentHud
          segment={activeSegment}
          index={activeSegmentIndex}
          total={orderedSegments.length}
          text={texts[activeSegment.id]?.trim() ? (texts[activeSegment.id] ?? null) : null}
          phase={hudPhase}
          countdown={state.context.countdown}
          isOriginal={isOriginal(sources, activeSegment.id)}
          allDone={nextPendingSegmentIndex(activeSegmentIndex, takesBySegment) === -1}
          bestScore={scoreBySegment[activeSegment.id] ?? null}
          disabled={exportingVideo}
          onRecord={() => {
            void recorder.requestDub()
          }}
          onStop={recorder.stop}
          onNext={goToNextPending}
          onRetry={() => {
            void recorder.requestDub()
          }}
          onToggleOriginal={useOriginalAndAdvance}
        />
      ) : null}

      {takeMode === 'online' && activeSegment ? (
        <div
          className="sticky top-0 z-30 -mx-4 border-y-2 border-accent bg-ink/95 px-4 py-3 backdrop-blur sm:-mx-8 sm:px-8"
          data-testid="online-fala-da-vez"
          aria-live="polite"
        >
          <p className="font-body text-[0.6875rem] font-bold uppercase tracking-[0.16em] text-muted">
            {match.myTurn ? 'Sua fala agora' : 'Fala da vez'} ·{' '}
            {orderedSegments.findIndex((segment) => segment.id === activeSegment.id) + 1}/
            {orderedSegments.length} · {formatTimecode(activeSegment.startMs)}–
            {formatTimecode(activeSegment.endMs)}
          </p>
          <p className="mt-1 font-display text-xl uppercase leading-tight text-paper">
            {activeSegment.text.trim() || 'Sem texto para esta fala'}
          </p>
        </div>
      ) : null}

      <div className="mt-2 grid items-stretch gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex flex-col gap-3 min-w-0 justify-start">
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
            <p
              className="mt-1 border-l-4 border-warn bg-warn/10 px-3 py-2 text-xs leading-relaxed text-paper/80"
              data-testid="reference-audio-notice"
              role="note"
            >
              <strong className="font-display uppercase tracking-wider text-warn">
                Som de referência · 10%
              </strong>{' '}
              — ele toca baixo apenas para orientar sua gravação e não entra no resultado. Para
              preservar uma fala do vídeo, marque <strong>“Manter voz original”</strong> ao lado.
            </p>
          ) : null}
        </div>

        <div className="flex flex-col min-w-0 h-full">
          {showSceneReview ? (
            <SceneReviewPanel
              segments={reviewedSegments}
              texts={texts}
              characterNames={characterNames}
              voiceCount={voiceCount}
              sources={sources}
              transcription={transcription}
              activeIndex={activeSegmentIndex}
              disabled={workflowLocked || exportingVideo}
              onTextChange={updateText}
              onCycleVoice={cycleVoice}
              onToggleSource={toggleSource}
              onSelect={goToSegment}
              onRecognizeAgain={openCastDialog}
              onBackToSettings={() => handleModeChange(multiplayer ? 'online' : 'full')}
            />
          ) : multiplayer && match.state ? (
            <OnlineMatchPanel
              match={match}
              scene={onlineScene}
              characters={characters}
              videoId={selected.id}
              loadVideoBlob={async () => await (await fetch(selected.url)).blob()}
              onLeave={onLeaveMatch}
            />
          ) : reference && (state.matches('idle') || state.matches('preview')) ? (
            <details open className="flex flex-col justify-between h-full border-2 border-ink-line bg-ink" data-testid="ajustes-da-cena">
              <summary className="flex min-h-12 cursor-pointer items-center justify-between gap-2 border-b-2 border-ink-line bg-ink-soft/40 px-4 py-3 font-display text-sm uppercase tracking-widest hover:bg-ink-soft">
                <span>
                  {multiplayer ? 'Configuração da partida' : 'Ajustes da cena'} ·{' '}
                  {MODE_LABELS[takeMode]}
                </span>
                <span className="font-body text-xs text-muted">
                  {subtitles.length}/{orderedSegments.length} falas escritas
                </span>
              </summary>
              <div className="flex flex-col justify-between flex-1 gap-6 p-4">
                <div className="flex flex-col gap-4">
                  {!multiplayer ? <ModePicker value={takeMode} onChange={handleModeChange} /> : null}

                  {!multiplayer && takeMode === 'full' ? (
                    <div className="flex flex-col gap-2 border-t border-ink-line pt-3">
                      <p className="text-xs text-muted leading-relaxed">
                        No modo Cena Inteira, você grava todo o vídeo do começo ao fim. Para revisar e dublar fala por fala, selecione <strong>"Fala a fala"</strong> acima.
                      </p>
                    </div>
                  ) : null}

                  {multiplayer && match.state ? (
                    <p className="text-xs text-muted">
                      A configuração foi travada quando o código foi gerado. Assim os dois aparelhos
                      usam exatamente as mesmas falas e personagens.
                    </p>
                  ) : null}

                  {!match.state && multiplayer ? (
                    <p className="text-xs text-muted">
                      Diga quem participa da cena e o reconhecimento começa sozinho. Depois confira as
                      falas ao lado do vídeo antes de criar o código da partida.
                    </p>
                  ) : null}
                </div>

                <div className="border-t-2 border-ink-line pt-4 mt-auto">
                  <Button
                    className="w-full"
                    size="md"
                    variant="secondary"
                    disabled={transcription.phase === 'running'}
                    data-testid="local-transcrever"
                    onClick={openCastDialog}
                  >
                    {transcription.phase === 'running'
                      ? 'Reconhecendo…'
                      : transcription.phase === 'done'
                        ? 'Reconhecer de novo'
                        : 'Reconhecer falas da cena'}
                  </Button>
                </div>
              </div>
            </details>
          ) : null}
        </div>
      </div>

      {takeMode === 'segment' && transcriptSegments && activeSegment ? (
        <TakeStrip
          segments={orderedSegments}
          cells={stripCells}
          activeIndex={activeSegmentIndex}
          disabled={!state.matches('idle') && !state.matches('preview')}
          onSelect={goToSegment}
        />
      ) : null}

      {takeMode !== 'full' && (state.matches('idle') || state.matches('preview')) ? (
        <StitchedPlayback
          attempts={recorder.attempts}
          segments={orderedSegments}
          durationMs={selected.durationMs}
          video={videoElement}
          sources={sources}
          loadOriginalAudio={loadOriginalAudio}
          sourceFileName={selected.fileName}
          remoteTakes={onlineTakes}
        />
      ) : null}

      {reference ? (
        state.matches('recording') ? (
          <section
            className="flex flex-col gap-3 border-2 border-ink-line p-4"
            aria-labelledby="referencia-enviada-titulo"
            data-testid="recording-voice-reference"
          >
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
                liveOverlayActive
                label="Forma de onda da referência com sua voz ao vivo"
              />
            </div>
            <div
              className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted"
              aria-label="Legenda da onda"
            >
              <span className="inline-flex items-center gap-2">
                <span className="h-2 w-5 bg-muted" aria-hidden="true" /> Referência
              </span>
              <span className="inline-flex items-center gap-2">
                <span className="h-2 w-5 bg-ok" aria-hidden="true" /> Sua voz ao vivo
              </span>
            </div>
            <p className="text-xs text-muted">
              Use fones de ouvido: o áudio original toca baixo como guia e, nos alto-falantes, pode
              vazar para o microfone.
            </p>
            <p className="text-xs text-muted">
              A pontuação compara sua voz com o áudio completo do vídeo. Música, efeitos e várias
              pessoas podem reduzir a precisão. Articulação fica indisponível porque esta cena não
              possui o corpus necessário para uma calibração honesta.
            </p>
          </section>
        ) : null
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

        {(state.matches('preparing') ||
          state.matches('countdown') ||
          state.matches('recording')) && (
          <LevelMeter peak={recorder.level} recording={state.matches('recording')} />
        )}



        {state.matches('idle') &&
        recorder.supported &&
        takeMode !== 'segment' &&
        // No online o botão some fora da sua vez: apertar antes da hora daria
        // uma gravação que o servidor recusaria depois de a pessoa já ter
        // falado, que é a pior hora de descobrir.
        !(takeMode === 'online' && !match.myTurn) ? (
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
              {multiplayer
                ? 'Vamos pedir acesso ao microfone. Ao enviar a fala, ela fica disponível apenas nesta partida.'
                : 'Vamos pedir acesso ao microfone. Sua voz não é enviada para nenhum servidor.'}
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
            {takeMode === 'online' &&
            activeSegment &&
            match.myTurn &&
            recorder.currentAttempt.segmentId === activeSegment.id ? (
              <Button
                size="lg"
                disabled={match.busy}
                data-testid="online-enviar-fala"
                onClick={() => {
                  const attempt = recorder.currentAttempt
                  if (!attempt) return
                  const segmentId = attempt.segmentId
                  if (!segmentId || segmentId !== activeSegment.id) return
                  const enviar = async () => {
                    const wav = await (await fetch(attempt.wavUrl)).blob()
                    const enviada = await match.submit(
                      segmentId,
                      wav,
                      attempt.clock.mediaStartOffsetMs,
                      attempt.clock.sampleRate,
                    )
                    // Só limpa a tela depois que o servidor aceitou: se a rede
                    // falhar, a tomada continua aqui para tentar de novo.
                    if (enviada) recorder.send({ type: 'RESET' })
                  }
                  void enviar()
                }}
              >
                {match.busy ? 'Enviando…' : 'Enviar minha fala ▶'}
              </Button>
            ) : null}

            {takeMode === 'segment' && activeSegment ? (
              <Button
                size="lg"
                disabled={exportingVideo}
                data-testid="local-next-segment"
                onClick={() => {
                  const next = nextPendingSegmentIndex(activeSegmentIndex, takesBySegment)
                  goToSegment(
                    next === -1
                      ? Math.min(activeSegmentIndex + 1, orderedSegments.length - 1)
                      : next,
                  )
                }}
              >
                {nextPendingSegmentIndex(activeSegmentIndex, takesBySegment) === -1
                  ? 'Todas as falas gravadas'
                  : 'Próxima fala ▶'}
              </Button>
            ) : null}

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
