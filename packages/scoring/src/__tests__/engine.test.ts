import { beforeAll, describe, expect, it } from 'vitest'
import type { Metric, MetricKey, ScoreResult } from '@dubla/shared'
import { whiteNoise } from '@dubla/dsp/testing'
import { extractFeatures, type ReferenceFeatures } from '@dubla/dsp'
import { computeScore, type ScoreInput } from '../engine'
import { DEFAULT_SCORE_CONFIG, ENGINE_VERSION } from '../config'
import {
  buildReference,
  buildTrack,
  SCENE_DURATION_MS,
  SCENE_SEGMENTS,
  SR,
  UNRELATED_PHRASES,
  userFeatures,
} from './fixtures'

let reference: ReferenceFeatures

beforeAll(() => {
  reference = buildReference()
})

function score(track: Float32Array, overrides: Partial<ScoreInput> = {}): ScoreResult {
  return computeScore({
    mode: 'original',
    reference,
    user: userFeatures(track),
    segments: SCENE_SEGMENTS,
    recordingOffsetMs: 0,
    ...overrides,
  })
}

function value(metric: Metric): number {
  if (metric.value === null) {
    throw new Error(`métrica indisponível (${metric.reason ?? 'sem motivo declarado'})`)
  }
  return metric.value
}

describe('âncoras de calibração', () => {
  it('separa a fala relacionada da não relacionada', () => {
    // Se dChance não for maior que dFloor, a articulação não tem régua e o
    // score inteiro perde o significado (docs/SCORING.md §3.2).
    expect(reference.anchors.dChance).toBeGreaterThan(reference.anchors.dFloor)
    expect(reference.anchors.dFloor).toBeGreaterThanOrEqual(0)
  })
})

describe('dublagem alinhada', () => {
  it('pontua alto em todas as métricas quando a gravação é a própria referência', () => {
    const result = score(buildTrack())

    expect(value(result.metrics.sync)).toBeGreaterThanOrEqual(98)
    expect(value(result.metrics.articulation)).toBeGreaterThanOrEqual(95)
    expect(value(result.metrics.rhythm)).toBeGreaterThanOrEqual(95)
    expect(value(result.overall)).toBeGreaterThanOrEqual(90)
    expect(result.overall.status).toBe('ok')
  })

  it('classifica todas as falas como PERFEITO', () => {
    const result = score(buildTrack())
    expect(result.segments).toHaveLength(SCENE_SEGMENTS.length)
    for (const segment of result.segments) {
      expect(segment.zone).toBe('perfect')
      expect(Math.abs(segment.onsetDeltaMs ?? 999)).toBeLessThanOrEqual(120)
    }
  })

  it('mantém nota alta com uma voz de registro totalmente diferente', () => {
    // O ponto central do §0 do SCORING.md: a nota mede a dublagem, não as
    // cordas vocais. Uma oitava acima não pode derrubar o resultado.
    const result = score(buildTrack({ f0Hz: 260 }))
    expect(value(result.metrics.articulation)).toBeGreaterThanOrEqual(60)
    expect(value(result.metrics.sync)).toBeGreaterThanOrEqual(95)
  })
})

describe('deslocamento no tempo', () => {
  it('não penaliza um atraso pequeno', () => {
    const result = score(buildTrack({ globalDelayMs: 50 }))
    expect(value(result.metrics.sync)).toBeGreaterThanOrEqual(95)
  })

  it('compensa o atraso sistemático do equipamento e o reporta em separado', () => {
    const result = score(buildTrack({ globalDelayMs: 300 }))

    // O atraso é do setup, não da pessoa: as métricas não podem puni-lo...
    expect(value(result.metrics.sync)).toBeGreaterThanOrEqual(90)
    // ...mas ele precisa ser visível.
    expect(result.globalOffsetMs).toBeGreaterThanOrEqual(240)
    expect(result.globalOffsetConfidence).toBeGreaterThan(0.5)
  })

  it('penaliza o atraso de uma fala só e a identifica', () => {
    const aligned = score(buildTrack())
    const delayed = score(buildTrack({ perSegmentDelayMs: [0, 500, 0] }))

    expect(value(delayed.metrics.sync)).toBeLessThan(value(aligned.metrics.sync) - 15)

    const second = delayed.segments[1]
    expect(second).toBeDefined()
    expect(second?.zone).toBe('late')
    expect(second?.onsetDeltaMs ?? 0).toBeGreaterThan(300)

    // As outras falas continuam perfeitas — o feedback aponta a fala certa.
    expect(delayed.segments[0]?.zone).toBe('perfect')
    expect(delayed.segments[2]?.zone).toBe('perfect')
  })

  it('reconhece adiantamento como zona própria', () => {
    const result = score(buildTrack({ perSegmentDelayMs: [0, 0, -450] }))
    expect(result.segments[2]?.zone).toBe('early')
    expect(result.segments[2]?.onsetDeltaMs ?? 0).toBeLessThan(0)
  })
})

