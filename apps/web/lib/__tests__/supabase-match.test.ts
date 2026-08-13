import { describe, expect, it } from 'vitest'
import { mapearEstado } from '../supabase-match'

/**
 * O mapeador é a fronteira entre o banco e o domínio.
 *
 * Tudo que vem de `abrir_partida` é JSON solto: um campo com o nome trocado ou
 * um `null` inesperado viraria uma sala com `undefined` no meio, e o erro só
 * apareceria quando alguém tentasse gravar. Aqui a conversão é conferida
 * campo a campo, e a ausência de tomadas mantém o teste puro — assinar URLs
 * exigiria rede.
 */
const SALA = {
  codigo: 'K7M29XQP4TVB',
  hostId: 'p1',
  videoId: 'video-abc',
  videoName: 'cena.mp4',
  durationMs: 10_000,
  segmentos: [
    { id: 's1', characterId: 'voz-1', startMs: 0, endMs: 2_000, text: 'Oi' },
    { id: 's2', characterId: 'voz-2', startMs: 2_500, endMs: 4_000, text: 'Tudo bem?' },
  ],
  personagens: ['Woody', 'Buzz'],
  videoUrl: null,
  videoPath: null,
  criadaEm: '2026-08-12T10:00:00.000Z',
  atualizadaEm: '2026-08-12T10:05:00.000Z',
  jogadores: [
    { id: 'p1', nome: 'Ana', personagemId: 'voz-1', pronto: true, vistoEm: '2026-08-12T10:05:00.000Z' },
    { id: 'p2', nome: 'Bia', personagemId: 'voz-2', pronto: false, vistoEm: '2026-08-12T10:04:00.000Z' },
  ],
  tomadas: {},
}

describe('mapearEstado', () => {
  it('converte a sala inteira para o formato do domínio', async () => {
    const estado = await mapearEstado(SALA)
    expect(estado).not.toBeNull()
    if (!estado) return

    expect(estado.code).toBe('K7M29XQP4TVB')
    expect(estado.hostId).toBe('p1')
    expect(estado.durationMs).toBe(10_000)
    expect(estado.characterNames).toEqual(['Woody', 'Buzz'])
    expect(estado.segments.map((s) => s.id)).toEqual(['s1', 's2'])
    expect(estado.players.map((j) => j.name)).toEqual(['Ana', 'Bia'])
    expect(estado.players[0]?.ready).toBe(true)
    expect(estado.players[1]?.ready).toBe(false)
  })

  it('converte as datas do banco em milissegundos', async () => {
    const estado = await mapearEstado(SALA)
    expect(estado?.createdAt).toBe(Date.parse('2026-08-12T10:00:00.000Z'))
    expect(estado?.updatedAt).toBe(Date.parse('2026-08-12T10:05:00.000Z'))
  })

  it('sem vídeo guardado, não afirma que a sala tem um', async () => {
    const estado = await mapearEstado(SALA)
    expect(estado?.videoShared).toBeUndefined()
    expect(estado?.videoUrl).toBeUndefined()
  })

  it('com vídeo no bucket, marca a sala como tendo cena', async () => {
    const estado = await mapearEstado({ ...SALA, videoPath: 'K7M2/cena.mp4' })
    expect(estado?.videoShared).toBe(true)
    expect(estado?.videoPathname).toBe('K7M2/cena.mp4')
  })

  it('descarta jogador e trecho sem id em vez de criar um fantasma', async () => {
    const estado = await mapearEstado({
      ...SALA,
      jogadores: [...SALA.jogadores, { nome: 'Sem id', personagemId: 'voz-3' }],
      segmentos: [...SALA.segmentos, { characterId: 'voz-1', startMs: 5_000, endMs: 6_000 }],
    })

    expect(estado?.players).toHaveLength(2)
    expect(estado?.segments).toHaveLength(2)
  })

  it('resposta vazia do banco vira ausência de sala, não sala quebrada', async () => {
    expect(await mapearEstado(null)).toBeNull()
    expect(await mapearEstado({})).toBeNull()
    expect(await mapearEstado({ codigo: '' })).toBeNull()
  })

  it('campo com tipo errado cai no padrão em vez de virar undefined', async () => {
    const estado = await mapearEstado({ ...SALA, durationMs: 'dez mil', videoName: 42 })
    expect(estado?.durationMs).toBe(0)
    expect(estado?.videoName).toBe('cena.mp4')
  })
})
