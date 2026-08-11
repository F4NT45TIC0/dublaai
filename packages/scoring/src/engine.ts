import {
  dtwAlign,
  estimateGlobalOffset,
  type FeatureSet,
  HOP_MS,
  msToFrame,
  percentile,
  quantizeFeatureSet,
  type ReferenceFeatures,
} from '@dubla/dsp'
import type {
  DubMode,
  Metric,
  MetricKey,
  ScoreResult,
  SegmentFeedback,
  SpeakerSegment,
} from '@dubla/shared'
import { DEFAULT_SCORE_CONFIG, ENGINE_VERSION, type ScoreConfig } from './config'
import { countSpeechFrames, cropFeatureSet, shiftFrames, shiftToVideoGrid } from './align'
import {
  analyzeSegments,
  clamp,
  scoreArticulation,
  scoreEnergy,
  scorePitch,
  scoreRhythm,
  unavailable,
} from './metrics'

export interface ScoreInput {
  readonly mode: DubMode
  readonly reference: ReferenceFeatures
  readonly user: FeatureSet
  readonly segments: readonly SpeakerSegment[]
  /** `mediaStartOffsetMs` medido pelo MediaClock (§18). */
  readonly recordingOffsetMs: number
  readonly flags?: {
    /** O navegador ignorou a constraint e aplicou AGC. */
    readonly autoGainControlActive?: boolean
    /** `false` quando a aba foi suspensa durante a gravação (§104). */
    readonly sampleContinuityOk?: boolean
  }
  /**
   * Restringe a análise a um trecho da cena (modo fala-a-fala).
   *
   * Sem isto, uma gravação de um segmento só seria comparada contra a cena
   * inteira: o DTW alinharia fala contra silêncio e a nota seria inventada.
   * Os tempos são absolutos na timeline do vídeo, como em `SpeakerSegment`.
   */
  readonly window?: { readonly startMs: number; readonly endMs: number }
  readonly config?: ScoreConfig
}

/**
 * Mínimo de fala na referência para a articulação valer dentro de uma janela.
 *
 * As âncoras `dFloor`/`dChance` foram calibradas sobre a cena inteira; num
 * trecho muito curto a distância tem outra distribuição, e afirmar a mesma
 * precisão seria esticar o que os dados sustentam.
 */
const MIN_WINDOW_SPEECH_FRAMES = 25

const PARODY_DISABLED_REASON =
  'não avaliado no modo paródia — aqui você pode falar o que quiser'

/**
 * Motor de score.
 *
 * Determinístico e sem I/O: a mesma entrada produz exatamente a mesma saída,
 * o que é o que permite rodá-lo no navegador para feedback instantâneo e
 * recomputá-lo no servidor na Fase 5 sem que os números divirjam.
 */