describe('andamento', () => {
  it('penaliza quem fala muito mais rápido', () => {
    const result = score(buildTrack({ tempo: 0.6 }))
    expect(value(result.metrics.rhythm)).toBeLessThanOrEqual(75)
  })

  it('penaliza quem fala muito mais devagar', () => {
    const result = score(buildTrack({ tempo: 1.6 }))
    expect(value(result.metrics.rhythm)).toBeLessThanOrEqual(75)
  })

  it('reporta a direção do desvio por fala', () => {
    const fast = score(buildTrack({ tempo: 0.6 }))
    const ratios = fast.segments
      .map((segment) => segment.tempoRatio)
      .filter((ratio): ratio is number => ratio !== null)

    expect(ratios.length).toBeGreaterThan(0)
    expect(Math.min(...ratios)).toBeLessThan(1)
  })
})

describe('conteúdo diferente', () => {
  it('dá articulação baixa para uma fala não relacionada', () => {
    const result = score(buildTrack({ phrases: UNRELATED_PHRASES }))
    expect(value(result.metrics.articulation)).toBeLessThanOrEqual(35)
  })

  it('mantém a sincronia alta mesmo com o texto trocado', () => {
    // Encaixar no tempo e dizer outra coisa são coisas independentes — e o
    // modo Paródia depende de que sejam medidas separadamente.
    const result = score(buildTrack({ phrases: UNRELATED_PHRASES }))
    expect(value(result.metrics.sync)).toBeGreaterThanOrEqual(90)
  })
})

describe('degradação honesta (§12)', () => {
  it('não inventa nota para uma gravação inaudível', () => {
    const result = score(buildTrack({ amplitude: 0.0005 }))

    expect(result.overall.value).toBeNull()
    expect(result.overall.status).toBe('unavailable')
    expect(result.overall.reason).toBeTruthy()
    for (const key of Object.keys(result.metrics) as MetricKey[]) {
      expect(result.metrics[key].value).toBeNull()
    }
  })

  it('não inventa nota para silêncio absoluto', () => {
    const result = score(new Float32Array(Math.round((SCENE_DURATION_MS / 1000) * SR)))
    expect(result.overall.status).toBe('unavailable')
  })

  it('marca a articulação como indisponível sob ruído alto', () => {
    const noise = whiteNoise(SCENE_DURATION_MS / 1000, SR, 0.35)
    const result = score(noise)
    expect(['unavailable', 'limited']).toContain(result.metrics.articulation.status)
    if (result.metrics.articulation.status !== 'ok') {
      expect(result.metrics.articulation.reason).toBeTruthy()
    }
  })

  it('exige motivo declarado em toda métrica que não está ok', () => {
    const result = score(buildTrack({ amplitude: 0.01 }))
    for (const key of Object.keys(result.metrics) as MetricKey[]) {
      const entry = result.metrics[key]
      if (entry.status !== 'ok') expect(entry.reason, `métrica ${key}`).toBeTruthy()
    }
  })

  it('rebaixa a sincronia quando a aba foi suspensa', () => {
    const result = score(buildTrack(), { flags: { sampleContinuityOk: false } })
    expect(result.metrics.sync.status).toBe('limited')
    expect(result.metrics.sync.reason).toMatch(/segundo plano/)
  })

  it('rebaixa a energia quando o navegador aplicou AGC', () => {
    const result = score(buildTrack(), { flags: { autoGainControlActive: true } })
    expect(result.metrics.energy.status).toBe('limited')
    expect(result.metrics.energy.reason).toMatch(/ganho/)
  })
})

