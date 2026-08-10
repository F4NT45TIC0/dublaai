import { beforeAll, describe, expect, it } from 'vitest'
import type { Metric, ScoreResult } from '@dubla/shared'
import { extractFeatures, type ReferenceFeatures } from '@dubla/dsp'
import { computeScore } from '../engine'
import {
  buildReference,
  buildTrack,
  SCENE_SEGMENTS,
  SR,
  userFeatures,
} from './fixtures'

let reference: ReferenceFeatures

beforeAll(() => {
  reference = buildReference()
})

function value(metric: Metric): number {
  if (metric.value === null) {
    throw new Error(`métrica indisponível (${metric.reason ?? 'sem motivo declarado'})`)
  }
  return metric.value
}

/** Zera tudo fora da janela: simula ter gravado só um segmento. */
function onlyWithin(track: Float32Array, startMs: number, endMs: number): Float32Array {
  const output = new Float32Array(track.length)
  const from = Math.round((startMs / 1000) * SR)
  const to = Math.min(track.length, Math.round((endMs / 1000) * SR))
  for (let i = from; i < to; i += 1) output[i] = track[i] ?? 0
  return output
}

const SECOND = SCENE_SEGMENTS[1]
if (!SECOND) throw new Error('fixture sem segundo segmento')

const WINDOW = { startMs: SECOND.startMs - 300, endMs: SECOND.endMs + 300 }

describe('janela de análise (modo fala-a-fala)', () => {
  it('pontua bem a fala gravada quando a janela é respeitada', () => {
    const partial = onlyWithin(buildTrack(), WINDOW.startMs, WINDOW.endMs)

    const result = computeScore({
      mode: 'original',
      reference,
      user: userFeatures(partial),
      segments: [SECOND],
      recordingOffsetMs: 0,
      window: WINDOW,
    })

    expect(value(result.metrics.sync)).toBeGreaterThanOrEqual(90)
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0]?.zone).toBe('perfect')
  })

  it('devolve os tempos do segmento em coordenadas da cena, não da janela', () => {
    const partial = onlyWithin(buildTrack(), WINDOW.startMs, WINDOW.endMs)

    const result = computeScore({
      mode: 'original',
      reference,
      user: userFeatures(partial),
      segments: [SECOND],
      recordingOffsetMs: 0,
      window: WINDOW,
    })

    // A UI mostra "fala 2 de 3" e precisa dos tempos absolutos.
    expect(result.segments[0]?.startMs).toBe(SECOND.startMs)
    expect(result.segments[0]?.endMs).toBe(SECOND.endMs)
  })

  it('sem a janela, a mesma gravação parcial produziria um resultado enganoso', () => {
    const partial = onlyWithin(buildTrack(), WINDOW.startMs, WINDOW.endMs)

    const scoped = computeScore({
      mode: 'original',
      reference,
      user: userFeatures(partial),
      segments: [SECOND],
      recordingOffsetMs: 0,
      window: WINDOW,
    })

    // Sem recorte, o DTW compara a cena inteira contra uma gravação em que
    // dois terços do tempo são silêncio. É este o cenário que a janela existe
    // para evitar, e a diferença precisa ser visível.
    const unscoped = computeScore({
      mode: 'original',
      reference,
      user: userFeatures(partial),
      segments: SCENE_SEGMENTS,
      recordingOffsetMs: 0,
    })

    const scopedArticulation = scoped.metrics.articulation.value ?? 0
    const unscopedArticulation = unscoped.metrics.articulation.value ?? 0
    expect(scopedArticulation).toBeGreaterThan(unscopedArticulation)

    // E o modo sem janela pune as falas que a pessoa nem tentou gravar.
    expect(unscoped.segments.filter((entry) => entry.zone === 'missing').length).toBeGreaterThan(0)
  })

  it('não inventa nota para as falas fora da janela', () => {
    const partial = onlyWithin(buildTrack(), WINDOW.startMs, WINDOW.endMs)

    const result = computeScore({
      mode: 'original',
      reference,
      user: userFeatures(partial),
      segments: [SECOND],
      recordingOffsetMs: 0,
      window: WINDOW,
    })

    // Só o segmento pedido volta. Nada é afirmado sobre 1 e 3.
    expect(result.segments.map((entry) => entry.segmentId)).toEqual([SECOND.id])
  })

  it('rebaixa a articulação quando a janela tem pouca fala de referência', () => {
    const tiny = { startMs: SECOND.startMs, endMs: SECOND.startMs + 300 }
    const partial = onlyWithin(buildTrack(), tiny.startMs, tiny.endMs)

    const result = computeScore({
      mode: 'original',
      reference,
      user: userFeatures(partial),
      segments: [SECOND],
      recordingOffsetMs: 0,
      window: tiny,
    })

    // As âncoras foram calibradas sobre a cena inteira; num trecho de 300 ms
    // afirmar a mesma precisão seria esticar o que os dados sustentam.
    expect(result.metrics.articulation.status).not.toBe('ok')
    if (result.metrics.articulation.status === 'limited') {
      expect(result.metrics.articulation.reason).toMatch(/curto demais/)
    }
  })

  it('continua honesto com silêncio dentro da janela', () => {
    const silent = new Float32Array(Math.round((6 / 1) * SR))

    const result: ScoreResult = computeScore({
      mode: 'original',
      reference,
      user: extractFeatures(silent, SR),
      segments: [SECOND],
      recordingOffsetMs: 0,
      window: WINDOW,
    })

    expect(result.overall.status).toBe('unavailable')
    expect(result.overall.value).toBeNull()
  })

  it('é determinístico com janela', () => {
    const partial = onlyWithin(buildTrack(), WINDOW.startMs, WINDOW.endMs)
    const run = () =>
      computeScore({
        mode: 'original',
        reference,
        user: userFeatures(partial),
        segments: [SECOND],
        recordingOffsetMs: 0,
        window: WINDOW,
      })

    expect(JSON.stringify(run())).toBe(JSON.stringify(run()))
  })
})
