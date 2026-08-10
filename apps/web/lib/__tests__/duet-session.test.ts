import { describe, expect, it } from 'vitest'
import type { SpeakerSegment } from '@dubla/shared'
import {
  audioSourceMap,
  clearTake,
  createDuetSession,
  isComplete,
  nextPendingIndex,
  playableSegments,
  progressByPlayer,
  recordTake,
  segmentOwner,
  type DuetPlayer,
} from '../duet-session'

/** Falha alto em vez de mascarar um índice errado com asserção não-nula. */
function must<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} não existe`)
  return value
}

function segment(id: string, characterId: string, startMs: number): SpeakerSegment {
  return {
    id,
    sceneId: 'cena',
    characterId,
    startMs,
    endMs: startMs + 900,
    text: id,
    orderIndex: 0,
  }
}

const ANA: DuetPlayer = { id: 'p1', name: 'Ana', characterId: 'shrek' }
const BRUNO: DuetPlayer = { id: 'p2', name: 'Bruno', characterId: 'burro' }
const PLAYERS = [ANA, BRUNO] as const

// Falas alternadas, fora de ordem de propósito: a ordem cronológica precisa
// vir do startMs, não da posição no array.
const SEGMENTS: readonly SpeakerSegment[] = [
  segment('s3', 'shrek', 5_000),
  segment('s1', 'shrek', 1_000),
  segment('s2', 'burro', 3_000),
  segment('s4', 'burro', 7_000),
]

describe('turnos do dueto', () => {
  it('atribui cada fala ao dono do personagem', () => {
    expect(segmentOwner(segment('x', 'shrek', 0), PLAYERS)?.id).toBe('p1')
    expect(segmentOwner(segment('x', 'burro', 0), PLAYERS)?.id).toBe('p2')
    expect(segmentOwner(segment('x', 'fiona', 0), PLAYERS)).toBeUndefined()
  })

  it('percorre as falas em ordem cronológica, não na ordem do array', () => {
    const ordered = playableSegments(SEGMENTS, PLAYERS).map((entry) => entry.id)
    expect(ordered).toEqual(['s1', 's2', 's3', 's4'])
  })

  it('alterna entre os jogadores conforme a cena avança', () => {
    let session = createDuetSession('cena', PLAYERS)
    const ordered = playableSegments(SEGMENTS, PLAYERS)

    // A vez é sempre de quem é dono da próxima fala pendente.
    expect(nextPendingIndex(SEGMENTS, session)).toBe(0)
    expect(segmentOwner(must(ordered[0], 'fala 1'), PLAYERS)?.id).toBe('p1')

    session = recordTake(session, 's1', 'p1')
    expect(nextPendingIndex(SEGMENTS, session)).toBe(1)
    expect(segmentOwner(must(ordered[1], 'fala 2'), PLAYERS)?.id).toBe('p2')

    session = recordTake(session, 's2', 'p2')
    expect(
      segmentOwner(must(ordered[nextPendingIndex(SEGMENTS, session)], 'próxima fala'), PLAYERS)?.id,
    ).toBe('p1')
  })

  it('só termina quando todas as falas têm tomada', () => {
    let session = createDuetSession('cena', PLAYERS)
    expect(isComplete(SEGMENTS, session)).toBe(false)

    for (const entry of playableSegments(SEGMENTS, PLAYERS)) {
      expect(isComplete(SEGMENTS, session)).toBe(false)
      session = recordTake(session, entry.id, must(segmentOwner(entry, PLAYERS), 'dono').id)
    }

    expect(isComplete(SEGMENTS, session)).toBe(true)
    expect(nextPendingIndex(SEGMENTS, session)).toBe(-1)
  })

  it('regravar substitui a tomada em vez de duplicar', () => {
    let session = createDuetSession('cena', PLAYERS)
    session = recordTake(session, 's1', 'p1')
    session = recordTake(session, 's1', 'p1')

    expect(Object.keys(session.takes)).toEqual(['s1'])
  })

  it('descartar uma tomada devolve a fala ao rodízio', () => {
    let session = createDuetSession('cena', PLAYERS)
    for (const entry of playableSegments(SEGMENTS, PLAYERS)) {
      session = recordTake(session, entry.id, must(segmentOwner(entry, PLAYERS), 'dono').id)
    }
    expect(isComplete(SEGMENTS, session)).toBe(true)

    session = clearTake(session, 's2')
    expect(isComplete(SEGMENTS, session)).toBe(false)
    expect(playableSegments(SEGMENTS, PLAYERS)[nextPendingIndex(SEGMENTS, session)]?.id).toBe('s2')
  })

  it('ignora falas de personagens que ninguém escolheu', () => {
    const withThird = [...SEGMENTS, segment('s5', 'fiona', 9_000)]
    const ordered = playableSegments(withThird, PLAYERS).map((entry) => entry.id)

    // A fala da Fiona fica com o áudio de referência e não entra no rodízio.
    expect(ordered).not.toContain('s5')
    expect(ordered).toHaveLength(4)
  })

  it('conta o progresso de cada jogador separadamente', () => {
    let session = createDuetSession('cena', PLAYERS)
    session = recordTake(session, 's1', 'p1')
    session = recordTake(session, 's2', 'p2')

    const progress = progressByPlayer(SEGMENTS, session)
    expect(progress).toHaveLength(2)
    expect(progress[0]).toMatchObject({ recorded: 1, total: 2 })
    expect(progress[1]).toMatchObject({ recorded: 1, total: 2 })
  })
})

describe('mixagem durante a partida', () => {
  it('toca a tomada do outro, a referência do que falta e silencia a fala da vez', () => {
    let session = createDuetSession('cena', PLAYERS)
    session = recordTake(session, 's1', 'p1')

    const sources = audioSourceMap(SEGMENTS, session, 's2')

    // O jogador da vez ouve o que o outro dublou...
    expect(sources['s1']).toBe('take')
    // ...e não ouve a resposta da própria fala.
    expect(sources['s2']).toBe('silence')
    // O que ainda não foi dublado sustenta a cena com a referência.
    expect(sources['s3']).toBe('reference')
    expect(sources['s4']).toBe('reference')
  })

  it('sem fala corrente, tudo que já foi gravado toca', () => {
    let session = createDuetSession('cena', PLAYERS)
    session = recordTake(session, 's1', 'p1')
    session = recordTake(session, 's2', 'p2')

    const sources = audioSourceMap(SEGMENTS, session, null)
    expect(sources['s1']).toBe('take')
    expect(sources['s2']).toBe('take')
    expect(sources['s3']).toBe('reference')
  })
})
