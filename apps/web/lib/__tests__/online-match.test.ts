import { describe, expect, it } from 'vitest'
import {
  applyTake,
  availableCharacters,
  currentPlayer,
  currentSegment,
  isExpired,
  isMatchComplete,
  isMatchReady,
  isPlayerTurn,
  joinMatch,
  leaveMatch,
  markPlayerReady,
  MATCH_PRESENCE_TIMEOUT_MS,
  MATCH_TTL_MS,
  progressByPlayer,
  reclaimDisconnectedPlayer,
  touchPlayer,
  type MatchPlayer,
  type MatchState,
  type MatchTake,
} from '../online-match'

const NOW = 1_700_000_000_000

function baseState(overrides: Partial<MatchState> = {}): MatchState {
  return {
    code: 'K7M29XQP4TVB',
    videoId: 'video-abc',
    videoName: 'cena.mp4',
    durationMs: 10_000,
    segments: [
      { id: 's1', characterId: 'voz-1', startMs: 0, endMs: 2_000, text: 'Oi' },
      { id: 's2', characterId: 'voz-2', startMs: 2_500, endMs: 4_000, text: 'Tudo bem?' },
      { id: 's3', characterId: 'voz-1', startMs: 5_000, endMs: 7_000, text: 'Tudo' },
    ],
    players: [],
    takes: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

const take = (playerId: string): MatchTake => ({
  playerId,
  url: `https://exemplo/${playerId}.wav`,
  mediaStartOffsetMs: -700,
  sampleRate: 48_000,
})

const anfitriao: MatchPlayer = {
  id: 'p1',
  name: 'Ana',
  characterId: 'voz-1',
  ready: false,
  lastSeenAt: NOW,
}
const convidado: MatchPlayer = {
  id: 'p2',
  name: 'Bia',
  characterId: 'voz-2',
  ready: false,
  lastSeenAt: NOW,
}

function readyState(overrides: Partial<MatchState> = {}): MatchState {
  return baseState({
    hostId: anfitriao.id,
    players: [
      { ...anfitriao, ready: true },
      { ...convidado, ready: true },
    ],
    ...overrides,
  })
}

describe('joinMatch', () => {
  it('deixa entrar quem chega com o mesmo vídeo, registra o anfitrião e começa não pronto', () => {
    const result = joinMatch(baseState(), { ...anfitriao, ready: true }, 'video-abc', NOW + 1)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.state.hostId).toBe('p1')
    expect(result.state.players).toEqual([{ ...anfitriao, ready: false, lastSeenAt: NOW + 1 }])
  })

  it('recusa quem abriu outro arquivo', () => {
    const result = joinMatch(baseState(), anfitriao, 'outro-video', NOW)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/mesmo arquivo/i)
  })

  it('recusa personagem que não existe na cena', () => {
    const result = joinMatch(
      baseState(),
      { id: 'p9', name: 'Caio', characterId: 'voz-fantasma' },
      'video-abc',
      NOW,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/não existe/i)
  })

  it('recusa uma cena com mais ou menos de dois personagens', () => {
    const state = baseState()
    const comTres = {
      ...state,
      segments: [
        ...state.segments,
        { id: 's4', characterId: 'voz-3', startMs: 8_000, endMs: 9_000, text: 'Ei' },
      ],
    }
    const result = joinMatch(comTres, anfitriao, 'video-abc', NOW)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/exatamente dois personagens/i)
  })

  it('recusa personagem já escolhido', () => {
    const state = baseState({ hostId: anfitriao.id, players: [anfitriao] })
    const result = joinMatch(
      state,
      { id: 'p9', name: 'Caio', characterId: 'voz-1' },
      'video-abc',
      NOW,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/já foi escolhido/i)
  })

  it('reentrar preserva vaga, personagem e prontidão', () => {
    const state = readyState()
    const result = joinMatch(
      state,
      { ...anfitriao, name: 'Ana II', ready: false },
      'video-abc',
      NOW + 1,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.players).toHaveLength(2)
    expect(result.state.players[0]).toEqual({
      ...anfitriao,
      name: 'Ana II',
      ready: true,
      lastSeenAt: NOW + 1,
    })
    expect(isMatchReady(result.state, NOW + 1)).toBe(true)
  })

  it('reentrada não pode tomar o personagem do outro jogador', () => {
    const state = readyState()
    const result = joinMatch(
      state,
      { ...anfitriao, characterId: convidado.characterId },
      'video-abc',
      NOW + 1,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/já foi escolhido/i)
  })

  it('trocar para um personagem livre exige ficar pronto de novo', () => {
    const state = baseState({
      hostId: anfitriao.id,
      players: [{ ...anfitriao, ready: true }],
    })
    const result = joinMatch(
      state,
      { ...anfitriao, characterId: convidado.characterId },
      'video-abc',
      NOW + 1,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.state.players[0]).toMatchObject({ ready: false, lastSeenAt: NOW + 1 })
    }
  })

  it('recusa um terceiro jogador mesmo que ele tente escolher outra voz', () => {
    const result = joinMatch(
      readyState(),
      { id: 'p3', name: 'Caio', characterId: 'voz-1' },
      'video-abc',
      NOW + 1,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/cheia/i)
  })

  it('recusa partida vencida', () => {
    const result = joinMatch(baseState(), anfitriao, 'video-abc', NOW + MATCH_TTL_MS + 1)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/expirou/i)
  })

  it('lista os personagens ainda livres', () => {
    expect(availableCharacters(baseState({ hostId: anfitriao.id, players: [anfitriao] }))).toEqual([
      'voz-2',
    ])
  })
})

