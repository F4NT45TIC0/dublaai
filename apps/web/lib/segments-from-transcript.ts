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
 * Frases separadas por menos que isto podem pertencer à mesma fala.
 *
 * Eram 400 ms, e era demais: num diálogo rápido um personagem responde ao outro
 * em menos que isso, e o resultado era uma "fala" só com o texto de dois ou três
 * personagens. 250 ms cobre a pausa entre orações do mesmo turno sem atravessar
 * a troca de quem fala.
 */
const MERGE_GAP_MS = 250

/** Abaixo disso não dá tempo de falar nada — é ruído que o modelo legendou. */
const MIN_SEGMENT_MS = 250

/**
 * Teto por fala.
 *
 * Seis segundos é o que se dubla de uma vez sem perder o fôlego nem a
 * referência visual. Eram doze, e blocos desse tamanho eram justamente os que
 * engoliam a conversa inteira.
 */
const MAX_SEGMENT_MS = 6_000

/**
 * Fim de frase fecha a fala, mesmo sem pausa.
 *
 * É o sinal mais forte que a transcrição dá de troca de turno: "Do que você
 * está falando?" seguido de outra frase é quase sempre outra pessoa
 * respondendo. Sem esta regra, a pontuação era ignorada e a decisão ficava só
 * no silêncio entre as falas — que num diálogo rápido praticamente não existe.
 */
function terminaFrase(texto: string): boolean {
  return /[.!?…:]["')\]]?\s*$/.test(texto)
}

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
      chunk.endMs - anterior.startMs <= MAX_SEGMENT_MS &&
      // A frase anterior já fechou: emendar aqui juntaria a pergunta de um
      // personagem com a resposta do outro na mesma fala.
      !terminaFrase(anterior.text)

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
