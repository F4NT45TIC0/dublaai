/**
 * Tipos do resultado de análise.
 *
 * Vivem em `shared` (e não em `scoring`) porque são dados de domínio
 * persistidos — a tabela `analyses` guarda exatamente isto. A UI importa daqui
 * sem puxar o motor para o bundle.
 *
 * A regra central do §12 está codificada no tipo: não existe `number` solto.
 * Toda métrica carrega o que se sabe sobre a própria confiabilidade, e
 * `value: null` é a única forma de dizer "não deu para medir" — nunca 0.
 */

export type MetricKey =
  | 'sync'
  | 'articulation'
  | 'rhythm'
  | 'pitch'
  | 'energy'
  | 'occupancy'

export type MetricStatus = 'ok' | 'limited' | 'unavailable'

export interface Metric {
  /** 0..100. `null` significa não calculável — jamais represente isso com 0. */
  readonly value: number | null
  readonly status: MetricStatus
  /** 0..1. Quanto o resultado merece ser levado a sério. */
  readonly confidence: number
  /** Obrigatório quando `status !== 'ok'`. Aparece na UI, não só no log. */
  readonly reason?: string
}

export type TimingZone = 'perfect' | 'great' | 'good' | 'late' | 'early' | 'missing'

/** Avaliação de uma fala específica — é isto que dá direção ao usuário. */
export interface SegmentFeedback {
  readonly segmentId: string
  readonly characterId: string
  readonly text: string
  readonly startMs: number
  readonly endMs: number
  /** Diferença de entrada em ms, já compensada pelo offset global. */
  readonly onsetDeltaMs: number | null
  readonly zone: TimingZone
  /** > 1 = arrastou, < 1 = correu. `null` quando não houve fala suficiente. */
  readonly tempoRatio: number | null
  /** Fração da janela da fala efetivamente preenchida com voz, 0..1. */
  readonly occupancy: number
}

export interface ScoreResult {
  /** Versão do motor (§52). Scores de versões diferentes não se comparam. */
  readonly engineVersion: string
  readonly configVersion: string
  readonly mode: 'original' | 'parody'

  readonly overall: Metric
  readonly metrics: Readonly<Record<MetricKey, Metric>>

  /**
   * Atraso sistemático do setup do usuário (fone Bluetooth, placa de áudio).
   * Removido das métricas e mostrado separadamente — punir o usuário por isso
   * seria medir o equipamento, não a dublagem. Ver docs/SCORING.md §2.2.
   */
  readonly globalOffsetMs: number
  readonly globalOffsetConfidence: number

  readonly segments: readonly SegmentFeedback[]

  /** Diagnóstico do sinal do usuário, usado para justificar degradações. */
  readonly signal: {
    readonly peakDb: number
    readonly noiseFloorDb: number
    readonly snrDb: number
    readonly speechRatio: number
    readonly clippedRatio: number
  }
}

export interface AnalysisRecord {
  readonly id: string
  readonly recordingId: string
  readonly sceneId: string
  readonly result: ScoreResult
  readonly createdAt: string
}

/** Rótulo em português para cada métrica. Um lugar só, para não divergir. */
export const METRIC_LABELS: Readonly<Record<MetricKey, string>> = {
  sync: 'SINCRONIA',
  articulation: 'ARTICULAÇÃO',
  rhythm: 'RITMO',
  pitch: 'ENTONAÇÃO',
  energy: 'ENERGIA',
  occupancy: 'OCUPAÇÃO',
}

/** O que cada métrica realmente afirma. Aparece na UI, não é comentário. */
export const METRIC_DESCRIPTIONS: Readonly<Record<MetricKey, string>> = {
  sync: 'Se você entrou e saiu de cada fala na hora certa.',
  articulation:
    'O quanto os sons que você produziu se parecem com os da referência. Não identifica palavras.',
  rhythm: 'Se você manteve o mesmo andamento — sem correr nem arrastar.',
  pitch: 'Se a melodia da sua fala subiu e desceu como a da referência.',
  energy: 'Se a sua variação de intensidade acompanhou a da referência.',
  occupancy: 'O quanto você preencheu o espaço de cada fala.',
}

export const TIMING_ZONE_LABELS: Readonly<Record<TimingZone, string>> = {
  perfect: 'PERFEITO',
  great: 'ÓTIMO',
  good: 'BOM',
  late: 'ATRASADO',
  early: 'ADIANTADO',
  missing: 'SEM FALA',
}
