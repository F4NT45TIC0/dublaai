import {
  ANALYSIS_SAMPLE_RATE,
  computeWaveformPeaks,
  decodeReferenceFeatures,
  dtwAlign,
  encodeReferenceFeatures,
  extractFeatures,
  quantizeFeatureSet,
  type ReferenceFeatures,
} from '@dubla/dsp'
import {
  addNoise,
  concat,
  type Phoneme,
  silence,
  synthesizeUtterance,
  VOWELS,
} from '@dubla/dsp/testing'
import type { SpeakerSegment } from '@dubla/shared'

export const SR = ANALYSIS_SAMPLE_RATE

/**
 * Uma "cena" sintética: três falas em instantes conhecidos dentro de uma
 * trilha silenciosa.
 *
 * Instantes conhecidos são o ponto — todas as asserções de sincronia comparam
 * o que o motor mediu contra o que foi construído, e não contra um snapshot.
 */
export const SCENE_SEGMENTS: readonly SpeakerSegment[] = [
  {
    id: 'seg-1',
    sceneId: 'scene-test',
    characterId: 'char-1',
    startMs: 500,
    endMs: 1_400,
    text: 'primeira fala',
    orderIndex: 0,
  },
  {
    id: 'seg-2',
    sceneId: 'scene-test',
    characterId: 'char-2',
    startMs: 2_200,
    endMs: 3_100,
    text: 'segunda fala',
    orderIndex: 1,
  },
  {
    id: 'seg-3',
    sceneId: 'scene-test',
    characterId: 'char-1',
    startMs: 4_000,
    endMs: 4_900,
    text: 'terceira fala',
    orderIndex: 2,
  },
]

export const SCENE_DURATION_MS = 5_600

const PHRASE_A = [VOWELS.o, VOWELS.a, VOWELS.i] as const
const PHRASE_B = [VOWELS.e, VOWELS.a, VOWELS.o] as const
const PHRASE_C = [VOWELS.i, VOWELS.u, VOWELS.a] as const
const UNRELATED = [VOWELS.u, VOWELS.i, VOWELS.e] as const

export interface UtteranceOptions {
  readonly f0Hz?: number
  readonly tempo?: number
  readonly amplitude?: number
  /** Deslocamento aplicado a TODAS as falas. */
  readonly globalDelayMs?: number
  /** Deslocamento aplicado apenas à fala de índice `n`. */
  readonly perSegmentDelayMs?: readonly number[]
  readonly phrases?: readonly (readonly Phoneme[])[]
}

/**
 * Monta uma trilha posicionando cada fala no `startMs` do segmento
 * correspondente, com os deslocamentos pedidos.
 */
export function buildTrack(options: UtteranceOptions = {}): Float32Array {
  const {
    f0Hz = 130,
    tempo = 1,
    amplitude = 0.4,
    globalDelayMs = 0,
    perSegmentDelayMs = [],
    phrases = [PHRASE_A, PHRASE_B, PHRASE_C],
  } = options

  const chunks: Float32Array[] = []
  let cursorMs = 0

  SCENE_SEGMENTS.forEach((segment, index) => {
    const phrase = phrases[index] ?? PHRASE_A
    const delayMs = globalDelayMs + (perSegmentDelayMs[index] ?? 0)
    const targetMs = segment.startMs + delayMs

    if (targetMs > cursorMs) {
      chunks.push(silence((targetMs - cursorMs) / 1000, SR))
      cursorMs = targetMs
    }

    const utterance = synthesizeUtterance({
      phonemes: phrase,
      f0Hz,
      sampleRate: SR,
      gapMs: 40,
      amplitude,
      tempo,
    })
    chunks.push(utterance)
    cursorMs += (utterance.length / SR) * 1000
  })

  if (cursorMs < SCENE_DURATION_MS) {
    chunks.push(silence((SCENE_DURATION_MS - cursorMs) / 1000, SR))
  }

  return concat(chunks)
}

/**
 * Constrói a referência com as âncoras calculadas exatamente como a ingestão
 * faz (docs/MEDIA_PIPELINE.md §2.3), passando pelo codec para que a
 * quantização esteja presente nos dois lados da régua.
 */
export function buildReference(): ReferenceFeatures {
  const track = buildTrack()
  const features = quantizeFeatureSet(extractFeatures(track, SR))

  // As duas âncoras são medidas do mesmo jeito que o motor mede o usuário:
  // restritas aos quadros em que a REFERÊNCIA tem fala. Sem a máscara, o
  // silêncio compartilhado domina o caminho e as duas âncoras colapsam.
  const mask = features.speech

  // dFloor: a própria referência com ruído — "tão perto quanto é razoável".
  const noisy = quantizeFeatureSet(extractFeatures(addNoise(track, 0.02), SR))
  const dFloor = dtwAlign(
    features.features,
    features.frameCount,
    noisy.features,
    noisy.frameCount,
    { referenceMask: mask },
  ).speechDistance

  // dChance: fala não relacionada — o "acaso".
  const unrelated = quantizeFeatureSet(
    extractFeatures(buildTrack({ phrases: [UNRELATED, UNRELATED, UNRELATED] }), SR),
  )
  const dChance = dtwAlign(
    features.features,
    features.frameCount,
    unrelated.features,
    unrelated.frameCount,
    { referenceMask: mask },
  ).speechDistance

  const encoded = encodeReferenceFeatures(
    features,
    { dFloor, dChance },
    computeWaveformPeaks(track, SR, 200),
  )
  return decodeReferenceFeatures(encoded)
}

export function userFeatures(track: Float32Array) {
  return extractFeatures(track, SR)
}

export const UNRELATED_PHRASES = [UNRELATED, UNRELATED, UNRELATED] as const
