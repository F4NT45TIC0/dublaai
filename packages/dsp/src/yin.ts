import { F0_MAX_HZ, F0_MIN_HZ, YIN_THRESHOLD } from './constants'

export interface PitchEstimate {
  /** Hz, ou 0 quando o quadro não é sonoro. */
  readonly frequency: number
  /** 0..1 — quanto menor, mais periódico (mais confiável). */
  readonly aperiodicity: number
}

const UNVOICED: PitchEstimate = { frequency: 0, aperiodicity: 1 }

/**
 * Estimador de F0 pelo algoritmo YIN.
 *
 * Escolhido em vez de autocorrelação simples porque a normalização cumulativa
 * elimina o erro de oitava — autocorrelação pura tende a escolher o dobro do
 * período em vozes graves, e uma métrica de entonação com saltos de oitava
 * fantasma seria pior que nenhuma métrica.
 */
export class YinDetector {
  private readonly sampleRate: number
  private readonly windowSize: number
  private readonly minLag: number
  private readonly maxLag: number
  private readonly difference: Float64Array
  private readonly cumulative: Float64Array

  constructor(sampleRate: number, windowSize: number) {
    this.sampleRate = sampleRate
    this.windowSize = windowSize
    this.minLag = Math.max(2, Math.floor(sampleRate / F0_MAX_HZ))
    this.maxLag = Math.min(Math.floor(windowSize / 2), Math.ceil(sampleRate / F0_MIN_HZ))

    // A checagem é contra o lag EXIGIDO por F0_MIN_HZ, não contra `minLag`.
    // Uma janela de 256 amostras a 16 kHz passaria pela comparação ingênua
    // (maxLag 128 > minLag 40) e, em silêncio, reportaria toda voz abaixo de
    // 125 Hz como não sonora — um viés contra vozes graves que nunca apareceria
    // como erro, só como entonação indisponível.
    const requiredLag = Math.ceil(sampleRate / F0_MIN_HZ)
    if (Math.floor(windowSize / 2) < requiredLag) {
      throw new Error(
        `YinDetector: janela de ${String(windowSize)} amostras é curta demais para detectar ${String(F0_MIN_HZ)} Hz (precisa de ao menos ${String(requiredLag * 2)})`,
      )
    }

    this.difference = new Float64Array(this.maxLag + 1)
    this.cumulative = new Float64Array(this.maxLag + 1)
  }

  estimate(frame: Float32Array): PitchEstimate {
    if (frame.length < this.windowSize) return UNVOICED

    const half = Math.floor(this.windowSize / 2)
    const diff = this.difference
    const cmnd = this.cumulative

    // Função diferença: d(τ) = Σ (x[j] − x[j+τ])²
    diff[0] = 0
    for (let lag = 1; lag <= this.maxLag; lag += 1) {
      let sum = 0
      for (let j = 0; j < half; j += 1) {
        const delta = (frame[j] ?? 0) - (frame[j + lag] ?? 0)
        sum += delta * delta
      }
      diff[lag] = sum
    }

    // Diferença média cumulativa normalizada — o passo que mata o erro de oitava.
    cmnd[0] = 1
    let runningSum = 0
    for (let lag = 1; lag <= this.maxLag; lag += 1) {
      const value = diff[lag] ?? 0
      runningSum += value
      cmnd[lag] = runningSum === 0 ? 1 : (value * lag) / runningSum
    }

    // Primeiro mínimo local abaixo do limiar absoluto. Depois de cruzar o
    // limiar, desce até o fundo do vale antes de aceitar o lag.
    let chosen = -1
    for (let lag = this.minLag; lag <= this.maxLag; lag += 1) {
      if ((cmnd[lag] ?? 1) >= YIN_THRESHOLD) continue
      let valley = lag
      while (valley + 1 <= this.maxLag && (cmnd[valley + 1] ?? 1) < (cmnd[valley] ?? 1)) {
        valley += 1
      }
      chosen = valley
      break
    }

    // Sem nada abaixo do limiar, cai para o mínimo global — mas a
    // aperiodicidade resultante é alta, e quem chamou decide o que fazer.
    if (chosen === -1) {
      let best = this.minLag
      for (let lag = this.minLag + 1; lag <= this.maxLag; lag += 1) {
        if ((cmnd[lag] ?? 1) < (cmnd[best] ?? 1)) best = lag
      }
      chosen = best
    }

    const refined = this.interpolate(chosen)
    const frequency = this.sampleRate / refined
    if (frequency < F0_MIN_HZ || frequency > F0_MAX_HZ) return UNVOICED

    return { frequency, aperiodicity: Math.min(1, Math.max(0, cmnd[chosen] ?? 1)) }
  }

  /**
   * Interpolação parabólica em torno do mínimo.
   *
   * Sem ela, a resolução de F0 seria a resolução do lag em amostras: a 16 kHz,
   * 200 Hz e 205 Hz caem no mesmo lag inteiro. Uma métrica de entonação em
   * cents precisa de mais precisão que isso.
   */
  private interpolate(lag: number): number {
    if (lag <= 0 || lag >= this.maxLag) return lag
    const previous = this.cumulative[lag - 1] ?? 0
    const current = this.cumulative[lag] ?? 0
    const next = this.cumulative[lag + 1] ?? 0
    const denominator = 2 * (2 * current - next - previous)
    if (denominator === 0) return lag
    const shift = (next - previous) / denominator
    return Math.abs(shift) < 1 ? lag + shift : lag
  }
}

/** Converte Hz para cents relativos a uma referência. */
export function hzToCents(hz: number, referenceHz: number): number {
  if (hz <= 0 || referenceHz <= 0) return Number.NaN
  return 1200 * Math.log2(hz / referenceHz)
}
