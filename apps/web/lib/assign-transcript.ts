import type { SpeakerSegment } from '@dubla/shared'
import type { TranscribedChunk } from '@/workers/transcribe.worker'

/**
 * Casa o texto transcrito com os trechos detectados pelo VAD.
 *
 * São duas segmentações independentes: o VAD corta por silêncio, o Whisper
 * corta por frase. Elas quase nunca coincidem, então a atribuição é por
 * SOBREPOSIÇÃO — cada pedaço de texto vai para o trecho com quem ele mais
 * divide tempo, e não para o primeiro que encostar nele.
 *
 * Quando nada sobrepõe, o trecho fica com o rótulo genérico anterior em vez de
 * receber uma frase de outro momento do vídeo. Legenda errada é pior que
 * legenda ausente: a pessoa dubla o que está lendo.
 */
export function assignTranscript(
  segments: readonly SpeakerSegment[],
  chunks: readonly TranscribedChunk[],
): readonly SpeakerSegment[] {
  if (chunks.length === 0) return segments

  return segments.map((segment) => {
    const parts: { readonly startMs: number; readonly text: string }[] = []

    for (const chunk of chunks) {
      const overlap =
        Math.min(segment.endMs, chunk.endMs) - Math.max(segment.startMs, chunk.startMs)
      if (overlap <= 0) continue

      // Um trecho só fica com o texto se ele for majoritariamente daqui. Sem
      // isso, uma frase que atravessa uma pausa apareceria duplicada nos dois
      // lados e a pessoa dublaria a mesma fala duas vezes.
      const chunkDuration = Math.max(1, chunk.endMs - chunk.startMs)
      if (overlap / chunkDuration < 0.5) continue

      parts.push({ startMs: chunk.startMs, text: chunk.text })
    }

    if (parts.length === 0) return segment

    parts.sort((left, right) => left.startMs - right.startMs)
    const text = parts.map((part) => part.text).join(' ').replace(/\s+/g, ' ').trim()
    if (text === '') return segment

    return { ...segment, text }
  })
}

/**
 * Trechos que a transcrição não alcançou. A tela usa isso para dizer quantas
 * falas continuam sem texto, em vez de deixar a pessoa descobrir rolando.
 */
export function untranscribedCount(
  before: readonly SpeakerSegment[],
  after: readonly SpeakerSegment[],
): number {
  let count = 0
  for (const [index, segment] of after.entries()) {
    if (segment.text === before[index]?.text) count += 1
  }
  return count
}
