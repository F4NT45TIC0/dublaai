/**
 * Partida online: dois aparelhos, o mesmo vídeo, um código para juntar os dois.
 *
 * O anfitrião escolhe a cena uma vez e o convidado a recebe pela sala. Arquivos
 * grandes sobem direto do navegador para o Blob, sem atravessar uma Function;
 * links diretos continuam sendo baixados da própria origem. Assim os dois
 * preparam exatamente o mesmo vídeo antes de o servidor liberar a primeira fala.
 *
 * As tomadas de voz também trafegam, uma por vez. A interface deixa essa
 * diferença em relação ao modo solo explícita antes da criação da partida.
 */

export interface MatchPlayer {
  readonly id: string
  readonly name: string
  /** Personagem (voz detectada) que esta pessoa dubla. */
  readonly characterId: string
  /** Só entra no rodízio depois de terminar de preparar a cena neste aparelho. */
  readonly ready: boolean
  /** Último heartbeat aceito pelo servidor. Ausente somente em estado legado. */
  readonly lastSeenAt?: number
}

/** Entrada tolerante para clientes anteriores; estado canônico nunca é aceito pelo join. */
export type MatchPlayerInput = Omit<MatchPlayer, 'ready' | 'lastSeenAt'> & {
  readonly ready?: boolean
  readonly lastSeenAt?: number
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
  /** Primeiro jogador da sala. Ausente apenas em partidas antigas ainda sem jogador. */
  readonly hostId?: string
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
  /** Referência imutável do upload direto no Vercel Blob. */
  readonly videoPathname?: string
  readonly videoContentType?: string
  readonly videoSize?: number
  readonly videoAccess?: 'private' | 'public'
  /** Define se mídias novas sobem direto ao Blob ou usam o fallback local de testes. */
  readonly storageAccess?: 'private' | 'file'
  /**
   * Link de onde a cena veio, quando o anfitrião a abriu por URL.
   *
   * Preferido ao arquivo guardado: quem entra baixa direto da fonte, sem uma
   * cópia adicional no Blob nem o custo de o servidor servir o vídeo de novo.
   */
  readonly videoUrl?: string
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * Uma partida vive 24 horas.
 *
 * Depois desse prazo, estado e mídia deixam de ser servidos pelas rotas da
 * partida. O prazo é curto o bastante para limitar o convite e longo o bastante
 * para quem combinou de jogar à noite.
 */
export const MATCH_TTL_MS = 24 * 60 * 60 * 1_000

/** Heartbeat a cada poucos segundos; depois deste intervalo a dupla pausa. */
export const MATCH_PRESENCE_TIMEOUT_MS = 12_000

/** A sala é uma dupla: nem jogador nem personagem extra entra no rodízio. */
export const MATCH_PLAYER_COUNT = 2
export const MATCH_CHARACTER_COUNT = 2

/** Mantido para as rotas existentes; o domínio abaixo exige igualdade, não só mínimo. */
export const MIN_MATCH_CHARACTERS = MATCH_CHARACTER_COUNT

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
  player: MatchPlayerInput,
  videoId: string,
  now: number,
): JoinResult {
  if (isExpired(state, now)) {
    return { ok: false, reason: 'Esta partida expirou. Crie uma nova para continuar.' }
  }
  const characters = charactersOf(state.segments)
  if (characters.length !== MATCH_CHARACTER_COUNT) {
    return {
      ok: false,
      reason: 'A partida online precisa ter exatamente dois personagens.',
    }
  }
  if (!characters.includes(player.characterId)) {
    return { ok: false, reason: 'Esse personagem não existe nesta partida.' }
  }
  // Com o vídeo guardado na partida, os dois lados têm o mesmo arquivo por
  // construção — a conferência só faz sentido quando cada um trouxe o seu.
  const cenaVemDaPartida = state.videoShared === true || state.videoUrl !== undefined
  if (!cenaVemDaPartida && state.videoId !== videoId) {
    return {
      ok: false,
      reason:
        'O vídeo aberto aqui não é o mesmo da partida. Os dois precisam abrir exatamente o mesmo arquivo.',
    }
  }
  const returning = state.players.find((existing) => existing.id === player.id)
  if (returning) {
    const characterTakenByAnother = state.players.some(
      (existing) => existing.id !== player.id && existing.characterId === player.characterId,
    )
    if (characterTakenByAnother) {
      return { ok: false, reason: 'Esse personagem já foi escolhido. Pegue outro.' }
    }

    // Reentrada: recarregar a página ou voltar do bloqueio de tela não pode
    // custar a vaga nem permitir que o cliente se declare pronto sozinho.
    const sameCharacter = returning.characterId === player.characterId
    const reentered: MatchPlayer = {
      id: player.id,
      name: player.name,
      characterId: player.characterId,
      // Trocar de personagem exige preparar a cena de novo.
      ready: sameCharacter && returning.ready,
      lastSeenAt: now,
    }
    return {
      ok: true,
      state: {
        ...state,
        hostId: state.hostId ?? state.players[0]?.id ?? player.id,
        players: state.players.map((existing) =>
          existing.id === player.id ? reentered : existing,
        ),
        updatedAt: now,
      },
    }
  }
  if (state.players.length >= MATCH_PLAYER_COUNT) {
    return { ok: false, reason: 'A partida já está cheia.' }
  }
  if (state.players.some((existing) => existing.characterId === player.characterId)) {
    return { ok: false, reason: 'Esse personagem já foi escolhido. Pegue outro.' }
  }

  const joined: MatchPlayer = {
    id: player.id,
    name: player.name,
    characterId: player.characterId,
    // Só markPlayerReady pode alterar esta informação no estado canônico.
    ready: false,
    lastSeenAt: now,
  }
  return {
    ok: true,
    state: {
      ...state,
      // Quando a sala ficou vazia, o host anterior é apenas histórico. A
      // primeira pessoa da nova dupla precisa assumir a sala; caso contrário
      // `isMatchReady` nunca encontraria o host entre os jogadores presentes.
      hostId: state.players.length === 0 ? player.id : (state.hostId ?? state.players[0]?.id),
      players: [...state.players, joined],
      updatedAt: now,
    },
  }
}

