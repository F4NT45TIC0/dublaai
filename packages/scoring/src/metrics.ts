import {
  type DtwResult,
  type FeatureSet,
  HOP_MS,
  msToFrame,
  pearson,
  percentile,
  type ReferenceAnchors,
} from '@dubla/dsp'
import type { Metric, SegmentFeedback, SpeakerSegment, TimingZone } from '@dubla/shared'
import type { ScoreConfig } from './config'
import { projectByAlignment } from './align'

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

function metric(
  value: number | null,
  status: Metric['status'],
  confidence: number,
  reason?: string,
): Metric {
  return reason === undefined
    ? { value, status, confidence: clamp(confidence, 0, 1) }
    : { value, status, confidence: clamp(confidence, 0, 1), reason }
}

export function unavailable(reason: string): Metric {
  return metric(null, 'unavailable', 0, reason)
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * clamp(t, 0, 1)
}

// ---------------------------------------------------------------------------
// SINCRONIA
// ---------------------------------------------------------------------------

function timingScore(absDeltaMs: number, timing: ScoreConfig['timing']): number {
  if (absDeltaMs <= timing.perfectMs) return 100
  if (absDeltaMs <= timing.greatMs) {
    return lerp(
      100,
      timing.greatScore,
      (absDeltaMs - timing.perfectMs) / (timing.greatMs - timing.perfectMs),
    )
  }
  if (absDeltaMs <= timing.goodMs) {
    return lerp(
      timing.greatScore,
      timing.goodScore,
      (absDeltaMs - timing.greatMs) / (timing.goodMs - timing.greatMs),
    )
  }
  if (absDeltaMs <= timing.maxMs) {
    return lerp(timing.goodScore, 0, (absDeltaMs - timing.goodMs) / (timing.maxMs - timing.goodMs))
  }
  return 0
}

function timingZone(deltaMs: number | null, timing: ScoreConfig['timing']): TimingZone {
  if (deltaMs === null) return 'missing'
  const absolute = Math.abs(deltaMs)
  if (absolute <= timing.perfectMs) return 'perfect'
  if (absolute <= timing.greatMs) return 'great'
  if (absolute <= timing.goodMs) return 'good'
  return deltaMs > 0 ? 'late' : 'early'
}

export interface SegmentAnalysis {
  readonly feedback: readonly SegmentFeedback[]
  readonly sync: Metric
  readonly occupancy: Metric
}

/**
 * Avalia cada fala individualmente.
 *
 * Segmento a segmento e não globalmente porque um score único não diz nada
 * acionável. "Você atrasou a segunda fala" é feedback; "sincronia 72" não é.
 */
export function analyzeSegments(
  segments: readonly SpeakerSegment[],
  user: FeatureSet,
  dtw: DtwResult,
  offsetConfidence: number,
  config: ScoreConfig,
): SegmentAnalysis {
  if (segments.length === 0) {
    return {
      feedback: [],
      sync: unavailable('a cena não declara nenhuma fala'),
      occupancy: unavailable('a cena não declara nenhuma fala'),
    }
  }

  const searchFrames = msToFrame(config.timing.searchWindowMs)
  const feedback: SegmentFeedback[] = []

  let weightedScore = 0
  let weightedOccupancy = 0
  let totalWeight = 0
  let segmentsWithSpeech = 0

  for (const segment of segments) {
    const startFrame = msToFrame(segment.startMs)
    const endFrame = msToFrame(segment.endMs)
    const weight = Math.max(1, endFrame - startFrame)

    const onsetFrame = findOnsetNear(user.speech, startFrame, searchFrames)
    const onsetDeltaMs = onsetFrame === -1 ? null : (onsetFrame - startFrame) * HOP_MS
    const score = onsetDeltaMs === null ? 0 : timingScore(Math.abs(onsetDeltaMs), config.timing)
    const occupancy = occupancyOf(user.speech, startFrame, endFrame)
    const tempoRatio = averageSlope(dtw.slope, startFrame, endFrame)

    if (onsetFrame !== -1) segmentsWithSpeech += 1

    feedback.push({
      segmentId: segment.id,
      characterId: segment.characterId,
      text: segment.text,
      startMs: segment.startMs,
      endMs: segment.endMs,
      onsetDeltaMs,
      zone: timingZone(onsetDeltaMs, config.timing),
      tempoRatio,
      occupancy,
    })

    weightedScore += score * weight
    weightedOccupancy += occupancy * weight
    totalWeight += weight
  }

  const speechCoverage = segmentsWithSpeech / segments.length
  const syncValue = totalWeight === 0 ? 0 : weightedScore / totalWeight
  const occupancyValue = totalWeight === 0 ? 0 : (weightedOccupancy / totalWeight) * 100

  if (segmentsWithSpeech === 0) {
    const reason = 'não detectamos fala em nenhuma das falas da cena'
    return { feedback, sync: unavailable(reason), occupancy: unavailable(reason) }
  }

  // A confiança da sincronia depende da confiança do offset global: se não
  // sabemos separar o atraso do equipamento do atraso da pessoa, não podemos
  // afirmar muito sobre a entrada dela.
  const confidence = clamp(offsetConfidence, 0, 1) * speechCoverage
  const limited = offsetConfidence < config.offset.minConfidence

  return {
    feedback,
    sync: limited
      ? metric(
          syncValue,
          'limited',
          confidence,
          'não foi possível separar o atraso do seu equipamento do seu tempo de entrada',
        )
      : metric(syncValue, 'ok', confidence),
    occupancy: metric(occupancyValue, 'ok', speechCoverage),
  }
}

