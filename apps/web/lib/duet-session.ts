import type { SpeakerSegment } from '@dubla/shared'

/**
 * Sessão de dueto — dois jogadores dublando a mesma cena, por turnos.
 *
 * É hot-seat: os dois no MESMO aparelho, alternando a vez. Não existe backend
 * neste projeto (ADR 0006) e nada aqui inventa um. A restrição serve ao
 * formato pedido: o jogador da vez precisa OUVIR o que o outro já gravou antes
 * de dublar a própria fala, e isso é natural quando os dois estão na frente da
 * mesma tela.
 *
 * Tudo neste arquivo é função pura sobre estado. A regra de quem fala quando é
 * o que quebra um jogo em dupla, então ela fica fora dos componentes, onde dá
 * para testar sem navegador.
 */

export interface DuetPlayer {
  readonly id: string
  readonly name: string
  /** Personagem que este jogador dubla. Um por jogador. */
  readonly characterId: string
}

export interface DuetSession {
  readonly sceneId: string
  readonly players: readonly DuetPlayer[]
  /** `segmentId` → `playerId` de quem já gravou aquela fala. */
  readonly takes: Readonly<Record<string, string>>
}

export interface PlayerProgress {
  readonly player: DuetPlayer
  readonly recorded: number
  readonly total: number
}

/** Cenas com um personagem só não têm dueto possível. */
export const MIN_DUET_CHARACTERS = 2

export function createDuetSession(
  sceneId: string,
  players: readonly DuetPlayer[],
): DuetSession {
  return { sceneId, players, takes: {} }
}

/** Quem é o dono de uma fala. `undefined` se ninguém escolheu o personagem. */
export function segmentOwner(
  segment: SpeakerSegment,
  players: readonly DuetPlayer[],
): DuetPlayer | undefined {
  return players.find((player) => player.characterId === segment.characterId)
}

/**
 * Falas em ordem cronológica que pertencem a algum jogador.
 *
 * Uma cena pode ter personagens que ninguém escolheu — cenas de três vozes
 * jogadas em dois, por exemplo. Essas falas ficam com o áudio de referência e
 * não entram no rodízio.
 */
export function playableSegments(
  segments: readonly SpeakerSegment[],
  players: readonly DuetPlayer[],
): SpeakerSegment[] {
  return [...segments]
    .sort((a, b) => a.startMs - b.startMs)
    .filter((segment) => segmentOwner(segment, players) !== undefined)
}

/**
 * Índice da próxima fala a gravar, em ordem cronológica. `-1` quando acabou.
 *
 * A ordem é cronológica e não por jogador de propósito: é o que faz o segundo
 * jogador dublar depois de ouvir o primeiro, em vez de os dois gravarem tudo
 * separado e só descobrirem no fim que não combinou.
 */
export function nextPendingIndex(
  segments: readonly SpeakerSegment[],
  session: DuetSession,
): number {
  const playable = playableSegments(segments, session.players)
  return playable.findIndex((segment) => session.takes[segment.id] === undefined)
}

export function isComplete(
  segments: readonly SpeakerSegment[],
  session: DuetSession,
): boolean {
  return nextPendingIndex(segments, session) === -1
}

/** Registra a tomada de uma fala. Regravar substitui, não duplica. */
export function recordTake(
  session: DuetSession,
  segmentId: string,
  playerId: string,
): DuetSession {
  return { ...session, takes: { ...session.takes, [segmentId]: playerId } }
}

/** Descarta a tomada de uma fala, devolvendo-a ao rodízio. */
export function clearTake(session: DuetSession, segmentId: string): DuetSession {
  // Reconstrói sem a chave em vez de atribuir `undefined`: `nextPendingIndex`
  // procura pela AUSÊNCIA da chave, e um `undefined` explícito deixaria a fala
  // parecendo gravada em qualquer verificação que use `in` ou `Object.keys`.
  const takes = Object.fromEntries(
    Object.entries(session.takes).filter(([id]) => id !== segmentId),
  )
  return { ...session, takes }
}

export function progressByPlayer(
  segments: readonly SpeakerSegment[],
  session: DuetSession,
): PlayerProgress[] {
  const playable = playableSegments(segments, session.players)

  return session.players.map((player) => {
    const owned = playable.filter(
      (segment) => segmentOwner(segment, session.players)?.id === player.id,
    )
    return {
      player,
      recorded: owned.filter((segment) => session.takes[segment.id] !== undefined).length,
      total: owned.length,
    }
  })
}

export type SegmentAudioSource = 'take' | 'reference' | 'silence'

/**
 * De onde vem o áudio de cada fala ao ouvir a cena no meio da partida.
 *
 * `take` para o que já foi dublado, `reference` para o que ainda não foi, e
 * `silence` para a fala que está prestes a ser gravada — é ela que o jogador
 * da vez precisa preencher, e ouvir a referência ali entregaria a resposta.
 */
export function audioSourceMap(
  segments: readonly SpeakerSegment[],
  session: DuetSession,
  currentSegmentId: string | null,
): Record<string, SegmentAudioSource> {
  const map: Record<string, SegmentAudioSource> = {}

  for (const segment of segments) {
    if (segment.id === currentSegmentId) map[segment.id] = 'silence'
    else if (session.takes[segment.id] !== undefined) map[segment.id] = 'take'
    else map[segment.id] = 'reference'
  }

  return map
}
