import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * O cliente da partida agora fala com o Supabase.
 *
 * O que sobra de lógica própria aqui é a porta de entrada: recusar um WAV que
 * não deveria sair do aparelho e recusar um código malformado antes de gastar
 * uma ida ao servidor. O resto — turno, vaga, ordem das falas — é conferido
 * pelas funções do banco, e é lá que está testado.
 */
const transporte = vi.hoisted(() => ({
  guardarTomada: vi.fn(),
  abrirPartida: vi.fn(),
  criarPartida: vi.fn(),
  entrarNaPartida: vi.fn(),
  marcarPresenca: vi.fn(),
  sairDaPartida: vi.fn(),
  enviarVideoDaSala: vi.fn(),
  baixarVideoDaSala: vi.fn(),
}))
vi.mock('@/lib/supabase-match', () => transporte)

import { sendTake } from '../online-match-client'

const CODE = 'K7M29XQP4TVB'
const WAV = new Blob([new Uint8Array([82, 73, 70, 70])], { type: 'audio/wav' })

const tomada = (wav: Blob) => ({
  segmentId: 'fala-1',
  playerId: 'jogador-1',
  mediaStartOffsetMs: -700,
  sampleRate: 48_000,
  wav,
})

beforeEach(() => {
  transporte.guardarTomada.mockReset()
  transporte.guardarTomada.mockResolvedValue({ code: CODE })
})

describe('sendTake', () => {
  it('entrega a tomada ao transporte com o trecho e o relógio dela', async () => {
    await sendTake(CODE, tomada(WAV))

    expect(transporte.guardarTomada).toHaveBeenCalledWith({
      codigo: CODE,
      trechoId: 'fala-1',
      jogadorId: 'jogador-1',
      wav: WAV,
      mediaStartOffsetMs: -700,
      sampleRate: 48_000,
    })
  })

  it('aceita o código como a pessoa recebeu, com hífen', async () => {
    await sendTake('K7M2-9XQP-4TVB', tomada(WAV))
    expect(transporte.guardarTomada).toHaveBeenCalledWith(
      expect.objectContaining({ codigo: CODE }),
    )
  })

  it('recusa gravação vazia sem tocar na rede', async () => {
    await expect(
      sendTake(CODE, tomada(new Blob([], { type: 'audio/wav' }))),
    ).rejects.toThrow(/tamanho aceito/i)

    expect(transporte.guardarTomada).not.toHaveBeenCalled()
  })

  it('recusa código malformado antes de gastar uma ida ao servidor', async () => {
    await expect(sendTake('ABC', tomada(WAV))).rejects.toThrow(/código/i)
    expect(transporte.guardarTomada).not.toHaveBeenCalled()
  })
})