export type ReadyResult =
  | { readonly ok: true; readonly state: MatchState }
  | { readonly ok: false; readonly reason: string }

/** Atualiza o preparo do aparelho e renova sua presença na mesma mutação. */
export function markPlayerReady(
  state: MatchState,
  playerId: string,
  now: number,
  ready = true,
): ReadyResult {
  if (isExpired(state, now)) {
    return { ok: false, reason: 'Esta partida expirou.' }
  }
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player) return { ok: false, reason: 'Jogador não encontrado nesta partida.' }

  return {
    ok: true,
    state: {
      ...state,
      players: state.players.map((candidate) =>
        candidate.id === playerId ? { ...candidate, ready, lastSeenAt: now } : candidate,
      ),
      updatedAt: now,
    },
  }
}

export type PresenceResult =
  | { readonly ok: true; readonly state: MatchState }
  | { readonly ok: false; readonly reason: string }

/** Renova a presença sem alterar personagem, prontidão ou qualquer tomada. */
export function touchPlayer(state: MatchState, playerId: string, now: number): PresenceResult {
  if (isExpired(state, now)) {
    return { ok: false, reason: 'Esta partida expirou.' }
  }
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player) return { ok: false, reason: 'Jogador não encontrado nesta partida.' }

  return {
    ok: true,
    state: {
      ...state,
      players: state.players.map((candidate) =>
        candidate.id === playerId ? { ...candidate, lastSeenAt: now } : candidate,
      ),
      updatedAt: now,
    },
  }
}

export type LeaveResult =
  | { readonly ok: true; readonly state: MatchState }
  | { readonly ok: false; readonly reason: string }

/** Sai da sala, libera o personagem e entrega a função de anfitrião a quem ficou. */
export function leaveMatch(state: MatchState, playerId: string, now: number): LeaveResult {
  if (isExpired(state, now)) {
    return { ok: false, reason: 'Esta partida expirou.' }
  }
  if (!state.players.some((player) => player.id === playerId)) {
    return { ok: false, reason: 'Jogador não encontrado nesta partida.' }
  }

  const remaining = state.players.filter((player) => player.id !== playerId)
  const currentHostStillPresent = remaining.some((player) => player.id === state.hostId)
  const hostId =
    remaining.length === 0
      ? (state.hostId ?? playerId)
      : currentHostStillPresent
        ? state.hostId
        : remaining[0]?.id

  return {
    ok: true,
    state: {
      ...state,
      ...(hostId === undefined ? {} : { hostId }),
      players: remaining,
      updatedAt: now,
    },
  }
}

