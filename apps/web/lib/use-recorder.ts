'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMachine } from '@xstate/react'
import {
  AudioCaptureService,
  checkContinuity,
  isCaptureSupported,
  type CaptureDevice,
  type CaptureStatus,
  type MediaClock,
  type PreflightGuards,
  recordingMachine,
  RecordingBuffer,
} from '@dubla/audio'
import { encodeWav, SILENCE_PEAK_DB } from '@dubla/dsp'
import {
  type DubMode,
  type DublaErrorCode,
  isDublaError,
  type RecordingClockInfo,
  type ScoreResult,
  type SpeakerSegment,
  toDublaError,
  track as trackEvent,
} from '@dubla/shared'
import type { AnalysisRequest, AnalysisResponse } from '@/workers/analysis.worker'
import {
  listAttempts,
  loadAudioUrl,
  saveAttempt,
  type StoredAttempt,
  updateAttemptResult,
} from './recording-store'
import {
  appendLiveWaveformLevel,
  appendTimedLiveWaveformSamples,
  beginLiveWaveformMonitoring,
  beginLiveWaveformRecording,
  createLiveWaveform,
  resetLiveWaveform,
  type LiveWaveformData,
} from './live-waveform'

export interface UseRecorderOptions {
  readonly sceneId: string
  readonly segments: readonly SpeakerSegment[]
  readonly featuresUrl?: string
  /** Referência gerada no navegador para vídeos enviados pelo usuário. */
  readonly referenceFeatures?: ArrayBuffer
  /** Vídeos locais não têm uma referência vocal para pontuar. */
  readonly skipAnalysis?: boolean
  /** Habilita o envelope do microfone sobre a timeline, sem renders por chunk. */
  readonly liveWaveformDurationMs?: number
  readonly clockRef: React.RefObject<MediaClock | null>
  /**
   * Posiciona o vídeo em `fromMs` e toca. Devolve `false` se não conseguiu.
   *
   * No modo fala-a-fala o início não é zero: cada tomada começa um pouco antes
   * da própria fala, para a pessoa ter embalo.
   */
  readonly onStartVideo: (fromMs: number) => Promise<boolean>
  readonly onStopVideo: () => void
  readonly isVideoBuffered: () => boolean
  /**
   * Trecho da cena a gravar e pontuar (modo fala-a-fala).
   *
   * Quando ausente, grava e pontua a cena inteira, que é o comportamento
   * padrão.
   */
  readonly analysisWindow?: { readonly startMs: number; readonly endMs: number }
  /** Identifica a fala gravada, para separar as tentativas por segmento. */
  readonly segmentId?: string
}

export interface RecorderAttempt {
  readonly id: string
  readonly attemptNumber: number
  /** Fala coberta, no modo fala-a-fala. Ausente = cena inteira. */
  readonly segmentId?: string
  readonly wavUrl: string
  readonly durationMs: number
  readonly clock: RecordingClockInfo
  readonly result: ScoreResult | null
}

const GUARD_POLL_MS = 400
const ANALYSIS_TIMEOUT_MS = 30_000

/**
 * Constante de módulo, não literal no corpo do componente.
 *
 * `useMachine` recebe as opções a cada render; um objeto novo toda vez faz o
 * ator ser recriado, o que produz um snapshot novo, que dispara outro render —
 * o ciclo que estourava o limite de atualizações do React.
 */
const MACHINE_OPTIONS = { input: { mode: 'original' as const } }

