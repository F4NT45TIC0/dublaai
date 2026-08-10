/**
 * 5 minutos. Acima disso o DTW da análise (50 quadros/s dos dois lados) e a
 * exportação por MediaRecorder começam a pesar de verdade em máquinas comuns.
 */
export const MAX_LOCAL_VIDEO_DURATION_MS = 300_000
/** 1 GB. O arquivo nunca sai do aparelho; o limite protege a memória da aba. */
export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024

export interface LocalVideoMetadata {
  readonly durationMs: number
  readonly width: number
  readonly height: number
}

export function validateLocalVideoFile(file: Pick<File, 'size' | 'type'>): string | null {
  if (file.size <= 0) return 'O arquivo de vídeo está vazio.'
  if (file.size > MAX_VIDEO_BYTES) return 'O vídeo precisa ter no máximo 1 GB.'
  if (file.type.length > 0 && !file.type.startsWith('video/')) {
    return 'Escolha um arquivo de vídeo válido.'
  }
  return null
}

export function validateLocalVideoMetadata(metadata: LocalVideoMetadata): string | null {
  if (!Number.isFinite(metadata.durationMs) || metadata.durationMs <= 0) {
    return 'Não conseguimos ler a duração desse vídeo.'
  }
  if (metadata.durationMs > MAX_LOCAL_VIDEO_DURATION_MS) {
    return 'O vídeo precisa ter no máximo 5 minutos.'
  }
  if (metadata.width <= 0 || metadata.height <= 0) {
    return 'Não conseguimos ler a imagem desse vídeo.'
  }
  return null
}

const VIDEO_ID_SAMPLE_BYTES = 64 * 1024

export async function createLocalVideoId(
  file: Pick<File, 'name' | 'size' | 'lastModified' | 'slice'>,
  durationMs: number,
): Promise<string> {
  const sampleSize = Math.min(file.size, VIDEO_ID_SAMPLE_BYTES)
  const head = new Uint8Array(await file.slice(0, sampleSize).arrayBuffer())
  const tailStart = Math.max(sampleSize, file.size - VIDEO_ID_SAMPLE_BYTES)
  const tail = new Uint8Array(await file.slice(tailStart, file.size).arrayBuffer())
  const metadata = new TextEncoder().encode(
    `${file.name}\u0000${String(file.size)}\u0000${String(file.lastModified)}\u0000${String(Math.round(durationMs))}`,
  )
  const fingerprintInput = new Uint8Array(metadata.length + head.length + tail.length)
  fingerprintInput.set(metadata)
  fingerprintInput.set(head, metadata.length)
  fingerprintInput.set(tail, metadata.length + head.length)

  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', fingerprintInput))
  const fingerprint = Array.from(digest.subarray(0, 12), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')

  return `local-${fingerprint}-${String(file.size)}-${String(Math.round(durationMs))}`
}

export function downloadableBaseName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^.]+$/, '')
  const safe = withoutExtension
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)

  return safe.length > 0 ? safe : 'minha-cena'
}