export function computeScore(input: ScoreInput): ScoreResult {
  const config = input.config ?? DEFAULT_SCORE_CONFIG
  const { reference, mode, segments } = input
  const flags = input.flags ?? {}

  const signal = describeSignal(input.user, config)

  // §100 — nada de processar caro sobre uma gravação vazia.
  if (signal.peakDb < config.signal.silencePeakDb || input.user.frameCount === 0) {
    return silentResult(mode, config, signal, segments)
  }

  // O usuário passa a viver na grade de tempo do vídeo. A partir daqui, índice
  // de quadro significa a mesma coisa dos dois lados.
  const onVideoGrid = shiftToVideoGrid(
    quantizeFeatureSet(input.user),
    input.recordingOffsetMs,
    reference.frameCount,
  )

  // Modo fala-a-fala: os dois lados são recortados para a mesma janela e os
  // segmentos passam a ser relativos a ela. O resto do motor não muda.
  const windowStartMs = input.window ? Math.max(0, input.window.startMs) : 0
  const windowed = input.window !== undefined
  const startFrame = msToFrame(windowStartMs)
  const endFrame = input.window ? msToFrame(input.window.endMs) : reference.frameCount

  const scopedReference = windowed
    ? { ...cropFeatureSet(reference, startFrame, endFrame), anchors: reference.anchors, peaks: reference.peaks }
    : reference
  const scopedUser = windowed ? cropFeatureSet(onVideoGrid, startFrame, endFrame) : onVideoGrid
  const scopedSegments = windowed
    ? segments.map((segment) => ({
        ...segment,
        startMs: segment.startMs - windowStartMs,
        endMs: segment.endMs - windowStartMs,
      }))
    : segments

  // Separa o atraso do equipamento do atraso da pessoa (docs/SCORING.md §2.2).
  const offset = estimateGlobalOffset(scopedReference.activity, scopedUser.activity)
  const offsetReliable = offset.confidence >= config.offset.minConfidence
  const compensated = offsetReliable
    ? shiftFrames(scopedUser, -offset.lagFrames, scopedReference.frameCount)
    : scopedUser

  const dtw = dtwAlign(
    scopedReference.features,
    scopedReference.frameCount,
    compensated.features,
    compensated.frameCount,
    { referenceMask: scopedReference.speech },
  )

  const segmentAnalysis = analyzeSegments(
    scopedSegments,
    compensated,
    dtw,
    offset.confidence,
    config,
  )

  const isParody = mode === 'parody'
  const speechMs = compensated.speechRatio * compensated.frameCount * HOP_MS

  const articulation = isParody
    ? unavailable(PARODY_DISABLED_REASON)
    : scoreArticulation(
        dtw.speechDistance,
        scopedReference.anchors,
        signal.snrDb,
        speechMs,
        config,
      )

  const metrics: Record<MetricKey, Metric> = {
    sync: applyContinuity(segmentAnalysis.sync, flags.sampleContinuityOk !== false),
    occupancy: segmentAnalysis.occupancy,
    articulation:
      windowed && countSpeechFrames(scopedReference) < MIN_WINDOW_SPEECH_FRAMES
        ? limitedBecause(
            articulation,
            'este trecho é curto demais para comparar os sons com a mesma precisão da cena inteira',
          )
        : articulation,
    rhythm: scoreRhythm(dtw, scopedReference, config),
    pitch: isParody
      ? unavailable(PARODY_DISABLED_REASON)
      : scorePitch(scopedReference, compensated, dtw, config),
    energy: isParody
      ? unavailable(PARODY_DISABLED_REASON)
      : scoreEnergy(
          scopedReference,
          compensated,
          dtw,
          flags.autoGainControlActive === true,
          config,
        ),
  }

  return {
    engineVersion: ENGINE_VERSION,
    configVersion: config.version,
    mode,
    overall: rounded(combine(metrics, mode, config)),
    metrics: roundedMetrics(metrics),
    globalOffsetMs: offsetReliable ? offset.lagFrames * HOP_MS : 0,
    globalOffsetConfidence: offset.confidence,
    // Os tempos voltam a ser absolutos na cena: a UI mostra "fala 3 de 7",
    // não "fala 1 da janela".
    segments: windowed
      ? segmentAnalysis.feedback.map((entry) => ({
          ...entry,
          startMs: entry.startMs + windowStartMs,
          endMs: entry.endMs + windowStartMs,
        }))
      : segmentAnalysis.feedback,
    signal,
  }
}

/**
 * Arredonda a nota para inteiro.
 *
 * "68,3888724947629" afirma uma precisão de treze casas que a medição não tem:
 * o alinhamento é quadro a quadro, a 20 ms, e uma casa decimal já seria mais do
 * que o método sustenta. Mostrar o número cru é exatamente o tipo de precisão
 * inventada que o §12 proíbe — e, na tela, vira lixo em cima da nota.
 *
 * A confiança continua fracionária de propósito: ela é um peso interno, não um
 * número que a pessoa lê.
 */
function rounded(metric: Metric): Metric {
  if (metric.value === null) return metric
  return { ...metric, value: Math.round(metric.value) }
}

/**
 * Arredonda todas as métricas presentes.
 *
 * Percorre as chaves existentes em vez de listá-las: o conjunto muda entre os
 * modos (paródia troca articulação e entonação por ocupação), e uma lista fixa
 * já deixou uma métrica cair fora silenciosamente.
 */
function roundedMetrics<T extends Readonly<Record<string, Metric>>>(metrics: T): T {
  const saida: Record<string, Metric> = {}
  for (const [key, metric] of Object.entries(metrics)) saida[key] = rounded(metric)
  return saida as T
}

/** Rebaixa uma métrica já calculada, preservando valor e confiança reduzida. */
function limitedBecause(metric: Metric, reason: string): Metric {
  if (metric.status === 'unavailable' || metric.value === null) return metric
  return {
    value: metric.value,
    status: 'limited',
    confidence: Math.min(metric.confidence, 0.5),
    reason,
  }
}

