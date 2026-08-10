import type { DubMode, MetricKey } from '@dubla/shared'

/**
 * Configuração do motor de score.
 *
 * §11 é explícito: pesos e tolerâncias são configuráveis e NUNCA ficam
 * embutidos no algoritmo. O motor recebe isto como entrada; não existe valor
 * de fallback escondido dentro de uma fórmula.
 *
 * Toda análise persiste `configVersion` junto com `engineVersion` (§52).
 * Mudar qualquer número aqui exige subir a versão — scores antigos deixam de
 * ser comparáveis com os novos.
 */

export interface ScoreConfig {
  readonly version: string
  readonly weights: Readonly<Record<DubMode, Readonly<Partial<Record<MetricKey, number>>>>>
  readonly timing: {
    /** Dentro disto, é PERFEITO — humanos não sincronizam melhor que isso (§31). */
    readonly perfectMs: number
    readonly greatMs: number
    readonly goodMs: number
    /** Acima disto, o segmento zera. */
    readonly maxMs: number
    /** Janela de busca do onset em torno do esperado. */
    readonly searchWindowMs: number
    readonly greatScore: number
    readonly goodScore: number
  }
  readonly rhythm: {
    /** `k` em `100·exp(−k·média|log₂ inclinação|)`. */
    readonly slopePenalty: number
    readonly minSpeechFrames: number
  }
  readonly pitch: {
    readonly limitedCoverage: number
    readonly minCoverage: number
  }
  readonly articulation: {
    readonly limitedSnrDb: number
    readonly minSnrDb: number
    readonly minSpeechMs: number
  }
  readonly offset: {
    /** Abaixo disto, o offset estimado não é confiável e não é aplicado. */
    readonly minConfidence: number
  }
  readonly overall: {
    /** Abaixo desta fração de peso disponível, o próprio geral vira `limited`. */
    readonly minAvailableWeightRatio: number
  }
  readonly signal: {
    readonly silencePeakDb: number
    readonly clippingRatio: number
  }
}

export const DEFAULT_SCORE_CONFIG: ScoreConfig = {
  version: '1.0.0',

  weights: {
    original: {
      sync: 30,
      articulation: 30,
      rhythm: 20,
      pitch: 12,
      energy: 8,
    },
    // §13 — em paródia o texto é intencionalmente outro. Comparar os sons
    // produzidos puniria exatamente o que o modo existe para permitir.
    parody: {
      sync: 45,
      rhythm: 35,
      occupancy: 20,
    },
  },

  timing: {
    perfectMs: 120,
    greatMs: 250,
    goodMs: 400,
    maxMs: 800,
    searchWindowMs: 800,
    greatScore: 85,
    goodScore: 65,
  },

  rhythm: {
    slopePenalty: 2,
    minSpeechFrames: 15,
  },

  pitch: {
    limitedCoverage: 0.4,
    minCoverage: 0.15,
  },

  articulation: {
    limitedSnrDb: 10,
    minSnrDb: 5,
    minSpeechMs: 500,
  },

  offset: {
    minConfidence: 0.3,
  },

  overall: {
    minAvailableWeightRatio: 0.5,
  },

  signal: {
    silencePeakDb: -45,
    clippingRatio: 0.01,
  },
}

/** Versão do motor. Sobe quando a matemática muda, não quando a config muda. */
export const ENGINE_VERSION = '1.0.0'