describe('prontidão da dupla', () => {
  it('marca cada jogador pronto e só libera quando os dois terminaram', () => {
    const entrouA = joinMatch(baseState(), anfitriao, 'video-abc', NOW + 1)
    expect(entrouA.ok).toBe(true)
    if (!entrouA.ok) return
    const entrouB = joinMatch(entrouA.state, convidado, 'video-abc', NOW + 2)
    expect(entrouB.ok).toBe(true)
    if (!entrouB.ok) return

    const prontaA = markPlayerReady(entrouB.state, anfitriao.id, NOW + 3)
    expect(prontaA.ok).toBe(true)
    if (!prontaA.ok) return
    expect(prontaA.state.players[0]?.lastSeenAt).toBe(NOW + 3)
    expect(isMatchReady(prontaA.state, NOW + 3)).toBe(false)

    const prontaB = markPlayerReady(prontaA.state, convidado.id, NOW + 4)
    expect(prontaB.ok).toBe(true)
    if (!prontaB.ok) return
    expect(prontaB.state.players[1]?.lastSeenAt).toBe(NOW + 4)
    expect(isMatchReady(prontaB.state, NOW + 4)).toBe(true)
  })

  it('marcar pronto de novo preserva a escolha e renova a presença', () => {
    const state = readyState()
    const result = markPlayerReady(state, anfitriao.id, NOW + 1)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.players[0]).toEqual({
      ...anfitriao,
      ready: true,
      lastSeenAt: NOW + 1,
    })
    expect(result.state.updatedAt).toBe(NOW + 1)
  })

  it('volta o aparelho para preparando durante um refresh', () => {
    const result = markPlayerReady(readyState(), anfitriao.id, NOW + 1, false)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.state.players.find((player) => player.id === anfitriao.id)?.ready).toBe(false)
    expect(isMatchReady(result.state, NOW + 1)).toBe(false)
  })

  it('recusa jogador desconhecido ou partida vencida', () => {
    const unknown = markPlayerReady(readyState(), 'fantasma', NOW)
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.reason).toMatch(/não encontrado/i)

    const expired = markPlayerReady(readyState(), anfitriao.id, NOW + MATCH_TTL_MS + 1)
    expect(expired.ok).toBe(false)
    if (!expired.ok) expect(expired.reason).toMatch(/expirou/i)
  })

  it('exige host válido, dois ids e dois personagens distintos', () => {
    expect(isMatchReady(readyState({ hostId: 'fantasma' }), NOW)).toBe(false)
    expect(
      isMatchReady(
        readyState({
          players: [
            { ...anfitriao, ready: true },
            { ...anfitriao, ready: true },
          ],
        }),
        NOW,
      ),
    ).toBe(false)
    expect(
      isMatchReady(
        readyState({
          players: [
            { ...anfitriao, ready: true },
            { ...convidado, characterId: anfitriao.characterId, ready: true },
          ],
        }),
        NOW,
      ),
    ).toBe(false)
  })

  it('não considera pronta uma sala com terceiro personagem ou jogador', () => {
    const state = readyState()
    expect(
      isMatchReady(
        {
          ...state,
          segments: [
            ...state.segments,
            { id: 's4', characterId: 'voz-3', startMs: 8_000, endMs: 9_000, text: 'Ei' },
          ],
        },
        NOW,
      ),
    ).toBe(false)
    expect(
      isMatchReady(
        {
          ...state,
          players: [
            ...state.players,
            {
              id: 'p3',
              name: 'Caio',
              characterId: 'voz-3',
              ready: true,
              lastSeenAt: NOW,
            },
          ],
        },
        NOW,
      ),
    ).toBe(false)
  })
})