function findOnsetNear(speech: Uint8Array, expectedFrame: number, windowFrames: number): number {
  const from = Math.max(0, expectedFrame - windowFrames)
  const to = Math.min(speech.length, expectedFrame + windowFrames)
  for (let frame = from; frame < to; frame += 1) {
    if (speech[frame] === 1) return frame
  }
  return -1
}

function occupancyOf(speech: Uint8Array, startFrame: number, endFrame: number): number {
  const from = Math.max(0, startFrame)
  const to = Math.min(speech.length, endFrame)
  if (to <= from) return 0
  let spoken = 0
  for (let frame = from; frame < to; frame += 1) if (speech[frame] === 1) spoken += 1
  return spoken / (to - from)
}

function averageSlope(slope: Float32Array, startFrame: number, endFrame: number): number | null {
  const from = Math.max(0, startFrame)
  const to = Math.min(slope.length, endFrame)
  if (to <= from) return null
  let sum = 0
  let count = 0
  for (let frame = from; frame < to; frame += 1) {
    const value = slope[frame] ?? 0
    if (value > 0) {
      sum += value
      count += 1
    }
  }
  return count === 0 ? null : sum / count
}

// ---------------------------------------------------------------------------
// ARTICULAÇÃO
// ---------------------------------------------------------------------------

/**
 * Converte a distância DTW em nota usando as âncoras da cena.
 *
 * Sem as âncoras, `d̄` é um número sem significado — 0,4 pode ser ótimo ou
 * péssimo dependendo da cena, da voz e do ruído. As âncoras dão às pontas um
 * significado declarável: 0 é "indistinguível de uma fala qualquer", 100 é
 * "tão perto quanto o próprio áudio com ruído leve" (docs/SCORING.md §3.2).
 */
export function scoreArticulation(
  distance: number,
  anchors: ReferenceAnchors,
  snrDb: number,
  speechMs: number,
  config: ScoreConfig,
): Metric {
  const range = anchors.dChance - anchors.dFloor
  if (!Number.isFinite(range) || range <= 1e-6) {
    return unavailable('esta cena não tem calibração de articulação')
  }
  if (speechMs < config.articulation.minSpeechMs) {
    return unavailable('fala curta demais para comparar os sons')
  }
  if (snrDb < config.articulation.minSnrDb) {
    return unavailable('ruído de fundo alto demais para comparar os sons')
  }

  const value = 100 * clamp((anchors.dChance - distance) / range, 0, 1)

  if (snrDb < config.articulation.limitedSnrDb) {
    return metric(
      value,
      'limited',
      0.5,
      'há bastante ruído de fundo na sua gravação, então esta comparação é aproximada',
    )
  }

  return metric(value, 'ok', clamp(snrDb / 25, 0.5, 1))
}

// ---------------------------------------------------------------------------
// RITMO
// ---------------------------------------------------------------------------

