import type { SpeakerSegment } from '@dubla/shared'
import type { TranscribedChunk } from '@/workers/transcribe.worker'

/**
 * Constrói as falas a partir da transcrição, e não do detector de energia.
 *
 * O VAD corta onde o som cai abaixo de um limiar — ou seja, em toda respiração
 * no meio de uma frase. Numa cena de 37 s ele produzia 18 "falas", a maioria
 * pedaços de frase, e dublar assim é impossível: a pessoa grava "você é um" e
 * depois "brinquedo" em tomadas separadas.
 *
 * O Whisper corta onde a FRASE termina, que é a unidade real de dublagem. Usar
 * a transcrição como fonte da segmentação resolve o problema na origem, em vez
 * de tentar remendar as bordas do VAD depois.
 */

/**
 * Frases separadas por menos que isto pertencem à mesma fala.
 *
 * 400 ms é a pausa típica entre orações de um mesmo turno; acima disso já é
 * troca de fôlego ou de personagem. Juntar demais criaria blocos longos que
 * ninguém consegue dublar de uma vez.
 */
const MERGE_GAP_MS = 400

/** Abaixo disso não dá tempo de falar nada — é ruído que o modelo legendou. */
const MIN_SEGMENT_MS = 250

/**
 * Teto por fala. Acima disso a pessoa perde o fôlego e a referência visual;
 * a fala é cortada na maior pausa interna disponível.
 */
const MAX_SEGMENT_MS = 12_000

export function segmentsFromTranscript(
  chunks: readonly TranscribedChunk[],
  sceneId: string,
  durationMs: number,
): readonly SpeakerSegment[] {
  const ordenados = [...chunks]
    .filter((chunk) => chunk.text.trim() !== '' && chunk.endMs > chunk.startMs)
    .sort((left, right) => left.startMs - right.startMs)

  const juntos: { startMs: number; endMs: number; text: string }[] = []
  for (const chunk of ordenados) {
    const anterior = juntos[juntos.length - 1]
    const cabeNoAnterior =
      anterior !== undefined &&
      chunk.startMs - anterior.endMs <= MERGE_GAP_MS &&
      chunk.endMs - anterior.startMs <= MAX_SEGMENT_MS

    if (anterior && cabeNoAnterior) {
      anterior.endMs = Math.max(anterior.endMs, chunk.endMs)
      anterior.text = `${anterior.text} ${chunk.text.trim()}`.replace(/\s+/g, ' ').trim()
      continue
    }
    juntos.push({
      startMs: Math.max(0, chunk.startMs),
      endMs: Math.min(durationMs, chunk.endMs),
      text: chunk.text.trim(),
    })
  }

  return juntos
    .filter((bloco) => bloco.endMs - bloco.startMs >= MIN_SEGMENT_MS)
    .map(
      (bloco, index): SpeakerSegment => ({
        id: `${sceneId}-fala-${String(index + 1)}`,
        sceneId,
        // Uma voz por padrão. Dizer "voz 2" sem ter como saber seria inventar
        // precisão (§12); quem quiser separar personagens marca na tela, e aí
        // a informação é certa em vez de provável.
        characterId: 'voz-1',
        startMs: bloco.startMs,
        endMs: bloco.endMs,
        text: bloco.text,
        orderIndex: index,
      }),
    )
}

/**
 * Reatribui uma fala a outra voz.
 *
 * A troca é manual de propósito. Agrupar vozes por timbre exige um modelo de
 * embeddings que este projeto não tem; o que havia antes chutava pelo MFCC e
 * errava tanto que separava a mesma pessoa em quatro personagens. Um toque por
 * fala é mais rápido do que corrigir um palpite ruim, e o resultado é certo.
 */
export function assignVoice(
  segments: readonly SpeakerSegment[],
  segmentId: string,
  voiceCount: number,
): readonly SpeakerSegment[] {
  return segments.map((segment) => {
    if (segment.id !== segmentId) return segment
    const atual = Number.parseInt(segment.characterId.replace(/\D/g, ''), 10)
    const proxima = (Number.isNaN(atual) ? 1 : atual) % Math.max(1, voiceCount)
    return { ...segment, characterId: `voz-${String(proxima + 1)}` }
  })
}
