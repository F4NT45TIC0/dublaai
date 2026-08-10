/**
 * MediaClock — a ponte entre os três relógios do sistema (§17).
 *
 *   video.currentTime  ·  performance.now()  ·  AudioContext.currentTime
 *
 * Os três avançam em taxas ligeiramente diferentes. O relógio de áudio é o mais
 * estável (é derivado do cristal da placa); o do vídeo avança em degraus de
 * quadro; `performance.now()` é a base comum entre eles.
 *
 * O mapeamento é mantido como um AJUSTE AFIM sobre uma janela deslizante, e não
 * como uma leitura pontual. Uma leitura pontual carrega o jitter de um quadro
 * inteiro (33 ms a 30 fps) e não diz nada sobre a TAXA de avanço — que é
 * exatamente o que permite detectar drift e prever onde o vídeo vai estar.
 */

interface Sample {
  readonly mediaTimeSec: number
  readonly perfMs: number
}

/** ~1 s de histórico a 30 fps. Curto o bastante para acompanhar seek. */
const WINDOW_SIZE = 30
const MIN_SAMPLES_FOR_FIT = 6

export interface ClockReading {
  readonly mediaTimeSec: number
  readonly perfMs: number
  readonly confidence: number
}

export class MediaClock {
  private readonly video: HTMLVideoElement
  private samples: Sample[] = []
  private frameCallbackId: number | null = null
  private rafId: number | null = null
  private running = false

  /** Coeficientes de `mediaTimeSec = slope * perfMs + intercept`. */
  private slope = 0.001
  private intercept = 0
  private fitQuality = 0

  private audioContext: AudioContext | null = null
  /** `perfMs − contextTime*1000`, atualizado a cada leitura. */
  private audioToPerfOffsetMs = 0
  private audioBridgeValid = false

  /** `true` quando o navegador não expõe requestVideoFrameCallback. */
  readonly usesFallback: boolean

  constructor(video: HTMLVideoElement) {
    this.video = video
    this.usesFallback = typeof video.requestVideoFrameCallback !== 'function'
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.samples = []
    this.fitQuality = 0
    if (this.usesFallback) this.scheduleRaf()
    else this.scheduleFrameCallback()
  }

  stop(): void {
    this.running = false
    if (this.frameCallbackId !== null && typeof this.video.cancelVideoFrameCallback === 'function') {
      this.video.cancelVideoFrameCallback(this.frameCallbackId)
    }
    if (this.rafId !== null) cancelAnimationFrame(this.rafId)
    this.frameCallbackId = null
    this.rafId = null
  }

  /** Descarta o histórico. Obrigatório após seek — a reta antiga não vale mais. */
  reset(): void {
    this.samples = []
    this.fitQuality = 0
  }

  attachAudioContext(context: AudioContext): void {
    this.audioContext = context
    this.syncAudioBridge()
  }

  /**
   * Qualidade do ajuste (R²), 0..1.
   *
   * Cai quando o vídeo gagueja, quando a aba perde prioridade ou quando o
   * navegador não oferece rVFC. É o número que faz a sincronia ser reportada
   * como `limited` em vez de ser afirmada com falsa segurança.
   */
  get confidence(): number {
    if (this.usesFallback) return Math.min(this.fitQuality, 0.7)
    return this.fitQuality
  }

  get sampleCount(): number {
    return this.samples.length
  }

  /** Melhor estimativa do tempo de mídia neste instante. */
  now(): ClockReading {
    const perfMs = performance.now()
    const stationary = this.video.paused || this.video.seeking || this.video.ended
    return {
      // A reta continua útil para converter instantes históricos do áudio,
      // mas não pode extrapolar o playhead enquanto a mídia está parada.
      mediaTimeSec: stationary ? this.video.currentTime : this.mediaTimeAtPerf(perfMs),
      perfMs,
      confidence: this.confidence,
    }
  }

  /**
   * Tempo de mídia previsto para um instante de `performance.now()`.
   *
   * Com poucas amostras cai para `video.currentTime`, que é impreciso mas
   * nunca absurdo — melhor que extrapolar uma reta ajustada sobre dois pontos.
   */
  mediaTimeAtPerf(perfMs: number): number {
    if (this.samples.length < MIN_SAMPLES_FOR_FIT) return this.video.currentTime
    return this.slope * perfMs + this.intercept
  }