export function scoreRhythm(dtw: DtwResult, reference: FeatureSet, config: ScoreConfig): Metric {
  let sum = 0
  let count = 0

  for (let frame = 0; frame < reference.frameCount; frame += 1) {
    if (reference.speech[frame] !== 1) continue
    const slope = dtw.slope[frame] ?? 0
    if (slope <= 0) continue
    sum += Math.abs(Math.log2(slope))
    count += 1
  }

  if (count < config.rhythm.minSpeechFrames) {
    return unavailable('fala insuficiente para avaliar o andamento')
  }

  const value = 100 * Math.exp(-config.rhythm.slopePenalty * (sum / count))
  return metric(value, 'ok', clamp(count / (reference.frameCount * 0.3), 0.4, 1))
}

// ---------------------------------------------------------------------------
// ENTONAÇÃO
// ---------------------------------------------------------------------------

export function scorePitch(
  reference: FeatureSet,
  user: FeatureSet,
  dtw: DtwResult,
  config: ScoreConfig,
): Metric {
  const projectedCents = projectByAlignment(user.f0Cents, dtw.alignment)
  const mask = new Uint8Array(reference.frameCount)

  let referenceVoiced = 0
  let bothVoiced = 0

  for (let frame = 0; frame < reference.frameCount; frame += 1) {
    const refCents = reference.f0Cents[frame] ?? Number.NaN
    if (!Number.isFinite(refCents) || reference.speech[frame] !== 1) continue
    referenceVoiced += 1

    if (Number.isFinite(projectedCents[frame] ?? Number.NaN)) {
      mask[frame] = 1
      bothVoiced += 1
    }
  }

  if (referenceVoiced === 0) {
    return unavailable('a referência não tem trechos sonoros suficientes')
  }

  const coverage = bothVoiced / referenceVoiced
  if (coverage < config.pitch.minCoverage) {
    return unavailable('não encontramos trechos sonoros suficientes na sua voz')
  }

  const correlation = pearson(reference.f0Cents, projectedCents, mask, 20)
  if (correlation === null) {
    return unavailable('não foi possível comparar a melodia da fala')
  }

  const value = 100 * Math.max(0, correlation)

  if (coverage < config.pitch.limitedCoverage) {
    return metric(
      value,
      'limited',
      coverage,
      'só parte da sua fala tinha melodia mensurável, então esta nota é aproximada',
    )
  }

  return metric(value, 'ok', coverage)
}

// ---------------------------------------------------------------------------
// ENERGIA
// ---------------------------------------------------------------------------

/**
 * Compara a dinâmica, não o volume.
 *
 * Cada lado é normalizado pelo próprio percentil 95: o que se compara é a
 * *variação* de intensidade ao longo da fala. Volume absoluto depende do ganho
 * do microfone e da distância da boca — nada que o usuário controle de forma
 * significativa, e nada que diga respeito à dublagem.
 */
export function scoreEnergy(
  reference: FeatureSet,
  user: FeatureSet,
  dtw: DtwResult,
  autoGainControlActive: boolean,
  config: ScoreConfig,
): Metric {
  const projectedRms = projectByAlignment(user.rmsDb, dtw.alignment)

  const referenceLevel = speechPercentile(reference.rmsDb, reference.speech, 0.95)
  const userLevel = speechPercentile(user.rmsDb, user.speech, 0.95)

  const referenceNormalized = new Float32Array(reference.frameCount)
  const userNormalized = new Float32Array(reference.frameCount)
  const mask = new Uint8Array(reference.frameCount)

  for (let frame = 0; frame < reference.frameCount; frame += 1) {
    referenceNormalized[frame] = (reference.rmsDb[frame] ?? 0) - referenceLevel
    const projected = projectedRms[frame] ?? Number.NaN
    userNormalized[frame] = Number.isFinite(projected) ? projected - userLevel : Number.NaN
    if (reference.speech[frame] === 1 && Number.isFinite(projected)) mask[frame] = 1
  }

  const correlation = pearson(referenceNormalized, userNormalized, mask, 20)
  if (correlation === null) {
    return unavailable('não foi possível comparar a variação de intensidade')
  }

  const value = 100 * Math.max(0, correlation)

  if (autoGainControlActive) {
    return metric(
      value,
      'limited',
      0.4,
      'seu navegador aplicou controle automático de ganho, o que achata a variação de intensidade',
    )
  }

  void config
  return metric(value, 'ok', 0.8)
}

function speechPercentile(values: Float32Array, speech: Uint8Array, p: number): number {
  const speechValues: number[] = []
  for (let frame = 0; frame < values.length; frame += 1) {
    if (speech[frame] === 1) speechValues.push(values[frame] ?? 0)
  }
  return speechValues.length === 0 ? 0 : percentile(speechValues, p)
}
