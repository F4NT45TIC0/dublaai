import type { SubtitleSegment } from './domain'

/** Antecipação padrão da legenda, em ms. */
export const SUBTITLE_LEAD_MS = 600
/** Quanto a legenda permanece depois do fim da fala, em ms. */
export const SUBTITLE_TAIL_MS = 200

/**
 * Qual legenda deve estar na tela em `nowMs`.
 *
 * Função pura, e fora do componente, por um motivo prático: a seleção da
 * legenda é lógica de sincronização — o coração do §111.4 — e precisa ser
 * testável sem navegador. Dentro de um `useEffect` com `requestAnimationFrame`
 * ela só poderia ser verificada em uma aba visível.
 *
 * A legenda entra `leadMs` ANTES da fala: um dublador precisa ler o texto antes
 * do momento de dizê-lo. Uma legenda que aparece junto com a fala chega tarde
 * demais para servir de alguma coisa.
 *
 * Quando duas janelas se sobrepõem (a cauda de uma encosta na antecipação da
 * seguinte), vence a que já começou a falar — a fala corrente nunca é
 * substituída pela próxima antes da hora.
 */
export function findActiveSubtitleIndex(
  subtitles: readonly SubtitleSegment[],
  nowMs: number,
  leadMs: number = SUBTITLE_LEAD_MS,
  tailMs: number = SUBTITLE_TAIL_MS,
): number {
  let candidate = -1

  for (let index = 0; index < subtitles.length; index += 1) {
    const subtitle = subtitles[index]
    if (!subtitle) continue
    if (nowMs < subtitle.startMs - leadMs || nowMs > subtitle.endMs + tailMs) continue

    // Já está na fala: decide na hora.
    if (nowMs >= subtitle.startMs) return index

    // Só na antecipação: guarda, mas segue procurando uma fala em andamento.
    if (candidate === -1) candidate = index
  }

  return candidate
}
