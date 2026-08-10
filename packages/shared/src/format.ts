import type { SceneDifficulty, WorkType } from './domain'

/** `14200` → `"00:14"`. Usado no player e nas listagens. */
export function formatTimecode(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** `14200` → `"14s"`. Para cartões, onde minutos nunca aparecem. */
export function formatSeconds(ms: number): string {
  return `${String(Math.round(ms / 1000))}s`
}

export const DIFFICULTY_LABELS: Readonly<Record<SceneDifficulty, string>> = {
  easy: 'Fácil',
  medium: 'Médio',
  hard: 'Difícil',
  insane: 'Insano',
}

export const WORK_TYPE_LABELS: Readonly<Record<WorkType, string>> = {
  film: 'Filme',
  series: 'Série',
  animation: 'Animação',
  cartoon: 'Desenho',
  anime: 'Anime',
  meme: 'Meme',
  other: 'Outros',
}

export const DURATION_BUCKETS = [
  { id: 'short', label: 'até 15s', maxMs: 15_000, minMs: 0 },
  { id: 'medium', label: '15-30s', maxMs: 30_000, minMs: 15_000 },
  { id: 'long', label: '30-45s', maxMs: 45_000, minMs: 30_000 },
  { id: 'extra', label: '45-60s', maxMs: 60_000, minMs: 45_000 },
] as const

export type DurationBucketId = (typeof DURATION_BUCKETS)[number]['id']

/** Formata um score respeitando o §12: sem valor, sem número. */
export function formatScore(value: number | null): string {
  return value === null ? '—' : String(Math.round(value))
}
