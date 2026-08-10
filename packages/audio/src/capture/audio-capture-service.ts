import { DublaError, mapMediaError, toDublaError } from '@dubla/shared'
import { CAPTURE_PROCESSOR_NAME, CAPTURE_WORKLET_URL } from '../constants'

/**
 * O ÚNICO lugar do código que chama `getUserMedia` (§22).
 *
 * Espalhar `getUserMedia` é como microfones ficam ligados depois que o usuário
 * sai da página: cada chamada cria tracks que alguém precisa lembrar de parar.
 * Aqui existe um dono, e ele tem `dispose()`.
 *
 * Um único `AudioContext` por sessão. Criar um por gravação é a causa mais
 * comum de degradação depois de 20 ou 30 tentativas (§68) — navegadores
 * limitam contextos simultâneos e os antigos não são coletados enquanto
 * houver nós conectados.
 */

export interface CaptureDevice {
  readonly deviceId: string
  readonly label: string
}

export interface CaptureLevel {
  readonly peak: number
  readonly recording: boolean
  readonly clippedRatio: number
}

export interface CaptureStart {
  /** Índice global da primeira amostra gravada, vindo de `currentFrame`. */
  readonly startFrame: number
  /** `AudioContext.currentTime` no mesmo instante. */
  readonly contextTime: number
  readonly sampleRate: number
}

export interface CaptureCallbacks {
  onChunk?: (samples: Float32Array) => void
  onLevel?: (level: CaptureLevel) => void
  onStarted?: (start: CaptureStart) => void
  /** Disparado quando a track morre no meio (cabo, permissão revogada). */
  onTrackEnded?: () => void
  onDeviceChange?: () => void
}

export interface CaptureStatus {
  readonly sampleRate: number
  /** `true` se o navegador ignorou a constraint e aplicou AGC. */
  readonly autoGainControlActive: boolean
  readonly echoCancellationActive: boolean
  readonly noiseSuppressionActive: boolean
  readonly deviceLabel: string
  readonly baseLatencyMs: number
}

export class AudioCaptureService {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private worklet: AudioWorkletNode | null = null
  /** Contexto no qual o módulo do worklet já foi registrado. */
  private workletLoadedFor: AudioContext | null = null
  private callbacks: CaptureCallbacks = {}
  private deviceChangeHandler: (() => void) | null = null
  /** Invalida `start()` ainda aguardando permissão, resume ou carregamento do worklet. */
  private startGeneration = 0