/**
 * Libera uma vaga cujo aparelho parou de enviar heartbeat.
 *
 * A remoção nunca é automática: doze segundos também podem ser uma troca de
 * rede. A pessoa que continuou na sala decide quando quer substituir a dupla,
 * e o servidor reconfirma que ela está presente e a outra ponta realmente não.
 */
export function reclaimDisconnectedPlayer(
  state: MatchState,
  requesterId: string,
  disconnectedPlayerId: string,
  now: number,
): LeaveResult {
  if (requesterId === disconnectedPlayerId) {
    return { ok: false, reason: 'Use a saída normal para deixar a partida.' }
  }
  const requester = state.players.find((player) => player.id === requesterId)
  if (!requester || !isPlayerPresent(requester, now)) {
    return { ok: false, reason: 'Somente um jogador presente pode liberar a outra vaga.' }
  }
  const disconnected = state.players.find((player) => player.id === disconnectedPlayerId)
  if (!disconnected) return { ok: false, reason: 'Jogador não encontrado nesta partida.' }
  if (isPlayerPresent(disconnected, now)) {
    return { ok: false, reason: 'Esse jogador ainda está conectado à partida.' }
  }
  return leaveMatch(state, disconnectedPlayerId, now)
}

export function isPlayerPresent(player: MatchPlayer, now = Date.now()): boolean {
  // Estados persistidos antes da presença não têm `lastSeenAt`: começam
  // pausados e voltam assim que join/touch/ready renovar o jogador.
  return (
    typeof player.lastSeenAt === 'number' &&
    Number.isFinite(player.lastSeenAt) &&
    Math.max(0, now - player.lastSeenAt) <= MATCH_PRESENCE_TIMEOUT_MS
  )
}

/** A gravação só começa com a dupla completa, uma voz para cada pessoa e ambas prontas. */
export function isMatchReady(state: MatchState, now = state.updatedAt): boolean {
  if (charactersOf(state.segments).length !== MATCH_CHARACTER_COUNT) return false
  if (state.players.length !== MATCH_PLAYER_COUNT) return false
  if (!state.hostId || !state.players.some((player) => player.id === state.hostId)) return false

  const playerIds = new Set(state.players.map((player) => player.id))
  const characterIds = new Set(state.players.map((player) => player.characterId))
  if (playerIds.size !== MATCH_PLAYER_COUNT || characterIds.size !== MATCH_CHARACTER_COUNT) {
    return false
  }

  const sceneCharacters = new Set(charactersOf(state.segments))
  return state.players.every(
    (player) =>
      player.ready && sceneCharacters.has(player.characterId) && isPlayerPresent(player, now),
  )
}

/** De quem é a vez: o primeiro trecho sem tomada, na ordem da cena. */
export function currentSegment(state: MatchState): MatchSegment | null {
  for (const segment of state.segments) {
    if (state.takes[segment.id] === undefined) return segment
  }
  return null
}

/** Quem deve gravar agora. `null` quando a cena acabou ou falta gente entrar. */
export function currentPlayer(state: MatchState, now = state.updatedAt): MatchPlayer | null {
  if (!isMatchReady(state, now)) return null
  const segment = currentSegment(state)
  if (!segment) return null
  return state.players.find((player) => player.characterId === segment.characterId) ?? null
}

export function isPlayerTurn(state: MatchState, playerId: string, now = state.updatedAt): boolean {
  return currentPlayer(state, now)?.id === playerId
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
  if (!isMatchReady(state, now)) {
    return {
      ok: false,
      reason: 'A partida só começa quando os dois jogadores estiverem prontos e presentes.',
    }
  }
  const segment = state.segments.find((candidate) => candidate.id === segmentId)
  if (!segment) return { ok: false, reason: 'Trecho desconhecido nesta partida.' }
  if (state.takes[segmentId] !== undefined) {
    return { ok: false, reason: 'Esse trecho já foi gravado.' }
  }
  if (currentSegment(state)?.id !== segmentId) {
    return { ok: false, reason: 'Esta fala ainda não está na vez.' }
  }

  const owner = state.players.find((player) => player.characterId === segment.characterId)
  if (!owner) return { ok: false, reason: 'Ninguém escolheu esse personagem ainda.' }
  if (owner.id !== take.playerId) {
    return { ok: false, reason: 'Esse trecho é do outro jogador.' }
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