/**
 * Combina as métricas disponíveis, renormalizando os pesos.
 *
 * Se a entonação não pôde ser medida, os 12 pontos dela não somem para o
 * limbo nem viram zero — eles são redistribuídos entre as métricas que
 * puderam ser medidas. Zerar seria afirmar que a pessoa foi mal em algo que
 * não medimos (§12).
 */
function combine(
  metrics: Readonly<Record<MetricKey, Metric>>,
  mode: DubMode,
  config: ScoreConfig,
): Metric {
  const weights = config.weights[mode]

  let configuredWeight = 0
  let availableWeight = 0
  let weightedValue = 0
  let weightedConfidence = 0
  const missing: string[] = []

  for (const [key, weight] of Object.entries(weights) as [MetricKey, number][]) {
    configuredWeight += weight
    const entry = metrics[key]
    if (entry.status === 'unavailable' || entry.value === null) {
      missing.push(key)
      continue
    }
    availableWeight += weight
    weightedValue += weight * entry.value
    weightedConfidence += weight * entry.confidence
  }

  if (availableWeight === 0) {
    return unavailable('nenhuma métrica pôde ser calculada para esta gravação')
  }

  const value = weightedValue / availableWeight
  const confidence = weightedConfidence / availableWeight
  const ratio = configuredWeight === 0 ? 0 : availableWeight / configuredWeight

  if (ratio < config.overall.minAvailableWeightRatio) {
    return {
      value,
      status: 'limited',
      confidence: clamp(confidence, 0, 1),
      reason: `calculado sem ${missing.length === 1 ? 'uma métrica' : `${String(missing.length)} métricas`} que não pôde ser medida`,
    }
  }

  const hasLimited = (Object.keys(weights) as MetricKey[]).some(
    (key) => metrics[key].status === 'limited',
  )

  return hasLimited
    ? {
        value,
        status: 'limited',
        confidence: clamp(confidence, 0, 1),
        reason: 'parte das métricas foi medida com precisão reduzida',
      }
    : { value, status: 'ok', confidence: clamp(confidence, 0, 1) }
}

/** Uma aba suspensa invalida a premissa de sincronia — mas não o áudio (§104). */
function applyContinuity(sync: Metric, continuous: boolean): Metric {
  if (continuous || sync.status === 'unavailable') return sync
  return {
    value: sync.value,
    status: 'limited',
    confidence: Math.min(sync.confidence, 0.3),
    reason: 'a aba ficou em segundo plano durante a gravação, então o encaixe pode estar deslocado',
  }
}

function describeSignal(user: FeatureSet, config: ScoreConfig): ScoreResult['signal'] {
  const speechLevels: number[] = []
  for (let frame = 0; frame < user.frameCount; frame += 1) {
    if (user.speech[frame] === 1) speechLevels.push(user.rmsDb[frame] ?? 0)
  }

  const meanSpeechDb =
    speechLevels.length === 0 ? user.noiseFloorDb : percentile(speechLevels, 0.5)

  void config
  return {
    peakDb: user.peakDb,
    noiseFloorDb: user.noiseFloorDb,
    snrDb: Math.max(0, meanSpeechDb - user.noiseFloorDb),
    speechRatio: user.speechRatio,
    clippedRatio: user.clippedRatio,
  }
}

function silentResult(
  mode: DubMode,
  config: ScoreConfig,
  signal: ScoreResult['signal'],
  segments: readonly SpeakerSegment[],
): ScoreResult {
  const reason = 'quase não conseguimos ouvir sua voz nesta gravação'
  const empty = unavailable(reason)

  const feedback: SegmentFeedback[] = segments.map((segment) => ({
    segmentId: segment.id,
    characterId: segment.characterId,
    text: segment.text,
    startMs: segment.startMs,
    endMs: segment.endMs,
    onsetDeltaMs: null,
    zone: 'missing',
    tempoRatio: null,
    occupancy: 0,
  }))

  return {
    engineVersion: ENGINE_VERSION,
    configVersion: config.version,
    mode,
    overall: empty,
    metrics: {
      sync: empty,
      articulation: empty,
      rhythm: empty,
      pitch: empty,
      energy: empty,
      occupancy: empty,
    },
    globalOffsetMs: 0,
    globalOffsetConfidence: 0,
    segments: feedback,
    signal,
  }
}