describe('presença e saída', () => {
  it('estado legado sem lastSeenAt começa pausado até receber heartbeat', () => {
    const legacy = readyState({
      players: [
        { id: anfitriao.id, name: anfitriao.name, characterId: anfitriao.characterId, ready: true },
        { id: convidado.id, name: convidado.name, characterId: convidado.characterId, ready: true },
      ],
    })

    expect(isMatchReady(legacy, NOW)).toBe(false)
  })

  it('mantém a sala pronta até o limite e pausa quando um heartbeat vence', () => {
    const state = readyState()
    const noLimite = NOW + MATCH_PRESENCE_TIMEOUT_MS
    const vencido = noLimite + 1

    expect(isMatchReady(state, noLimite)).toBe(true)
    expect(isMatchReady(state, vencido)).toBe(false)
    expect(currentPlayer(state, vencido)).toBeNull()
    expect(isPlayerTurn(state, anfitriao.id, vencido)).toBe(false)

    const result = applyTake(state, 's1', take(anfitriao.id), vencido)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/prontos e presentes/i)
  })

  it('usa a linha do tempo do servidor sem depender do relógio do aparelho', () => {
    const serverNow = NOW + 60_000
    const state = readyState({
      updatedAt: serverNow,
      players: [
        { ...anfitriao, ready: true, lastSeenAt: serverNow },
        { ...convidado, ready: true, lastSeenAt: serverNow },
      ],
    })

    expect(isMatchReady(state)).toBe(true)
    expect(currentPlayer(state)?.id).toBe(anfitriao.id)
  })

  it('retoma a partida somente depois do heartbeat dos dois jogadores', () => {
    const stale = readyState()
    const heartbeatAt = NOW + MATCH_PRESENCE_TIMEOUT_MS + 1
    const touchedHost = touchPlayer(stale, anfitriao.id, heartbeatAt)
    expect(touchedHost.ok).toBe(true)
    if (!touchedHost.ok) return
    expect(touchedHost.state.players[0]?.ready).toBe(true)
    expect(isMatchReady(touchedHost.state, heartbeatAt)).toBe(false)

    const touchedGuest = touchPlayer(touchedHost.state, convidado.id, heartbeatAt)
    expect(touchedGuest.ok).toBe(true)
    if (!touchedGuest.ok) return
    expect(isMatchReady(touchedGuest.state, heartbeatAt)).toBe(true)
    expect(currentPlayer(touchedGuest.state, heartbeatAt)?.id).toBe(anfitriao.id)
  })

  it('touch recusa jogador desconhecido ou partida vencida', () => {
    const unknown = touchPlayer(readyState(), 'fantasma', NOW)
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.reason).toMatch(/não encontrado/i)

    const expired = touchPlayer(readyState(), anfitriao.id, NOW + MATCH_TTL_MS + 1)
    expect(expired.ok).toBe(false)
    if (!expired.ok) expect(expired.reason).toMatch(/expirou/i)
  })

  it('saída do anfitrião transfere a sala, libera a voz e abre vaga', () => {
    const left = leaveMatch(readyState(), anfitriao.id, NOW + 1)
    expect(left.ok).toBe(true)
    if (!left.ok) return

    expect(left.state.hostId).toBe(convidado.id)
    expect(left.state.players.map((player) => player.id)).toEqual([convidado.id])
    expect(availableCharacters(left.state)).toEqual([anfitriao.characterId])
    expect(isMatchReady(left.state, NOW + 1)).toBe(false)

    const replacement = joinMatch(
      left.state,
      { id: 'p3', name: 'Caio', characterId: anfitriao.characterId },
      'video-abc',
      NOW + 2,
    )
    expect(replacement.ok).toBe(true)
    if (!replacement.ok) return
    expect(replacement.state.hostId).toBe(convidado.id)
    expect(replacement.state.players).toHaveLength(2)
    expect(replacement.state.players[1]).toMatchObject({
      id: 'p3',
      ready: false,
      lastSeenAt: NOW + 2,
    })
  })

  it('saída do convidado preserva o host; sala vazia preserva o último host histórico', () => {
    const guestLeft = leaveMatch(readyState(), convidado.id, NOW + 1)
    expect(guestLeft.ok).toBe(true)
    if (!guestLeft.ok) return
    expect(guestLeft.state.hostId).toBe(anfitriao.id)

    const hostLeft = leaveMatch(guestLeft.state, anfitriao.id, NOW + 2)
    expect(hostLeft.ok).toBe(true)
    if (!hostLeft.ok) return
    expect(hostLeft.state.players).toEqual([])
    expect(hostLeft.state.hostId).toBe(anfitriao.id)
  })

  it('a primeira pessoa de uma nova dupla assume como host depois que a sala esvazia', () => {
    const guestLeft = leaveMatch(readyState(), convidado.id, NOW + 1)
    expect(guestLeft.ok).toBe(true)
    if (!guestLeft.ok) return
    const emptied = leaveMatch(guestLeft.state, anfitriao.id, NOW + 2)
    expect(emptied.ok).toBe(true)
    if (!emptied.ok) return

    const novoHost = { id: 'p3', name: 'Caio', characterId: 'voz-1' }
    const novaConvidada = { id: 'p4', name: 'Dani', characterId: 'voz-2' }
    const first = joinMatch(emptied.state, novoHost, 'video-abc', NOW + 3)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.state.hostId).toBe(novoHost.id)

    const second = joinMatch(first.state, novaConvidada, 'video-abc', NOW + 4)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    const readyHost = markPlayerReady(second.state, novoHost.id, NOW + 5)
    expect(readyHost.ok).toBe(true)
    if (!readyHost.ok) return
    const readyGuest = markPlayerReady(readyHost.state, novaConvidada.id, NOW + 6)
    expect(readyGuest.ok).toBe(true)
    if (!readyGuest.ok) return
    expect(isMatchReady(readyGuest.state, NOW + 6)).toBe(true)
  })

  it('leave recusa jogador desconhecido', () => {
    const result = leaveMatch(readyState(), 'fantasma', NOW)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/não encontrado/i)
  })

  it('jogador presente libera a vaga desconectada e uma nova dupla pode entrar', () => {
    const now = NOW + MATCH_PRESENCE_TIMEOUT_MS + 1
    const staleGuest = readyState({
      updatedAt: now,
      players: [
        { ...anfitriao, ready: true, lastSeenAt: now },
        { ...convidado, ready: true, lastSeenAt: NOW },
      ],
    })
    const reclaimed = reclaimDisconnectedPlayer(staleGuest, anfitriao.id, convidado.id, now)
    expect(reclaimed.ok).toBe(true)
    if (!reclaimed.ok) return
    expect(reclaimed.state.players.map((player) => player.id)).toEqual([anfitriao.id])
    expect(availableCharacters(reclaimed.state)).toEqual([convidado.characterId])

    const replacement = { id: 'p3', name: 'Caio', characterId: convidado.characterId }
    const joined = joinMatch(reclaimed.state, replacement, 'video-abc', now + 1)
    expect(joined.ok).toBe(true)
    if (!joined.ok) return
    expect(isMatchReady(joined.state, now + 1)).toBe(false)
    const ready = markPlayerReady(joined.state, replacement.id, now + 2)
    expect(ready.ok).toBe(true)
    if (!ready.ok) return
    expect(isMatchReady(ready.state, now + 2)).toBe(true)
  })

  it('transfere o host desconectado e recusa liberar quem ainda está presente', () => {
    const now = NOW + MATCH_PRESENCE_TIMEOUT_MS + 1
    const staleHost = readyState({
      updatedAt: now,
      players: [
        { ...anfitriao, ready: true, lastSeenAt: NOW },
        { ...convidado, ready: true, lastSeenAt: now },
      ],
    })
    const reclaimed = reclaimDisconnectedPlayer(staleHost, convidado.id, anfitriao.id, now)
    expect(reclaimed.ok).toBe(true)
    if (!reclaimed.ok) return
    expect(reclaimed.state.hostId).toBe(convidado.id)

    const connected = reclaimDisconnectedPlayer(readyState(), anfitriao.id, convidado.id, NOW)
    expect(connected.ok).toBe(false)
    if (!connected.ok) expect(connected.reason).toMatch(/ainda está conectado/i)
  })
})