export function useRecorder(options: UseRecorderOptions) {
  const [state, send] = useMachine(recordingMachine, MACHINE_OPTIONS)

  /**
   * `options` é recriado a cada render pelo componente pai. Guardá-lo num ref
   * e NÃO listá-lo nas dependências é o que impede o ciclo
   * `efeito → send → render → efeito`, que estourava o limite de atualizações
   * do React antes mesmo de a página terminar de montar.
   */
  const optionsRef = useRef(options)
  optionsRef.current = options

  const stateRef = useRef(state)
  stateRef.current = state

  const serviceRef = useRef<AudioCaptureService | null>(null)
  const bufferRef = useRef(new RecordingBuffer())
  const liveWaveformRef = useRef<LiveWaveformData | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const objectUrlsRef = useRef<string[]>([])
  const lastGuardsRef = useRef<Partial<PreflightGuards>>({})
  const mountedRef = useRef(true)
  const cancelAnalysisRef = useRef<(() => void) | null>(null)

  const liveWaveformDurationMs = options.liveWaveformDurationMs ?? 0
  if (
    liveWaveformDurationMs > 0 &&
    liveWaveformRef.current?.durationMs !== liveWaveformDurationMs
  ) {
    liveWaveformRef.current = createLiveWaveform(liveWaveformDurationMs)
  }

  const startContextTimeRef = useRef(0)
  const startFrameRef = useRef(0)
  const statusRef = useRef<CaptureStatus | null>(null)
  /** Descarta respostas de análise de tentativas já abandonadas. */
  const requestIdRef = useRef('')

  const [devices, setDevices] = useState<readonly CaptureDevice[]>([])
  const [deviceId, setDeviceId] = useState<string | undefined>(undefined)
  const [level, setLevel] = useState(0)
  const [attempts, setAttempts] = useState<readonly RecorderAttempt[]>([])
  /** Erro de armazenamento é informativo: nunca impede gravar de novo (§58). */
  const [storageError, setStorageError] = useState<DublaErrorCode | null>(null)

  /**
   * `null` até a montagem no cliente.
   *
   * Detectar suporte durante o render do servidor daria `false` (não há
   * `window`) e `true` no cliente — a divergência que quebrava a hidratação.
   */
  const [supported, setSupported] = useState<boolean | null>(null)
  useEffect(() => {
    setSupported(isCaptureSupported())
  }, [])

  const getService = useCallback(() => {
    serviceRef.current ??= new AudioCaptureService()
    return serviceRef.current
  }, [])

  /**
   * Recupera as tentativas anteriores desta cena.
   *
   * É o que faz o §54 valer na prática: fechar a aba e voltar não perde o que
   * a pessoa gravou.
   */
  useEffect(() => {
    const mount = { alive: true }
    const urls: string[] = []

    void (async () => {
      const stored = await listAttempts(optionsRef.current.sceneId)
      const restored: RecorderAttempt[] = []

      for (const entry of stored) {
        const url = await loadAudioUrl(entry)
        if (!url) continue
        urls.push(url)
        restored.push({
          id: entry.id,
          attemptNumber: entry.attemptNumber,
          ...(entry.segmentId === undefined ? {} : { segmentId: entry.segmentId }),
          wavUrl: url,
          durationMs: entry.durationMs,
          clock: entry.clock,
          result: entry.result,
        })
      }

      if (!mount.alive) {
        for (const url of urls) URL.revokeObjectURL(url)
        return
      }
      objectUrlsRef.current.push(...urls)
      if (restored.length > 0) setAttempts(restored)
    })()

    return () => {
      mount.alive = false
    }
  }, [])

  /** Valor primitivo do estado: dependência estável para os efeitos. */
  const stateValue = typeof state.value === 'string' ? state.value : JSON.stringify(state.value)
  const countdownValue = state.context.countdown

  // ---------------------------------------------------------------------
  // Limpeza (§67). É a garantia do critério §111.14.
  // ---------------------------------------------------------------------
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestIdRef.current = ''
      cancelAnalysisRef.current?.()
      cancelAnalysisRef.current = null
      workerRef.current?.terminate()
      workerRef.current = null
      if (liveWaveformRef.current) resetLiveWaveform(liveWaveformRef.current)
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url)
      objectUrlsRef.current = []
      const service = serviceRef.current
      serviceRef.current = null
      void service?.close().catch(() => undefined)
    }
  }, [])

  // ---------------------------------------------------------------------
  // Guards de ambiente
  // ---------------------------------------------------------------------
  useEffect(() => {
    /**
     * Só envia quando algum guard MUDA.
     *
     * `assign` do XState cria um contexto novo a cada evento, mesmo com
     * valores idênticos — enviar a cada sondagem provocaria um render duas
     * vezes por segundo sem nenhuma informação nova.
     */
    const report = () => {
      const next: Partial<PreflightGuards> = {
        videoBuffered: optionsRef.current.isVideoBuffered(),
        visible: document.visibilityState === 'visible',
      }
      const previous = lastGuardsRef.current
      if (previous.videoBuffered === next.videoBuffered && previous.visible === next.visible) {
        return
      }
      lastGuardsRef.current = { ...previous, ...next }
      send({ type: 'GUARDS', guards: next })
    }

    report()

    // Sondagem encadeada: `buffered` não emite evento ao terminar de encher, e
    // o §112 proíbe setInterval no projeto.
    let pollId: ReturnType<typeof setTimeout> | null = setTimeout(function poll() {
      report()
      pollId = setTimeout(poll, GUARD_POLL_MS)
    }, GUARD_POLL_MS)

    const onVisibility = () => {
      report()
      // §104 — sair da aba gravando invalida a premissa de sincronia.
      if (document.visibilityState !== 'visible' && stateRef.current.matches('recording')) {
        send({ type: 'TAB_HIDDEN' })
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      if (pollId !== null) clearTimeout(pollId)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [send])

  const refreshDevices = useCallback(async () => {
    try {
      setDevices(await getService().listDevices())
    } catch {
      // Enumerar pode falhar antes da permissão; não é motivo para erro na UI.
    }
  }, [getService])

  const startCapture = useCallback(async (sceneId: string) => {
    const { clockRef } = optionsRef.current
    const service = getService()
    try {
      const status = await service.start(deviceId, {
        onChunk: (samples) => {
          bufferRef.current.append(samples)
          const liveWaveform = liveWaveformRef.current
          if (liveWaveform && stateRef.current.matches('recording')) {
            const sampleRate = statusRef.current?.sampleRate ?? service.getContext().sampleRate
            const mediaEndMs = (optionsRef.current.clockRef.current?.now().mediaTimeSec ?? 0) * 1_000
            appendTimedLiveWaveformSamples(liveWaveform, samples, sampleRate, mediaEndMs)
          }
        },
        onLevel: (value) => {
          setLevel(value.peak)
          const liveWaveform = liveWaveformRef.current
          if (
            liveWaveform &&
            (stateRef.current.matches('requestingPermission') ||
              stateRef.current.matches('preparing') ||
              stateRef.current.matches('countdown'))
          ) {
            appendLiveWaveformLevel(liveWaveform, value.peak)
          }
        },
        onStarted: (start) => {
          startContextTimeRef.current = start.contextTime
          startFrameRef.current = start.startFrame
        },
        onTrackEnded: () => {
          lastGuardsRef.current = { ...lastGuardsRef.current, micLive: false }
          send({ type: 'TRACK_ENDED' })
        },
        onDeviceChange: () => {
          void refreshDevices()
        },
      })

      if (!mountedRef.current || serviceRef.current !== service) {
        service.dispose()
        return
      }

      statusRef.current = status
      clockRef.current?.attachAudioContext(service.getContext())

      send({ type: 'PERMISSION_GRANTED', autoGainControlActive: status.autoGainControlActive })
      lastGuardsRef.current = {
        ...lastGuardsRef.current,
        micLive: true,
        workletReady: true,
        contextRunning: true,
      }
      send({ type: 'GUARDS', guards: { micLive: true, workletReady: true, contextRunning: true } })
      void refreshDevices()
    } catch (error) {
      if (
        !mountedRef.current ||
        serviceRef.current !== service ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) {
        return
      }
      const dublaError = toDublaError(error)
      trackEvent('mic_permission_denied', { sceneId, errorCode: dublaError.code })
      send({ type: 'FAIL', code: dublaError.code })
    }
  }, [deviceId, getService, refreshDevices, send])

  // ---------------------------------------------------------------------
  // Início
  // ---------------------------------------------------------------------
  const requestDub = useCallback(async () => {
    if (supported === false) {
      send({ type: 'FAIL', code: 'BROWSER_UNSUPPORTED' })
      return
    }

    const { sceneId } = optionsRef.current
    if (liveWaveformRef.current) beginLiveWaveformMonitoring(liveWaveformRef.current)
    send({ type: 'REQUEST_DUB' })
    trackEvent('dub_started', { sceneId })
    await startCapture(sceneId)
  }, [send, startCapture, supported])

  // ---------------------------------------------------------------------
  // Countdown
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (stateValue !== 'countdown') return

    // O gravador é armado ANTES do countdown: não tentamos alinhar dois
    // inícios, medimos o offset entre eles depois (AUDIO_PIPELINE §1).
    if (countdownValue === 3) {
      bufferRef.current.clear()
      getService().arm()
    }

    const id = setTimeout(() => {
      send({ type: 'TICK' })
    }, 1_000)
    return () => {
      clearTimeout(id)
    }
  }, [stateValue, countdownValue, getService, send])

  // ---------------------------------------------------------------------
  // Gravando: o vídeo começa aqui, e este é o t=0 oficial
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (stateValue !== 'recording') return

    // O buffer principal contém o pré-roll do countdown; a camada visual não.
    // Ela recomeça aqui e cada chunk será posicionado pelo MediaClock.
    if (liveWaveformRef.current) beginLiveWaveformRecording(liveWaveformRef.current)

    // Objeto e não `let`: a promessa de `play()` pode resolver depois que o
    // efeito foi desmontado, e a resposta tardia não pode disparar erro numa
    // tentativa que já acabou.
    const attempt = { alive: true }

    void (async () => {
      const started = await optionsRef.current.onStartVideo(
        optionsRef.current.analysisWindow?.startMs ?? 0,
      )
      if (!attempt.alive) return
      if (started) {
        trackEvent('recording_start_success', { sceneId: optionsRef.current.sceneId })
      } else {
        getService().disarm()
        optionsRef.current.onStopVideo()
        send({ type: 'FAIL', code: 'VIDEO_LOAD_FAILED' })
      }
    })()

    return () => {
      attempt.alive = false
    }
  }, [stateValue, getService, send])

  const runAnalysis = useCallback(
    async (
      samples: Float32Array,
      sampleRate: number,
      clockInfo: RecordingClockInfo,
      attemptNumber: number,
      attemptId: string,
      mode: DubMode,
      saveCompleted: Promise<boolean>,
    ) => {
      const {
        sceneId,
        featuresUrl,
        referenceFeatures: inMemoryReference,
        segments,
        analysisWindow,
      } = optionsRef.current
      const requestId = `${sceneId}:${String(attemptNumber)}:${String(Date.now())}`
      cancelAnalysisRef.current?.()
      requestIdRef.current = requestId

      try {
        let referenceFeatures: ArrayBuffer
        if (inMemoryReference) {
          // O buffer enviado ao worker é transferido e fica detached. Cada
          // tentativa recebe uma cópia para preservar a referência original.
          referenceFeatures = inMemoryReference.slice(0)
        } else {
          if (!featuresUrl) throw new Error('Referência de áudio ausente')
          const response = await fetch(featuresUrl)
          if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
          referenceFeatures = await response.arrayBuffer()
        }

        workerRef.current ??= new Worker(
          new URL('../workers/analysis.worker.ts', import.meta.url),
          { type: 'module' },
        )
        const worker = workerRef.current

        const result = await new Promise<ScoreResult>((resolve, reject) => {
          let timeoutId: ReturnType<typeof setTimeout> | null = null
          const cleanup = () => {
            if (timeoutId !== null) clearTimeout(timeoutId)
            worker.removeEventListener('message', onMessage)
            worker.removeEventListener('error', onError)
            worker.removeEventListener('messageerror', onMessageError)
            if (cancelAnalysisRef.current === cancel) cancelAnalysisRef.current = null
          }
          const discardWorker = () => {
            if (workerRef.current === worker) workerRef.current = null
            worker.terminate()
          }
          const fail = (error: Error) => {
            cleanup()
            discardWorker()
            reject(error)
          }
          const cancel = () => {
            cleanup()
            discardWorker()
            reject(new DOMException('Análise cancelada.', 'AbortError'))
          }
          const onMessage = (event: MessageEvent<AnalysisResponse>) => {
            // §56 — resposta de tentativa abandonada não sobrescreve a atual.
            if (event.data.requestId !== requestId || requestIdRef.current !== requestId) return
            cleanup()
            if (event.data.ok) resolve(event.data.result)
            else reject(new Error(event.data.message))
          }
          const onError = () => {
            fail(new Error('O worker de análise falhou.'))
          }
          const onMessageError = () => {
            fail(new Error('O worker devolveu uma resposta inválida.'))
          }

          worker.addEventListener('message', onMessage)
          worker.addEventListener('error', onError)
          worker.addEventListener('messageerror', onMessageError)
          cancelAnalysisRef.current = cancel
          timeoutId = setTimeout(() => {
            fail(new Error('A análise demorou mais do que o esperado.'))
          }, ANALYSIS_TIMEOUT_MS)

          const request: AnalysisRequest = {
            requestId,
            samples,
            sampleRate,
            referenceFeatures,
            segments,
            mode,
            recordingOffsetMs: clockInfo.mediaStartOffsetMs,
            autoGainControlActive: statusRef.current?.autoGainControlActive ?? false,
            sampleContinuityOk: clockInfo.sampleContinuityOk,
            // Modo fala-a-fala: analisar só o trecho gravado. Sem isto o DTW
            // compararia a cena inteira contra uma gravação quase toda vazia.
            ...(analysisWindow === undefined ? {} : { window: analysisWindow }),
          }
          try {
            worker.postMessage(request, [samples.buffer, referenceFeatures])
          } catch (error) {
            fail(error instanceof Error ? error : new Error('Não foi possível iniciar a análise.'))
          }
        })

        if (!mountedRef.current || requestIdRef.current !== requestId) return
        setAttempts((previous) =>
          previous.map((attempt) => (attempt.id === attemptId ? { ...attempt, result } : attempt)),
        )
        void saveCompleted.then(async (saved) => {
          if (saved) await updateAttemptResult(attemptId, result)
        }).catch(() => undefined)
        requestIdRef.current = ''
        send({ type: 'ANALYZED' })
        trackEvent('dub_completed', { sceneId })
      } catch (error) {
        if (
          !mountedRef.current ||
          requestIdRef.current !== requestId ||
          (error instanceof DOMException && error.name === 'AbortError')
        ) {
          return
        }
        requestIdRef.current = ''
        // A gravação continua disponível: só o score falhou.
        send({ type: 'ANALYSIS_FAILED' })
      }
    },
    [send],
  )

  // ---------------------------------------------------------------------
  // Finalização: resolve o offset, valida e dispara a análise
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (stateValue !== 'stopping') return

    const { onStopVideo, clockRef } = optionsRef.current
    const service = getService()
    const status = statusRef.current

    onStopVideo()
    service.disarm()

    const context = service.getContext()
    const endContextTime = context.currentTime
    const samples = bufferRef.current.toFloat32Array()
    const sampleRate = status?.sampleRate ?? context.sampleRate

    // O relógio já tem um bom ajuste (o vídeo acabou de tocar), então converter
    // "amostra 0" para tempo de vídeo é confiável AGORA — não seria no início,
    // quando ainda não havia quadros exibidos.
    const clock = clockRef.current
    clock?.syncAudioBridge()
    const mediaTimeAtFirstSample = clock?.contextTimeToMediaTime(startContextTimeRef.current)

    const continuity = checkContinuity(
      samples.length,
      startContextTimeRef.current,
      endContextTime,
      sampleRate,
    )

    const clockInfo: RecordingClockInfo = {
      sampleRate,
      startFrame: startFrameRef.current,
      videoStartMediaTime: 0,
      mediaStartOffsetMs: (mediaTimeAtFirstSample ?? 0) * 1000,
      estimatedInputLatencyMs: status?.baseLatencyMs ?? 0,
      clockConfidence: clock?.confidence ?? 0,
      sampleContinuityOk: continuity.ok,
    }

    let peak = 0
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
    const peakDb = peak <= 0 ? -120 : 20 * Math.log10(peak)

    // §100 — nada de processar caro sobre uma gravação vazia.
    if (samples.length < sampleRate * 0.5 || peakDb < SILENCE_PEAK_DB) {
      send({ type: 'TOO_QUIET' })
      return
    }

    // O WAV é montado ANTES de o worker receber `samples` — o buffer é
    // transferido na análise e ficaria inutilizável depois.
    const wavBuffer = encodeWav(samples, sampleRate)
    const wavUrl = URL.createObjectURL(new Blob([wavBuffer], { type: 'audio/wav' }))
    objectUrlsRef.current.push(wavUrl)

    const attemptNumber = stateRef.current.context.attempt + 1
    const durationMs = (samples.length / sampleRate) * 1000
    const activeSegmentId = optionsRef.current.segmentId
    // O id carrega o segmento para que tentativas de falas diferentes nunca
    // colidam, mesmo com o mesmo número de tentativa.
    const attemptId = `${optionsRef.current.sceneId}--${activeSegmentId ?? 'cena'}--${String(attemptNumber)}--${String(Date.now())}`

    setAttempts((previous) => [
      ...previous,
      {
        id: attemptId,
        attemptNumber,
        ...(activeSegmentId === undefined ? {} : { segmentId: activeSegmentId }),
        wavUrl,
        durationMs,
        clock: clockInfo,
        result: null,
      },
    ])

    const stored: StoredAttempt = {
      id: attemptId,
      sceneId: optionsRef.current.sceneId,
      attemptNumber,
      ...(activeSegmentId === undefined ? {} : { segmentId: activeSegmentId }),
      mode: stateRef.current.context.mode,
      storageKey: `${attemptId}.wav`,
      durationMs,
      sampleRate,
      clock: clockInfo,
      result: null,
      createdAt: new Date().toISOString(),
    }

    // Falhar ao salvar não pode custar a tentativa: o Blob em memória continua
    // tocando nesta sessão, e o usuário é avisado do que aconteceu (§58).
    const saveCompleted = saveAttempt(stored, wavBuffer).then(
      () => true,
      (error: unknown) => {
        if (mountedRef.current) {
          setStorageError(isDublaError(error) ? error.code : 'STORAGE_UNAVAILABLE')
        }
        return false
      },
    )

    send({ type: 'CAPTURED', clock: clockInfo, continuityOk: continuity.ok })

    if (optionsRef.current.skipAnalysis === true) {
      send({ type: 'ANALYZED' })
      return
    }

    void runAnalysis(
      samples,
      sampleRate,
      clockInfo,
      attemptNumber,
      attemptId,
      stateRef.current.context.mode,
      saveCompleted,
    )
  }, [stateValue, getService, runAnalysis, send])

  const currentAttempt = useMemo(() => attempts[attempts.length - 1] ?? null, [attempts])

  const bestAttempt = useMemo(() => {
    let best: RecorderAttempt | null = null
    for (const attempt of attempts) {
      const value = attempt.result?.overall.value
      if (value === null || value === undefined) continue
      if (value > (best?.result?.overall.value ?? -1)) best = attempt
    }
    return best
  }, [attempts])

  const cancel = useCallback(() => {
    getService().disarm()
    if (liveWaveformRef.current) resetLiveWaveform(liveWaveformRef.current)
    optionsRef.current.onStopVideo()
    send({ type: 'CANCEL' })
  }, [getService, send])

  return {
    state,
    send,
    supported,
    devices,
    deviceId,
    setDeviceId,
    level,
    liveWaveformRef,
    attempts,
    currentAttempt,
    bestAttempt,
    storageError,
    requestDub,
    cancel,
    stop: useCallback(() => {
      send({ type: 'STOP' })
    }, [send]),
    retry: useCallback(() => {
      const needsMicrophone = !stateRef.current.context.guards.micLive
      const sceneId = optionsRef.current.sceneId
      if (liveWaveformRef.current) beginLiveWaveformMonitoring(liveWaveformRef.current)
      send({ type: 'RETRY' })
      if (needsMicrophone) void startCapture(sceneId)
    }, [send, startCapture]),
    setMode: useCallback(
      (mode: DubMode) => {
        send({ type: 'SET_MODE', mode })
      },
      [send],
    ),
    refreshDevices,
  }
}
