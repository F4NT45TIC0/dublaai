import type { SpeakerSegment } from '@dubla/shared'
import type { Take } from '@/lib/stitch-takes'

/**
 * De onde sai o áudio de cada trecho no modo fala-a-fala.
 *
 * Poder deixar um trecho com a voz original é o que permite dublar só um
 * personagem e manter o outro como está — a brincadeira de trocar a voz de
 * alguém no meio de uma conversa. Sem isso, ou se dubla a cena inteira ou não
 * se dubla nada.
 */
export type SegmentSource = 'record' | 'original'

/**
 * Folga aplicada à janela do áudio original.
 *
 * A costura faz um crossfade de 20 ms em cada borda. Sem folga, essa rampa
 * comeria o primeiro fonema da fala original — justo o que se quer preservar.
 * A folga é curta de propósito: o recorte veio do VAD do próprio áudio, então
 * já está justo, e alargar demais traria a fala do vizinho junto.
 */
export const ORIGINAL_PAD_MS = 40

/** O trecho usa a voz original do vídeo? Ausente no mapa significa gravar. */
export function isOriginal(
  sources: Readonly<Record<string, SegmentSource | undefined>>,
  segmentId: string,
): boolean {
  return sources[segmentId] === 'original'
}

/**
 * Trechos marcados como "voz original", convertidos em tomadas.
 *
 * O áudio original começa exatamente junto com o vídeo, então o offset é zero
 * por construção — não há relógio a corrigir aqui. Sendo `Take` como qualquer
 * outra, a costura, a exportação e o playback não precisam saber que este
 * pedaço não foi gravado por ninguém.
 */
export function originalTakesFor(
  segments: readonly SpeakerSegment[],
  sources: Readonly<Record<string, SegmentSource | undefined>>,
  original: { readonly samples: Float32Array; readonly sampleRate: number },
  durationMs: number,
): Take[] {
  const takes: Take[] = []
  for (const segment of segments) {
    if (!isOriginal(sources, segment.id)) continue
    takes.push({
      samples: original.samples,
      sampleRate: original.sampleRate,
      mediaStartOffsetMs: 0,
      windowStartMs: Math.max(0, segment.startMs - ORIGINAL_PAD_MS),
      windowEndMs: Math.min(durationMs, segment.endMs + ORIGINAL_PAD_MS),
    })
  }
  return takes
}

/**
 * Trechos que ainda esperam gravação.
 *
 * Quem está com a voz original não conta como pendência: já está resolvido, e
 * insistir nele faria o botão de próxima fala mandar a pessoa gravar algo que
 * ela decidiu não gravar.
 */
export function pendingRecordSegments(
  segments: readonly SpeakerSegment[],
  sources: Readonly<Record<string, SegmentSource | undefined>>,
  recorded: Readonly<Record<string, unknown>>,
): readonly SpeakerSegment[] {
  return segments.filter(
    (segment) => !isOriginal(sources, segment.id) && recorded[segment.id] === undefined,
  )
}

/**
 * A cena está completa? Vale tanto gravar quanto deixar no original — o que não
 * pode é sobrar trecho mudo.
 */
export function isSceneCovered(
  segments: readonly SpeakerSegment[],
  sources: Readonly<Record<string, SegmentSource | undefined>>,
  recorded: Readonly<Record<string, unknown>>,
): boolean {
  return segments.length > 0 && pendingRecordSegments(segments, sources, recorded).length === 0
}
