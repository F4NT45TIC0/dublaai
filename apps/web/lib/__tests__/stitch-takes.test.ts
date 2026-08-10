import { describe, expect, it } from 'vitest'
import { stitchTakes, type Take } from '../stitch-takes'

const SR = 16_000

/** Tom constante, para localizar exatamente onde a tomada caiu. */
function tone(durationMs: number, amplitude = 0.5, sampleRate = SR): Float32Array {
  const samples = new Float32Array(Math.round((durationMs / 1000) * sampleRate))
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / sampleRate)
  }
  return samples
}

function firstLoudSample(samples: Float32Array, threshold = 0.05): number {
  for (let i = 0; i < samples.length; i += 1) {
    if (Math.abs(samples[i] ?? 0) > threshold) return i
  }
  return -1
}

function lastLoudSample(samples: Float32Array, threshold = 0.05): number {
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    if (Math.abs(samples[i] ?? 0) > threshold) return i
  }
  return -1
}

describe('stitchTakes', () => {
  it('posiciona a tomada no instante do vídeo, descartando o pré-roll', () => {
    // Gravação armada 3 s antes do vídeo, cobrindo a fala de 2000 a 3000 ms.
    const take: Take = {
      samples: tone(6_000),
      sampleRate: SR,
      mediaStartOffsetMs: -3_000,
      windowStartMs: 2_000,
      windowEndMs: 3_000,
    }

    const { samples, placed } = stitchTakes([take], 6_000, SR)

    expect(placed).toBe(1)
    const start = firstLoudSample(samples)
    const end = lastLoudSample(samples)

    // 2000 ms a 16 kHz = amostra 32000. A rampa de 20 ms tolera ~320 amostras.
    expect(Math.abs(start - 32_000)).toBeLessThan(500)
    expect(Math.abs(end - 48_000)).toBeLessThan(500)
  })

  it('lida com offset positivo (gravação começou depois do vídeo)', () => {
    const take: Take = {
      samples: tone(4_000),
      sampleRate: SR,
      mediaStartOffsetMs: 1_000,
      windowStartMs: 1_500,
      windowEndMs: 2_500,
    }

    const { samples } = stitchTakes([take], 6_000, SR)
    expect(Math.abs(firstLoudSample(samples) - 24_000)).toBeLessThan(500)
  })

  it('mantém as tomadas separadas em suas próprias janelas', () => {
    const takes: Take[] = [
      {
        samples: tone(5_000),
        sampleRate: SR,
        mediaStartOffsetMs: -3_000,
        windowStartMs: 500,
        windowEndMs: 1_200,
      },
      {
        // Precisa cobrir de −3000 até 3800 ms de vídeo: 7 s de gravação.
        samples: tone(7_000),
        sampleRate: SR,
        mediaStartOffsetMs: -3_000,
        windowStartMs: 3_000,
        windowEndMs: 3_800,
      },
    ]

    const { samples, placed } = stitchTakes(takes, 5_000, SR)
    expect(placed).toBe(2)

    const silentGap = samples.subarray(Math.round(1.6 * SR), Math.round(2.6 * SR))
    let gapPeak = 0
    for (const sample of silentGap) gapPeak = Math.max(gapPeak, Math.abs(sample))

    // Entre as duas falas não pode sobrar áudio de nenhuma delas.
    expect(gapPeak).toBeLessThan(0.02)
  })

  it('não deixa clique nas bordas', () => {
    const take: Take = {
      samples: tone(4_000, 0.9),
      sampleRate: SR,
      mediaStartOffsetMs: 0,
      windowStartMs: 1_000,
      windowEndMs: 2_000,
    }

    const { samples } = stitchTakes([take], 4_000, SR)

    // A maior variação entre amostras vizinhas mede a descontinuidade. Um
    // corte seco num tom de 0.9 saltaria bem acima disto.
    let maxJump = 0
    for (let i = 1; i < samples.length; i += 1) {
      maxJump = Math.max(maxJump, Math.abs((samples[i] ?? 0) - (samples[i - 1] ?? 0)))
    }
    expect(maxJump).toBeLessThan(0.2)
  })

  it('converte tomadas gravadas em outra taxa', () => {
    const take: Take = {
      samples: tone(4_000, 0.5, 48_000),
      sampleRate: 48_000,
      mediaStartOffsetMs: -1_000,
      windowStartMs: 1_000,
      windowEndMs: 2_000,
    }

    const { samples } = stitchTakes([take], 4_000, SR)
    expect(Math.abs(firstLoudSample(samples) - 16_000)).toBeLessThan(600)
  })

  it('devolve silêncio quando não há tomadas', () => {
    const { samples, placed } = stitchTakes([], 3_000, SR)
    expect(placed).toBe(0)
    expect(samples).toHaveLength(48_000)
    expect(firstLoudSample(samples)).toBe(-1)
  })

  it('ignora tomada cuja janela caiu fora da cena', () => {
    const take: Take = {
      samples: tone(2_000),
      sampleRate: SR,
      mediaStartOffsetMs: 0,
      windowStartMs: 9_000,
      windowEndMs: 10_000,
    }
    expect(stitchTakes([take], 5_000, SR).placed).toBe(0)
  })

  it('ignora tomada curta demais para cobrir a própria janela', () => {
    // Gravação de 2 s armada 3 s antes do vídeo cobre de −3000 a −1000 ms:
    // não alcança nenhum instante positivo da cena.
    const take: Take = {
      samples: tone(2_000),
      sampleRate: SR,
      mediaStartOffsetMs: -3_000,
      windowStartMs: 1_000,
      windowEndMs: 2_000,
    }
    expect(stitchTakes([take], 5_000, SR).placed).toBe(0)
  })

  it('normaliza quando a soma de tomadas sobrepostas estoura', () => {
    const overlapping: Take[] = [0, 1].map(() => ({
      samples: tone(3_000, 0.9),
      sampleRate: SR,
      mediaStartOffsetMs: 0,
      windowStartMs: 500,
      windowEndMs: 2_500,
    }))

    const { samples } = stitchTakes(overlapping, 3_000, SR)
    let peak = 0
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
    expect(peak).toBeLessThanOrEqual(1.0001)
  })
})
