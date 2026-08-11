import type { SpeakerSegment } from '@dubla/shared'
import type { RecorderAttempt } from './use-recorder'
/** Estado de uma fala: se já foi gravada e a melhor nota obtida nela. */
export interface SegmentTakeState {
  readonly recorded: boolean
  readonly score: number | null
}

/**
 * Regras compartilhadas entre os painéis de gravação (catálogo e Meu vídeo).
 *
 * Os dois painéis renderizam diferente, mas as decisões — qual janela analisar,
 * qual tomada é a melhor de cada fala, o que aparece no histórico — precisam
 * ser as MESMAS. Divergência aqui é como o modo fala-a-fala do catálogo e o do
 * vídeo enviado passariam a discordar em silêncio.
 */

/** Como a cena é gravada. */
export type TakeMode = 'full' | 'segment' | 'duet' | 'online'

/**
 * Folga antes e depois da fala.
 *
 * Quem dubla precisa de embalo: entrar exatamente no primeiro fonema é
 * impossível sem ouvir o que vem antes. A folga entra na janela de análise
 * também, então o motor compara o mesmo trecho que a pessoa gravou.
 */
export const LEAD_IN_MS = 700
export const TAIL_MS = 400

/**
 * Margem mantida ao costurar as tomadas na trilha final.
 *
 * Menor que a folga de gravação de propósito: o embalo serve para a pessoa
 * entrar no tempo, não para aparecer na cena montada — mas cortar exatamente
 * no início declarado da fala degolaria quem entrou um nada adiantado.
 */
export const STITCH_PAD_MS = 150

export function analysisWindowFor(
  segment: SpeakerSegment,
  durationMs: number,
): { startMs: number; endMs: number } {
  return {
    startMs: Math.max(0, segment.startMs - LEAD_IN_MS),
    endMs: Math.min(durationMs, segment.endMs + TAIL_MS),
  }
}

export function orderSegments(segments: readonly SpeakerSegment[]): SpeakerSegment[] {
  return [...segments].sort((a, b) => a.startMs - b.startMs)
}

/** Melhor nota geral por fala. `null` = tomada existe mas ainda sem nota. */
export function bestScoreBySegment(
  attempts: readonly RecorderAttempt[],
): Record<string, number | null> {
  const map: Record<string, number | null> = {}
  for (const attempt of attempts) {
    const segmentId = attempt.segmentId
    if (segmentId === undefined) continue
    // O motor já devolve inteiro, mas tomadas guardadas antes disso ficaram
    // no armazenamento local com a nota crua — e são elas que aparecem na fita
    // e na barra. Arredondar na leitura cobre as duas gerações.
    const bruto = attempt.result?.overall.value ?? null
    const score = bruto === null ? null : Math.round(bruto)
    const existing = map[segmentId]
    if (existing === undefined || (score !== null && (existing === null || score > existing))) {
      map[segmentId] = score
    }
  }
  return map
}

/** Estado de cada fala para o navegador de segmentos. */
export function takeStatesBySegment(
  attempts: readonly RecorderAttempt[],
): Record<string, SegmentTakeState> {
  const map: Record<string, SegmentTakeState> = {}
  for (const [segmentId, score] of Object.entries(bestScoreBySegment(attempts))) {
    map[segmentId] = { recorded: true, score }
  }
  return map
}

/**
 * Tentativas visíveis no histórico: as da fala corrente, ou as de cena
 * inteira quando nenhuma fala está selecionada.
 */
export function visibleAttemptsFor(
  attempts: readonly RecorderAttempt[],
  segmentId: string | undefined,
): RecorderAttempt[] {
  return segmentId === undefined
    ? attempts.filter((attempt) => attempt.segmentId === undefined)
    : attempts.filter((attempt) => attempt.segmentId === segmentId)
}

/**
 * A melhor tomada de cada fala, pronta para a costura.
 *
 * Melhor por nota; sem nota, a mais recente — uma tomada sem análise ainda é
 * a voz da pessoa, e a cena montada não pode ficar com buraco por causa disso.
 */
export function bestTakePerSegment(
  attempts: readonly RecorderAttempt[],
): Map<string, RecorderAttempt> {
  const best = new Map<string, RecorderAttempt>()
  for (const attempt of attempts) {
    const segmentId = attempt.segmentId
    if (segmentId === undefined) continue
    const current = best.get(segmentId)
    if (!current) {
      best.set(segmentId, attempt)
      continue
    }
    const currentScore = current.result?.overall.value ?? null
    const candidateScore = attempt.result?.overall.value ?? null
    if (candidateScore !== null && (currentScore === null || candidateScore > currentScore)) {
      best.set(segmentId, attempt)
    } else if (candidateScore === null && currentScore === null) {
      // Ambas sem nota: fica a mais recente.
      best.set(segmentId, attempt)
    }
  }
  return best
}