  /**
   * Lista dispositivos de entrada.
   *
   * Antes de conceder permissão, o navegador esconde os rótulos e devolve
   * strings vazias — comportamento normal, não erro (§21). Nesse caso damos um
   * nome genérico em vez de mostrar uma lista vazia, que pareceria "nenhum
   * microfone encontrado".
   */
  async listDevices(): Promise<CaptureDevice[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return []

    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices
      .filter((device) => device.kind === 'audioinput')
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label.length > 0 ? device.label : `Microfone ${String(index + 1)}`,
      }))
  }

  /** Cria (ou devolve) o contexto da sessão. Deve ser chamado sob gesto. */
  getContext(): AudioContext {
    this.context ??= new AudioContext({ latencyHint: 'interactive' })
    return this.context
  }

  /**
   * `AudioContext` nasce `suspended` no Safari e no Chrome sem interação. Sem
   * o resume, a captura roda em silêncio e nada indica o motivo (§66).
   */
  async resume(): Promise<void> {
    const context = this.getContext()
    if (context.state === 'suspended') await context.resume()
  }

  async start(deviceId: string | undefined, callbacks: CaptureCallbacks): Promise<CaptureStatus> {
    const generation = this.startGeneration + 1
    this.startGeneration = generation
    this.releaseCapture()
    this.callbacks = callbacks

    let requestedStream: MediaStream | null = null
    try {
      requestedStream = await this.requestStream(deviceId)
      this.assertCurrentStart(generation, requestedStream)
      this.stream = requestedStream

      const track = requestedStream.getAudioTracks()[0]
      if (!track) throw new DublaError('MIC_NOT_FOUND')

      track.addEventListener('ended', () => {
        if (generation === this.startGeneration && this.stream === requestedStream) {
          this.callbacks.onTrackEnded?.()
        }
      })

      const context = this.getContext()
      await this.resume()
      this.assertCurrentStart(generation, requestedStream)
      await this.ensureWorklet(context)
      this.assertCurrentStart(generation, requestedStream)

      this.source = context.createMediaStreamSource(requestedStream)
      this.worklet = new AudioWorkletNode(context, CAPTURE_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
      })

      this.worklet.port.onmessage = (event: MessageEvent<unknown>) => {
        this.handleWorkletMessage(event.data)
      }

      this.source.connect(this.worklet)

      if (!this.deviceChangeHandler && navigator.mediaDevices) {
        this.deviceChangeHandler = () => {
          this.callbacks.onDeviceChange?.()
        }
        navigator.mediaDevices.addEventListener('devicechange', this.deviceChangeHandler)
      }

      // Nunca confiar na constraint: verificar o que o navegador de fato aplicou.
      const settings = track.getSettings()
      return {
        sampleRate: context.sampleRate,
        autoGainControlActive: settings.autoGainControl === true,
        echoCancellationActive: settings.echoCancellation === true,
        noiseSuppressionActive: settings.noiseSuppression === true,
        deviceLabel: track.label,
        baseLatencyMs: (context.baseLatency || 0) * 1000,
      }
    } catch (error) {
      if (this.stream === requestedStream) this.releaseCapture()
      else stopStream(requestedStream)
      if (generation === this.startGeneration) this.callbacks = {}
      throw error
    }
  }

  /** Arma a captura. O worklet responde com o `startFrame` exato. */
  arm(): void {
    this.worklet?.port.postMessage({ type: 'arm' })
  }

  /** Desarma e libera o que restou no buffer do worklet. */
  disarm(): void {
    this.worklet?.port.postMessage({ type: 'disarm' })
  }

  /**
   * Libera tudo (§67).
   *
   * O `AudioContext` NÃO é fechado: ele pertence à sessão, não a esta
   * gravação. Fechar e recriar a cada tentativa é justamente o que degrada
   * depois de algumas dezenas de gravações.
   */
  dispose(): void {
    this.startGeneration += 1
    this.releaseCapture()

    if (this.deviceChangeHandler && navigator.mediaDevices) {
      navigator.mediaDevices.removeEventListener('devicechange', this.deviceChangeHandler)
      this.deviceChangeHandler = null
    }

    this.callbacks = {}
  }

  /** Fecha o contexto. Só ao encerrar a sessão inteira. */
  async close(): Promise<void> {
    this.dispose()
    const context = this.context
    this.context = null
    if (this.workletLoadedFor === context) this.workletLoadedFor = null
    if (context && context.state !== 'closed') {
      await context.close()
    }
  }

  private releaseCapture(): void {
    this.disarm()

    if (this.worklet) {
      this.worklet.port.onmessage = null
      this.worklet.disconnect()
      this.worklet = null
    }
    if (this.source) {
      this.source.disconnect()
      this.source = null
    }

    this.releaseStream()
  }

  private releaseStream(): void {
    if (!this.stream) return
    for (const track of this.stream.getTracks()) track.stop()
    this.stream = null
  }

  private async requestStream(deviceId: string | undefined): Promise<MediaStream> {
    // Os três processamentos ficam desligados de propósito: o vídeo é mudo
    // (não há eco a cancelar), o AGC destruiria a métrica de ENERGIA e o
    // supressor de ruído altera o espectro de forma dependente do conteúdo,
    // contaminando MFCC e F0. Ver docs/AUDIO_PIPELINE.md §2.
    const audio: MediaTrackConstraints = {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    }
    if (deviceId !== undefined && deviceId.length > 0) audio.deviceId = { exact: deviceId }

    try {
      return await navigator.mediaDevices.getUserMedia({ audio })
    } catch (error) {
      // Dispositivo pedido sumiu entre listar e usar: repetir sem exigir o
      // deviceId é melhor que mostrar erro para algo que resolve sozinho.
      if (mapMediaError(error) === 'MIC_OVERCONSTRAINED' && audio.deviceId) {
        delete audio.deviceId
        try {
          return await navigator.mediaDevices.getUserMedia({ audio })
        } catch (retryError) {
          throw toDublaError(retryError)
        }
      }
      throw toDublaError(error)
    }
  }

  private async ensureWorklet(context: AudioContext): Promise<void> {
    if (this.workletLoadedFor === context) return
    if (!context.audioWorklet) throw new DublaError('BROWSER_UNSUPPORTED')

    try {
      await context.audioWorklet.addModule(CAPTURE_WORKLET_URL)
      this.workletLoadedFor = context
    } catch (error) {
      throw new DublaError('BROWSER_UNSUPPORTED', { cause: error })
    }
  }

  private assertCurrentStart(generation: number, stream: MediaStream): void {
    if (generation === this.startGeneration) return
    stopStream(stream)
    throw new DOMException('Inicialização de captura cancelada.', 'AbortError')
  }

  private handleWorkletMessage(data: unknown): void {
    if (typeof data !== 'object' || data === null || !('type' in data)) return
    const message = data as Record<string, unknown>

    switch (message['type']) {
      case 'chunk':
        if (message['samples'] instanceof Float32Array) {
          this.callbacks.onChunk?.(message['samples'])
        }
        break
      case 'started':
        this.callbacks.onStarted?.({
          startFrame: Number(message['startFrame']),
          contextTime: Number(message['contextTime']),
          sampleRate: Number(message['sampleRate']),
        })
        break
      case 'level':
        this.callbacks.onLevel?.({
          peak: Number(message['peak']),
          recording: message['recording'] === true,
          clippedRatio: Number(message['clippedRatio']),
        })
        break
      default:
        break
    }
  }
}

function stopStream(stream: MediaStream | null): void {
  if (!stream) return
  for (const track of stream.getTracks()) track.stop()
}

/** Detecção de suporte antes de pedir qualquer permissão (§20). */
export function isCaptureSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof AudioWorkletNode === 'function' &&
    typeof AudioContext === 'function'
  )
}
