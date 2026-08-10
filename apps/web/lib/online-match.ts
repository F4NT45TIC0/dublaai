/**
 * Partida online: dois aparelhos, o mesmo vídeo, um código para juntar os dois.
 *
 * O vídeo NÃO trafega. Cada pessoa abre o próprio arquivo; a partida guarda
 * apenas a impressão digital dele e recusa quem chegar com outro vídeo. Isso
 * mantém o limite de 1 GB fora da rede e preserva a regra de que o vídeo não
 * sai do aparelho.
 *
 * O que trafega são as tomadas de voz — e só elas. É o único ponto do Dubla Aí
 * em que áudio sai do dispositivo, então a tela avisa antes, em vez de deixar
 * a descoberta para depois.
 */

export interface MatchPlayer {
  readonly id: string
  readonly name: string
  /** Personagem (voz detectada) que esta pessoa dubla. */
  readonly characterId: string
}

export interface MatchSegment {
  readonly id: string
  readonly characterId: string
  readonly startMs: number
  readonly endMs: number
  readonly text: string
}

export interface MatchTake {
  readonly playerId: string
  readonly url: string
  readonly mediaStartOffsetMs: number
  readonly sampleRate: number
}

export interface MatchState {
  readonly code: string
  /** Impressão digital do vídeo. Quem tiver outro arquivo não entra. */
  readonly videoId: string
  readonly videoName: string
  readonly durationMs: number
  readonly segments: readonly MatchSegment[]
  readonly players: readonly MatchPlayer[]
  readonly takes: Readonly<Record<string, MatchTake | undefined>>
  /**
   * O anfitrião guardou o vídeo na partida.
   *
   * Quando verdadeiro, quem entra baixa o arquivo em vez de precisar tê-lo:
   * combinar "abra exatamente o mesmo arquivo" por fora era a parte mais chata
   * de começar a jogar.
   */
  readonly videoShared?: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * Uma partida vive 24 horas.
 *
 * Gravação de voz não deve ficar num servidor para sempre por causa de uma
 * brincadeira de dez minutos. O prazo é curto o bastante para isso e longo o
 * bastante para quem combinou de jogar à noite.
 */
export const MATCH_TTL_MS = 24 * 60 * 60 * 1_000

/** Uma partida precisa de duas vozes: sem isso não há o que revezar. */
export const MIN_MATCH_CHARACTERS = 2

export function isExpired(state: MatchState, now: number): boolean {
  return now - state.createdAt > MATCH_TTL_MS
}

/** Personagens da cena, na ordem em que aparecem. */
export function charactersOf(segments: readonly MatchSegment[]): readonly string[] {
  const seen: string[] = []
  for (const segment of segments) {
    if (!seen.includes(segment.characterId)) seen.push(segment.characterId)
  }
  return seen
}

/** Personagens que ainda não têm dono. */
export function availableCharacters(state: MatchState): readonly string[] {
  const taken = new Set(state.players.map((player) => player.characterId))
  return charactersOf(state.segments).filter((characterId) => !taken.has(characterId))
}

export type JoinResult =
  | { readonly ok: true; readonly state: MatchState }
  | { readonly ok: false; readonly reason: string }

/**
 * Entra na partida.
 *
 * As recusas são explícitas de propósito: "vídeo diferente" e "personagem já
 * escolhido" são erros que a pessoa consegue corrigir, e tratá-los como falha
 * genérica deixaria os dois lados adivinhando.
 */
export function joinMatch(
  state: MatchState,
  player: MatchPlayer,
  videoId: string,
  now: number,
): JoinResult {
  if (isExpired(state, now)) {
    return { ok: false, reason: 'Esta partida expirou. Crie uma nova para continuar.' }
  }
  // Com o vídeo guardado na partida, os dois lados têm o mesmo arquivo por
  // construção — a conferência só faz sentido quando cada um trouxe o seu.
  if (state.videoShared !== true && state.videoId !== videoId) {
    return {
      ok: false,
      reason:
        'O vídeo aberto aqui não é o mesmo da partida. Os dois precisam abrir exatamente o mesmo arquivo.',
    }
  }
  if (state.players.some((existing) => existing.id === player.id)) {
    // Reentrada: recarregar a página ou voltar do bloqueio de tela não pode
    // custar a vaga de quem já estava jogando.
    return {
      ok: true,
      state: {
        ...state,
        players: state.players.map((existing) =>
          existing.id === player.id ? player : existing,
        ),
        updatedAt: now,
      },
    }
  }
  if (state.players.some((existing) => existing.characterId === player.characterId)) {
    return { ok: false, reason: 'Esse personagem já foi escolhido. Pegue outro.' }
  }
  if (state.players.length >= charactersOf(state.segments).length) {
    return { ok: false, reason: 'A partida já está cheia.' }
  }

  return { ok: true, state: { ...state, players: [...state.players, player], updatedAt: now } }
}

/** De quem é a vez: o primeiro trecho sem tomada, na ordem da cena. */
export function currentSegment(state: MatchState): MatchSegment | null {
  for (const segment of state.segments) {
    if (state.takes[segment.id] === undefined) return segment
  }
  return null
}

/** Quem deve gravar agora. `null` quando a cena acabou ou falta gente entrar. */
export function currentPlayer(state: MatchState): MatchPlayer | null {
  const segment = currentSegment(state)
  if (!segment) return null
  return state.players.find((player) => player.characterId === segment.characterId) ?? null
}

export function isPlayerTurn(state: MatchState, playerId: string): boolean {
  return currentPlayer(state)?.id === playerId
}

export function isMatchComplete(state: MatchState): boolean {
  return state.segments.length > 0 && currentSegment(state) === null
}

export type TakeResult =
  | { readonly ok: true; readonly state: MatchState }
  | { readonly ok: false; readonly reason: string }

/**
 * Registra a tomada de um trecho.
 *
 * A vez é conferida aqui, no servidor, e não na tela: confiar no cliente
 * deixaria alguém sobrescrever a fala do outro (§78). Regravar exige que o
 * trecho ainda esteja aberto — depois de fechado, quem passa por cima é a
 * regravação combinada, não uma corrida entre os dois aparelhos.
 */
export function applyTake(
  state: MatchState,
  segmentId: string,
  take: MatchTake,
  now: number,
): TakeResult {
  if (isExpired(state, now)) {
    return { ok: false, reason: 'Esta partida expirou.' }
  }
  const segment = state.segments.find((candidate) => candidate.id === segmentId)
  if (!segment) return { ok: false, reason: 'Trecho desconhecido nesta partida.' }

  const owner = state.players.find((player) => player.characterId === segment.characterId)
  if (!owner) return { ok: false, reason: 'Ninguém escolheu esse personagem ainda.' }
  if (owner.id !== take.playerId) {
    return { ok: false, reason: 'Esse trecho é do outro jogador.' }
  }
  if (state.takes[segmentId] !== undefined) {
    return { ok: false, reason: 'Esse trecho já foi gravado.' }
  }

  return {
    ok: true,
    state: { ...state, takes: { ...state.takes, [segmentId]: take }, updatedAt: now },
  }
}

/** Quantos trechos cada jogador já fechou. Alimenta o placar da tela. */
export function progressByPlayer(state: MatchState): Readonly<Record<string, number>> {
  const progress: Record<string, number> = {}
  for (const player of state.players) progress[player.id] = 0
  for (const segment of state.segments) {
    const take = state.takes[segment.id]
    if (!take) continue
    progress[take.playerId] = (progress[take.playerId] ?? 0) + 1
  }
  return progress
}