describe('modo paródia (§13)', () => {
  it('desliga articulação e entonação sem chamá-las de falha', () => {
    const result = score(buildTrack({ phrases: UNRELATED_PHRASES }), { mode: 'parody' })

    expect(result.metrics.articulation.status).toBe('unavailable')
    expect(result.metrics.articulation.reason).toMatch(/paródia/)
    expect(result.metrics.pitch.status).toBe('unavailable')
  })

  it('ainda produz um resultado geral válido a partir de sincronia e ritmo', () => {
    const result = score(buildTrack({ phrases: UNRELATED_PHRASES }), { mode: 'parody' })

    expect(result.overall.value).not.toBeNull()
    expect(value(result.overall)).toBeGreaterThan(60)
    expect(value(result.metrics.occupancy)).toBeGreaterThan(0)
  })

  it('não penaliza texto diferente — paródia pontua melhor que o modo original', () => {
    const track = buildTrack({ phrases: UNRELATED_PHRASES })
    const original = score(track, { mode: 'original' })
    const parody = score(track, { mode: 'parody' })
    expect(value(parody.overall)).toBeGreaterThan(value(original.overall))
  })
})

describe('combinação de pesos', () => {
  it('renormaliza sobre as métricas disponíveis em vez de zerar as faltantes', () => {
    const result = score(buildTrack(), { mode: 'parody' })
    const { sync, rhythm, occupancy } = result.metrics
    const weights = DEFAULT_SCORE_CONFIG.weights.parody

    const total = (weights.sync ?? 0) + (weights.rhythm ?? 0) + (weights.occupancy ?? 0)
    const expected =
      ((weights.sync ?? 0) * value(sync) +
        (weights.rhythm ?? 0) * value(rhythm) +
        (weights.occupancy ?? 0) * value(occupancy)) /
      total

    // As notas saem inteiras do motor: treze casas decimais afirmariam uma
    // precisão que o alinhamento quadro a quadro não tem. A conta de
    // renormalização continua sendo a mesma — a diferença é só o arredondamento
    // das partes, que aqui pode deslocar o total em até um ponto.
    expect(value(result.overall)).toBeCloseTo(Math.round(expected), 0)
    expect(Number.isInteger(value(result.overall))).toBe(true)
  })

  it('respeita uma configuração de pesos alternativa', () => {
    const track = buildTrack({ tempo: 0.6 })
    const rhythmHeavy = score(track, {
      config: {
        ...DEFAULT_SCORE_CONFIG,
        version: 'test-rhythm-heavy',
        weights: { ...DEFAULT_SCORE_CONFIG.weights, original: { sync: 5, rhythm: 95 } },
      },
    })
    const syncHeavy = score(track, {
      config: {
        ...DEFAULT_SCORE_CONFIG,
        version: 'test-sync-heavy',
        weights: { ...DEFAULT_SCORE_CONFIG.weights, original: { sync: 95, rhythm: 5 } },
      },
    })

    expect(value(rhythmHeavy.overall)).toBeLessThan(value(syncHeavy.overall))
    expect(rhythmHeavy.configVersion).toBe('test-rhythm-heavy')
  })
})

describe('versionamento e determinismo', () => {
  it('carimba versão do motor e da configuração (§52)', () => {
    const result = score(buildTrack())
    expect(result.engineVersion).toBe(ENGINE_VERSION)
    expect(result.configVersion).toBe(DEFAULT_SCORE_CONFIG.version)
  })

  it('produz exatamente o mesmo resultado para a mesma entrada', () => {
    const track = buildTrack({ globalDelayMs: 80, tempo: 1.1 })
    const first = score(track)
    const second = score(track)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })
})

describe('offset de gravação (§18)', () => {
  it('usa o offset medido para posicionar a gravação na timeline do vídeo', () => {
    // Gravação que começou 1s depois do início do vídeo, contendo apenas o que
    // veio a partir dali. Sem aplicar o offset, tudo apareceria 1s adiantado.
    const full = buildTrack()
    const late = full.subarray(SR)

    const result = computeScore({
      mode: 'original',
      reference,
      user: extractFeatures(new Float32Array(late), SR),
      segments: SCENE_SEGMENTS,
      recordingOffsetMs: 1_000,
    })

    expect(result.segments[1]?.zone).toBe('perfect')
    expect(result.segments[2]?.zone).toBe('perfect')
  })
})