  /** Instante de `performance.now()` em que o vídeo alcança `mediaTimeSec`. */
  perfAtMediaTime(mediaTimeSec: number): number {
    if (this.samples.length < MIN_SAMPLES_FOR_FIT || this.slope === 0) {
      return performance.now() + (mediaTimeSec - this.video.currentTime) * 1000
    }
    return (mediaTimeSec - this.intercept) / this.slope
  }

  /**
   * Converte um instante do relógio de áudio para tempo de mídia.
   *
   * É este caminho que transforma "amostra número N do microfone" em "instante
   * X do vídeo" — a medição que o §18 exige e que o score usa como
   * `mediaStartOffsetMs`.
   */
  contextTimeToMediaTime(contextTimeSec: number): number | null {
    if (!this.audioBridgeValid) return null
    return this.mediaTimeAtPerf(contextTimeSec * 1000 + this.audioToPerfOffsetMs)
  }

  /**
   * Alinha o relógio de áudio ao de parede.
   *
   * `getOutputTimestamp()` devolve o par `{contextTime, performanceTime}` que
   * o navegador garante corresponder ao mesmo instante físico. Sem ele
   * restaria supor que `AudioContext.currentTime` e `performance.now()` andam
   * juntos — e eles não andam.
   */
  syncAudioBridge(): void {
    const context = this.audioContext
    if (!context) return

    const timestamp = context.getOutputTimestamp()
    if (
      typeof timestamp.contextTime === 'number' &&
      typeof timestamp.performanceTime === 'number' &&
      timestamp.contextTime > 0
    ) {
      this.audioToPerfOffsetMs = timestamp.performanceTime - timestamp.contextTime * 1000
      this.audioBridgeValid = true
      return
    }

    // Safari pode não popular getOutputTimestamp. A aproximação assume que os
    // dois relógios foram lidos no mesmo instante — pior, porém utilizável, e
    // a perda de precisão fica registrada na confiança.
    this.audioToPerfOffsetMs = performance.now() - context.currentTime * 1000
    this.audioBridgeValid = true
  }

  private scheduleFrameCallback(): void {
    this.frameCallbackId = this.video.requestVideoFrameCallback((_now, metadata) => {
      // `expectedDisplayTime` está na mesma base de performance.now(): é o
      // instante em que o quadro VAI aparecer, não o instante em que o callback
      // rodou. Usar `now` introduziria o atraso da fila de callbacks.
      this.push(metadata.mediaTime, metadata.expectedDisplayTime)
      if (this.running) this.scheduleFrameCallback()
    })
  }

  private scheduleRaf(): void {
    this.rafId = requestAnimationFrame((perfMs) => {
      if (!this.video.paused) this.push(this.video.currentTime, perfMs)
      if (this.running) this.scheduleRaf()
    })
  }

  private push(mediaTimeSec: number, perfMs: number): void {
    const previous = this.samples[this.samples.length - 1]
    // Um salto para trás, ou um pulo grande para a frente, significa seek: a
    // reta anterior descreve outra realidade.
    if (previous) {
      const delta = mediaTimeSec - previous.mediaTimeSec
      if (delta < -0.05 || delta > 1) this.samples = []
    }

    this.samples.push({ mediaTimeSec, perfMs })
    if (this.samples.length > WINDOW_SIZE) this.samples.shift()
    this.refit()
  }

  /** Regressão linear simples sobre a janela, com R² como confiança. */
  private refit(): void {
    const count = this.samples.length
    if (count < MIN_SAMPLES_FOR_FIT) {
      this.fitQuality = 0
      return
    }

    let sumX = 0
    let sumY = 0
    for (const sample of this.samples) {
      sumX += sample.perfMs
      sumY += sample.mediaTimeSec
    }
    const meanX = sumX / count
    const meanY = sumY / count

    let covariance = 0
    let varianceX = 0
    for (const sample of this.samples) {
      const dx = sample.perfMs - meanX
      covariance += dx * (sample.mediaTimeSec - meanY)
      varianceX += dx * dx
    }

    if (varianceX < 1e-9) {
      this.fitQuality = 0
      return
    }

    this.slope = covariance / varianceX
    this.intercept = meanY - this.slope * meanX

    let residual = 0
    let total = 0
    for (const sample of this.samples) {
      const predicted = this.slope * sample.perfMs + this.intercept
      const error = sample.mediaTimeSec - predicted
      residual += error * error
      const centered = sample.mediaTimeSec - meanY
      total += centered * centered
    }

    this.fitQuality = total < 1e-12 ? 0 : Math.max(0, Math.min(1, 1 - residual / total))
  }
}
