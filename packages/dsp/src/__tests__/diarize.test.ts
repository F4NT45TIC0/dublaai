import { describe, expect, it } from 'vitest'
import { ANALYSIS_SAMPLE_RATE } from '../constants'
import { estimateSpeakerCount } from '../diarize'
import { extractFeatures } from '../features'
import {
  concat,
  type Phoneme,
  silence,
  synthesizeUtterance,
  VOWELS,
  whiteNoise,
} from '../testing/signals'

const SR = ANALYSIS_SAMPLE_RATE

const PHRASE_A = [VOWELS.o, VOWELS.a, VOWELS.i] as const
const PHRASE_B = [VOWELS.e, VOWELS.u, VOWELS.a] as const

/** Alterna falas de duas vozes, separadas por pausas longas o bastante. */
function conversation(
  turns: readonly { f0Hz: number; phonemes: readonly Phoneme[] }[],
): Float32Array {
  const chunks: Float32Array[] = [silence(0.4, SR)]
  for (const turn of turns) {
    chunks.push(
      synthesizeUtterance({
        phonemes: turn.phonemes,
        f0Hz: turn.f0Hz,
        sampleRate: SR,
        gapMs: 40,
        amplitude: 0.45,
      }),
    )
    chunks.push(silence(0.45, SR))
  }
  return concat(chunks)
}

describe('estimateSpeakerCount', () => {
  it('encontra duas vozes quando os registros são bem diferentes', () => {
    // 110 Hz e 240 Hz: uma diferença de mais de uma oitava, como acontece
    // entre personagens masculinos e femininos numa cena real.
    const track = conversation([
      { f0Hz: 110, phonemes: PHRASE_A },
      { f0Hz: 240, phonemes: PHRASE_B },
      { f0Hz: 110, phonemes: PHRASE_B },
      { f0Hz: 240, phonemes: PHRASE_A },
      { f0Hz: 110, phonemes: PHRASE_A },
      { f0Hz: 240, phonemes: PHRASE_B },
    ])

    const estimate = estimateSpeakerCount(extractFeatures(track, SR))

    expect(estimate.speakerCount).toBe(2)
    expect(estimate.confidence).toBeGreaterThan(0.35)

    // As falas alternam, então os agrupamentos precisam alternar junto.
    const clusters = estimate.regions.map((region) => region.cluster)
    expect(new Set(clusters).size).toBe(2)
  })

  it('reporta uma voz só quando é uma pessoa falando', () => {
    const track = conversation([
      { f0Hz: 130, phonemes: PHRASE_A },
      { f0Hz: 130, phonemes: PHRASE_B },
      { f0Hz: 130, phonemes: PHRASE_A },
      { f0Hz: 130, phonemes: PHRASE_B },
      { f0Hz: 130, phonemes: PHRASE_A },
    ])

    expect(estimateSpeakerCount(extractFeatures(track, SR)).speakerCount).toBe(1)
  })

  it('prefere errar para menos quando as vozes são parecidas', () => {
    // Dois semitons de diferença: pessoas distintas, mas próximas demais para
    // afirmar com segurança. Inventar um personagem quebraria o multiplayer.
    const track = conversation([
      { f0Hz: 130, phonemes: PHRASE_A },
      { f0Hz: 138, phonemes: PHRASE_B },
      { f0Hz: 130, phonemes: PHRASE_B },
      { f0Hz: 138, phonemes: PHRASE_A },
      { f0Hz: 130, phonemes: PHRASE_A },
      { f0Hz: 138, phonemes: PHRASE_B },
    ])

    const estimate = estimateSpeakerCount(extractFeatures(track, SR))
    if (estimate.speakerCount > 1) {
      // Se afirmar duas, que seja com confiança declarada — nunca alta.
      expect(estimate.confidence).toBeLessThan(0.75)
    } else {
      expect(estimate.reason).toBeTruthy()
    }
  })

  it('não afirma nada sobre ruído', () => {
    const estimate = estimateSpeakerCount(extractFeatures(whiteNoise(6, SR, 0.3), SR))
    expect(estimate.speakerCount).toBe(1)
    expect(estimate.confidence).toBeLessThan(0.7)
    expect(estimate.reason).toBeTruthy()
  })

  it('declara o motivo quando há poucos trechos de fala', () => {
    const track = conversation([{ f0Hz: 130, phonemes: PHRASE_A }])
    const estimate = estimateSpeakerCount(extractFeatures(track, SR))

    expect(estimate.speakerCount).toBe(1)
    expect(estimate.reason).toMatch(/poucos trechos/)
  })

  it('lida com silêncio sem quebrar', () => {
    const estimate = estimateSpeakerCount(extractFeatures(silence(5, SR), SR))
    expect(estimate.speakerCount).toBe(1)
    expect(estimate.regions).toHaveLength(0)
  })

  it('é determinístico — o mesmo vídeo dá sempre a mesma contagem', () => {
    const features = extractFeatures(
      conversation([
        { f0Hz: 110, phonemes: PHRASE_A },
        { f0Hz: 240, phonemes: PHRASE_B },
        { f0Hz: 110, phonemes: PHRASE_B },
        { f0Hz: 240, phonemes: PHRASE_A },
        { f0Hz: 110, phonemes: PHRASE_A },
        { f0Hz: 240, phonemes: PHRASE_B },
      ]),
      SR,
    )

    const first = estimateSpeakerCount(features)
    const second = estimateSpeakerCount(features)

    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it('devolve as regiões em milissegundos, prontas para virar segmentos', () => {
    const track = conversation([
      { f0Hz: 110, phonemes: PHRASE_A },
      { f0Hz: 240, phonemes: PHRASE_B },
      { f0Hz: 110, phonemes: PHRASE_A },
      { f0Hz: 240, phonemes: PHRASE_B },
    ])

    const estimate = estimateSpeakerCount(extractFeatures(track, SR))
    expect(estimate.regions.length).toBeGreaterThan(0)

    for (const region of estimate.regions) {
      expect(region.endMs).toBeGreaterThan(region.startMs)
      expect(region.cluster).toBeGreaterThanOrEqual(0)
    }
  })
})
