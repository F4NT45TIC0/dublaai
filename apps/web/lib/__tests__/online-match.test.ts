import { describe, expect, it } from 'vitest'
import {
  applyTake,
  availableCharacters,
  currentPlayer,
  currentSegment,
  isExpired,
  isMatchComplete,
  isPlayerTurn,
  joinMatch,
  MATCH_TTL_MS,
  progressByPlayer,
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

const anfitriao = { id: 'p1', name: 'Ana', characterId: 'voz-1' }
const convidado = { id: 'p2', name: 'Bia', characterId: 'voz-2' }

describe('joinMatch', () => {
  it('deixa entrar quem chega com o mesmo vídeo', () => {
    const result = joinMatch(baseState(), anfitriao, 'video-abc', NOW)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.state.players).toHaveLength(1)
  })

  it('recusa quem abriu outro arquivo', () => {
    const result = joinMatch(baseState(), anfitriao, 'outro-video', NOW)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/mesmo arquivo/i)
  })

  it('recusa personagem já escolhido', () => {
    const state = baseState({ players: [anfitriao] })
    const result = joinMatch(state, { id: 'p9', name: 'Caio', characterId: 'voz-1' }, 'video-abc', NOW)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/já foi escolhido/i)
  })

  it('reentrar não custa a vaga de quem recarregou a página', () => {
    const state = baseState({ players: [anfitriao, convidado] })
    const result = joinMatch(state, { ...anfitriao, name: 'Ana II' }, 'video-abc', NOW)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.state.players).toHaveLength(2)
      expect(result.state.players[0]?.name).toBe('Ana II')
    }
  })

  it('recusa partida vencida', () => {
    const result = joinMatch(baseState(), anfitriao, 'video-abc', NOW + MATCH_TTL_MS + 1)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/expirou/i)
  })

  it('lista os personagens ainda livres', () => {
    expect(availableCharacters(baseState({ players: [anfitriao] }))).toEqual(['voz-2'])
  })
})

describe('vez e progresso', () => {
  const state = baseState({ players: [anfitriao, convidado] })

  it('a vez segue a ordem da cena', () => {
    expect(currentSegment(state)?.id).toBe('s1')
    expect(currentPlayer(state)?.id).toBe('p1')
    expect(isPlayerTurn(state, 'p2')).toBe(false)
  })

  it('passa para o dono do trecho seguinte', () => {
    const result = applyTake(state, 's1', take('p1'), NOW)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(currentSegment(result.state)?.id).toBe('s2')
    expect(currentPlayer(result.state)?.id).toBe('p2')
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
    expect(currentPlayer(current)).toBeNull()
  })
})

describe('applyTake protege o turno no servidor', () => {
  const state = baseState({ players: [anfitriao, convidado] })

  it('recusa quem tenta gravar o trecho do outro', () => {
    const result = applyTake(state, 's1', take('p2'), NOW)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/do outro jogador/i)
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

  it('recusa quando ninguém pegou o personagem', () => {
    const solo = baseState({ players: [anfitriao] })
    const result = applyTake(solo, 's2', take('p1'), NOW)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/ninguém escolheu/i)
  })

  it('partida vencida não aceita mais nada', () => {
    expect(isExpired(state, NOW + MATCH_TTL_MS + 1)).toBe(true)
    expect(applyTake(state, 's1', take('p1'), NOW + MATCH_TTL_MS + 1).ok).toBe(false)
  })
})
