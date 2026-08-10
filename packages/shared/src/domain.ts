/**
 * Tipos de domínio do Dubla Aí.
 *
 * Esta é a ÚNICA definição. Os campos espelham 1:1 as colunas de
 * `db/migrations/0001_init.sql` (camelCase aqui, snake_case lá), para que a
 * migração de local-first para Postgres na Fase 5 não altere nada que a UI
 * consome. Ver docs/DATA_MODEL.md §1.
 */

// ---------------------------------------------------------------------------
// Enumerações
// ---------------------------------------------------------------------------

export type WorkType = 'film' | 'series' | 'animation' | 'cartoon' | 'anime' | 'meme' | 'other'

export type SceneStatus =
  | 'draft'
  | 'processing'
  | 'review'
  | 'published'
  | 'blocked'
  | 'expired'
  | 'archived'

export type SceneDifficulty = 'easy' | 'medium' | 'hard' | 'insane'

export type DubMode = 'original' | 'parody'

export type RecordingStatus =
  | 'recording'
  | 'uploading'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'

export type VisibilityState = 'private' | 'unlisted' | 'public' | 'moderation_review' | 'blocked'

export type LicenseType = 'original' | 'public_domain' | 'cc_by' | 'licensed' | 'user_upload'

export const WORK_TYPES: readonly WorkType[] = [
  'film',
  'series',
  'animation',
  'cartoon',
  'anime',
  'meme',
  'other',
]

export const DIFFICULTIES: readonly SceneDifficulty[] = ['easy', 'medium', 'hard', 'insane']

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------

export interface Work {
  id: string
  slug: string
  title: string
  type: WorkType
  year?: number
  synopsis?: string
  posterKey?: string
}

export interface Character {
  id: string
  workId: string
  name: string
  /** Token de cor do design system, ex. 'character-1'. */
  colorToken: string
  /**
   * Redundância não-cromática. §63 proíbe depender só de cor para identificar
   * personagem — daltônicos e leitores de tela precisam do padrão.
   */
  patternToken: string
}

export interface SpeakerSegment {
  id: string
  sceneId: string
  characterId: string
  startMs: number
  endMs: number
  text: string
  orderIndex: number
}

export interface SubtitleSegment {
  id: string
  sceneId: string
  speakerSegmentId?: string
  startMs: number
  endMs: number
  text: string
}

export interface ContentRights {
  source: string
  owner: string
  licenseType: LicenseType
  licenseStart?: string
  licenseEnd?: string
  territories: readonly string[]
  usageRestrictions?: string
  proofReference?: string
}

export interface Scene {
  id: string
  slug: string
  workId: string
  title: string
  description?: string
  durationMs: number
  difficulty: SceneDifficulty
  language: string
  videoKey: string
  referenceAudioKey: string
  featuresKey: string
  thumbnailKey?: string
  characterCount: number
  status: SceneStatus
}

/** Cena com tudo que a página de dublagem precisa, em uma só carga. */
export interface SceneDetail extends Scene {
  work: Work
  characters: readonly Character[]
  speakerSegments: readonly SpeakerSegment[]
  subtitleSegments: readonly SubtitleSegment[]
  rights: ContentRights
}

/** Projeção enxuta para listagens (home, explorar). */
export interface SceneSummary {
  id: string
  slug: string
  title: string
  workTitle: string
  workType: WorkType
  durationMs: number
  difficulty: SceneDifficulty
  characterCount: number
  thumbnailKey?: string
}

// ---------------------------------------------------------------------------
// Gravação
// ---------------------------------------------------------------------------

/**
 * Tudo que se sabe sobre o alinhamento entre a gravação e o vídeo (§18).
 *
 * Nenhum destes campos é presumido: todos são medidos. `estimatedInputLatencyMs`
 * é explicitamente uma estimativa PARCIAL — a latência real do hardware é
 * inobservável, e é por isso que o score reporta o offset global em separado
 * em vez de fingir tê-la compensado (docs/SCORING.md §2.2).
 */
export interface RecordingClockInfo {
  /** Taxa real do AudioContext. Nunca presuma 48000. */
  sampleRate: number
  /** Índice da primeira amostra capturada, vindo de `currentFrame` no worklet. */
  startFrame: number
  /** `mediaTime` do primeiro quadro de vídeo efetivamente exibido, em ms. */
  videoStartMediaTime: number
  /** A ponte medida entre os dois relógios. O número que importa. */
  mediaStartOffsetMs: number
  /** `baseLatency` + `settings.latency` quando disponível. Parcial por natureza. */
  estimatedInputLatencyMs: number
  /** R² do ajuste afim do MediaClock, 0..1. */
  clockConfidence: number
  /** false quando a aba foi suspensa e amostras podem ter sido perdidas (§104). */
  sampleContinuityOk: boolean
}

export interface RecordingRecord {
  id: string
  sceneId: string
  mode: DubMode
  /** Chave no OPFS (Fases 0-4) ou no object storage (Fase 5). Mesmo formato. */
  storageKey: string
  durationMs: number
  format: string
  sampleRate: number
  channels: number
  clock: RecordingClockInfo
  visibility: VisibilityState
  status: RecordingStatus
  createdAt: string
  updatedAt: string
}

export interface RecordingAttempt {
  id: string
  recordingId: string
  sceneId: string
  attemptNumber: number
  isBest: boolean
  createdAt: string
}
