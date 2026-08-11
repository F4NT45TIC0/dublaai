/** Uma tomada WAV pode subir direto ao Blob sem atravessar a Function. */
export const MAX_TAKE_BYTES = 32 * 1024 * 1024

export type MatchTakeUploadAccess = 'private' | 'file'

const WAV_CONTENT_TYPES = new Set(['audio/wav', 'audio/x-wav', 'audio/wave'])
const SAFE_PATH_PART = /^[a-zA-Z0-9_-]+$/

export function isWavContentType(contentType: string): boolean {
  return WAV_CONTENT_TYPES.has(contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '')
}

/** Replica a normalização histórica usada para nomear as tomadas no store. */
export function safeTakeSegmentId(segmentId: string): string | null {
  const safe = segmentId.replace(/[^a-zA-Z0-9_-]/g, '')
  return safe === '' ? null : safe
}

export function takeAudioKey(segmentId: string, uniqueId: string): string | null {
  const safeSegmentId = safeTakeSegmentId(segmentId)
  if (!safeSegmentId || !SAFE_PATH_PART.test(uniqueId)) return null
  return `${safeSegmentId}-${uniqueId}`
}

/**
 * O pathname direto preserva o layout do MatchStore:
 * `readAudio(code, key)` procura exatamente `partidas/code/key.wav`.
 */
export function takeBlobPathname(code: string, audioKey: string): string | null {
  if (!SAFE_PATH_PART.test(code) || !SAFE_PATH_PART.test(audioKey)) return null
  return `partidas/${code}/${audioKey}.wav`
}

/** Extrai a chave somente quando o Blob pertence ao trecho e à partida informados. */
export function audioKeyFromTakePathname(
  code: string,
  segmentId: string,
  pathname: string,
): string | null {
  const safeSegmentId = safeTakeSegmentId(segmentId)
  if (!safeSegmentId || !SAFE_PATH_PART.test(code)) return null

  const prefix = `partidas/${code}/`
  if (!pathname.startsWith(prefix) || !pathname.endsWith('.wav')) return null
  const audioKey = pathname.slice(prefix.length, -'.wav'.length)
  if (!SAFE_PATH_PART.test(audioKey) || !audioKey.startsWith(`${safeSegmentId}-`)) return null
  return audioKey
}