describe('vez e progresso', () => {
  const state = readyState()

  it('não entrega a vez enquanto os dois jogadores não estão prontos', () => {
    const waiting = readyState({
      players: [
        { ...anfitriao, ready: true },
        { ...convidado, ready: false },
      ],
    })

    expect(currentSegment(waiting)?.id).toBe('s1')
    expect(currentPlayer(waiting, NOW)).toBeNull()
    expect(isPlayerTurn(waiting, anfitriao.id, NOW)).toBe(false)
  })

  it('a vez segue a ordem da cena quando a dupla está pronta', () => {
    expect(currentSegment(state)?.id).toBe('s1')
    expect(currentPlayer(state, NOW)?.id).toBe('p1')
    expect(isPlayerTurn(state, 'p2', NOW)).toBe(false)
  })

  it('passa para o dono do trecho seguinte', () => {
    const result = applyTake(state, 's1', take('p1'), NOW)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(currentSegment(result.state)?.id).toBe('s2')
    expect(currentPlayer(result.state, NOW)?.id).toBe('p2')
  })

  it('conta o placar por jogador', () => {
    const first = applyTake(state, 's1', take('p1'), NOW)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = applyTake(first.state, 's2', take('p2'), NOW)
    expect(second.ok).toBe(true)
    if (!second.ok) return

    expect(progressByPlayer(second.state)).toEqual({ p1: 1, p2: 1 })
    expect(isMatchComplete(second.state)).toBe(false)
  })

  it('a partida fecha quando o último trecho entra', () => {
    let current = state
    for (const [segmentId, playerId] of [
      ['s1', 'p1'],
      ['s2', 'p2'],
      ['s3', 'p1'],
    ] as const) {
      const result = applyTake(current, segmentId, take(playerId), NOW)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      current = result.state
    }
    expect(isMatchComplete(current)).toBe(true)
    expect(currentPlayer(current, NOW)).toBeNull()
  })
})

