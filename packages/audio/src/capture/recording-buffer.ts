/**
 * Acumula os blocos PCM entregues pelo worklet.
 *
 * Guarda os pedaços como chegaram e só concatena no fim. Concatenar a cada
 * bloco seria realocar o buffer inteiro ~12 vezes por segundo — para uma cena
 * de 45 s a 48 kHz isso é meio giga de cópias desnecessárias.
 */
export class RecordingBuffer {
  private chunks: Float32Array[] = []
  private length = 0

  append(samples: Float32Array): void {
    this.chunks.push(samples)
    this.length += samples.length
  }

  get sampleCount(): number {
    return this.length
  }

  clear(): void {
    this.chunks = []
    this.length = 0
  }

  toFloat32Array(): Float32Array {
    const output = new Float32Array(this.length)
    let offset = 0
    for (const chunk of this.chunks) {
      output.set(chunk, offset)
      offset += chunk.length
    }
    return output
  }
}

export interface ContinuityCheck {
  readonly ok: boolean
  /** Amostras que deveriam ter chegado, pelo relógio de áudio. */
  readonly expectedSamples: number
  readonly actualSamples: number
  readonly missingRatio: number
}

/**
 * Detecta se a aba foi suspensa durante a gravação (§104).
 *
 * O truque: o relógio do `AudioContext` continua andando quando a aba perde
 * prioridade, mas o worklet para de ser chamado. Se o tempo decorrido diz
 * "deveriam ter chegado 480 mil amostras" e só chegaram 300 mil, houve um
 * buraco — e o encaixe com o vídeo não pode ser afirmado.
 *
 * A tolerância de 2% cobre o arredondamento normal de blocos.
 */
export function checkContinuity(
  actualSamples: number,
  startContextTime: number,
  endContextTime: number,
  sampleRate: number,
): ContinuityCheck {
  const elapsed = Math.max(0, endContextTime - startContextTime)
  const expectedSamples = Math.round(elapsed * sampleRate)

  if (expectedSamples <= 0) {
    return { ok: true, expectedSamples: 0, actualSamples, missingRatio: 0 }
  }

  const missingRatio = Math.max(0, (expectedSamples - actualSamples) / expectedSamples)
  return {
    ok: missingRatio <= 0.02,
    expectedSamples,
    actualSamples,
    missingRatio,
  }
}
