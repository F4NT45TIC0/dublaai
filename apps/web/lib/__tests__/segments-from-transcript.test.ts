import { describe, expect, it } from 'vitest'
import { assignVoice, segmentsFromTranscript } from '../segments-from-transcript'

const cena = 'cena'

describe('segmentsFromTranscript', () => {
  it('junta frases coladas numa fala só', () => {
    // O caso que motivou a mudança: o VAD quebrava isto em dois pedaços de
    // frase, e dublar "você é um" separado de "brinquedo" é impossível.
    const segments = segmentsFromTranscript(
      [
        { startMs: 1_000, endMs: 2_000, text: 'Você é um' },
        { startMs: 2_200, endMs: 3_000, text: 'brinquedo' },
      ],
      cena,
      10_000,
    )

    expect(segments).toHaveLength(1)
    expect(segments[0]?.text).toBe('Você é um brinquedo')
    expect(segments[0]?.startMs).toBe(1_000)
    expect(segments[0]?.endMs).toBe(3_000)
  })

  it('mantém separado o que tem pausa de verdade', () => {
    const segments = segmentsFromTranscript(
      [
        { startMs: 0, endMs: 1_500, text: 'Bom dia' },
        { startMs: 3_000, endMs: 4_500, text: 'Você chegou tarde' },
      ],
      cena,
      10_000,
    )

    expect(segments).toHaveLength(2)
    expect(segments.map((s) => s.text)).toEqual(['Bom dia', 'Você chegou tarde'])
  })

  it('não deixa uma fala crescer sem fim', () => {
    // Uma sequência longa de frases coladas viraria um bloco impossível de
    // dublar de uma vez; o teto quebra em falas gerenciáveis.
    const chunks = Array.from({ length: 20 }, (_, index) => ({
      startMs: index * 1_000,
      endMs: index * 1_000 + 900,
      text: `frase ${String(index)}`,
    }))
    const segments = segmentsFromTranscript(chunks, cena, 30_000)

    expect(segments.length).toBeGreaterThan(1)
    for (const segment of segments) {
      expect(segment.endMs - segment.startMs).toBeLessThanOrEqual(12_000)
    }
  })

  it('descarta o que é curto demais para ser fala', () => {
    const segments = segmentsFromTranscript(
      [
        { startMs: 0, endMs: 80, text: 'ah' },
        { startMs: 2_000, endMs: 4_000, text: 'Uma fala de verdade' },
      ],
      cena,
      10_000,
    )

    expect(segments).toHaveLength(1)
    expect(segments[0]?.text).toBe('Uma fala de verdade')
  })

  it('ordena e numera pela linha do tempo, não pela ordem de chegada', () => {
    const segments = segmentsFromTranscript(
      [
        { startMs: 5_000, endMs: 6_000, text: 'segunda' },
        { startMs: 1_000, endMs: 2_000, text: 'primeira' },
      ],
      cena,
      10_000,
    )

    expect(segments.map((s) => s.text)).toEqual(['primeira', 'segunda'])
    expect(segments.map((s) => s.orderIndex)).toEqual([0, 1])
  })

  it('não passa da duração da cena', () => {
    const segments = segmentsFromTranscript(
      [{ startMs: 4_000, endMs: 9_000, text: 'estourando' }],
      cena,
      5_000,
    )

    expect(segments[0]?.endMs).toBe(5_000)
  })

  it('transcrição vazia não inventa fala nenhuma', () => {
    expect(segmentsFromTranscript([], cena, 10_000)).toHaveLength(0)
    expect(segmentsFromTranscript([{ startMs: 0, endMs: 900, text: '   ' }], cena, 10_000)).toHaveLength(0)
  })
})

describe('assignVoice', () => {
  const base = segmentsFromTranscript(
    [
      { startMs: 0, endMs: 1_500, text: 'a' },
      { startMs: 3_000, endMs: 4_500, text: 'b' },
    ],
    cena,
    10_000,
  )

  it('cicla entre as vozes disponíveis', () => {
    const primeiro = base[0]?.id ?? ''
    const doisVozes = assignVoice(base, primeiro, 2)
    expect(doisVozes[0]?.characterId).toBe('voz-2')

    const voltou = assignVoice(doisVozes, primeiro, 2)
    expect(voltou[0]?.characterId).toBe('voz-1')
  })

  it('mexe só na fala pedida', () => {
    const resultado = assignVoice(base, base[0]?.id ?? '', 2)
    expect(resultado[1]?.characterId).toBe('voz-1')
  })

  it('com uma voz só, não há para onde ciclar', () => {
    const resultado = assignVoice(base, base[0]?.id ?? '', 1)
    expect(resultado[0]?.characterId).toBe('voz-1')
  })
})