describe('applyTake protege o turno no servidor', () => {
  const state = readyState()

  it('recusa qualquer tomada antes de os dois jogadores estarem prontos', () => {
    const waiting = readyState({
      players: [
        { ...anfitriao, ready: true },
        { ...convidado, ready: false },
      ],
    })
    const result = applyTake(waiting, 's1', take('p1'), NOW)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/dois jogadores.*prontos/i)
  })

  it('recusa quem tenta gravar o trecho do outro', () => {
    const result = applyTake(state, 's1', take('p2'), NOW)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/do outro jogador/i)
  })

  it('recusa pular uma fala mesmo quando o trecho futuro pertence ao jogador', () => {
    const result = applyTake(state, 's3', take('p1'), NOW)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/ainda não está na vez/i)
  })

  it('recusa sobrescrever trecho já gravado', () => {
    const first = applyTake(state, 's1', take('p1'), NOW)
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const again = applyTake(first.state, 's1', take('p1'), NOW)
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.reason).toMatch(/já foi gravado/i)
  })

  it('recusa trecho que não existe na partida', () => {
    expect(applyTake(state, 'fantasma', take('p1'), NOW).ok).toBe(false)
  })

  it('partida vencida não aceita mais nada', () => {
    expect(isExpired(state, NOW + MATCH_TTL_MS + 1)).toBe(true)
    expect(applyTake(state, 's1', take('p1'), NOW + MATCH_TTL_MS + 1).ok).toBe(false)
  })
})
