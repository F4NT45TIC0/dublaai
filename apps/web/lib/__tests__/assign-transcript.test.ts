import { describe, expect, it } from 'vitest'
import type { SpeakerSegment } from '@dubla/shared'
import { assignTranscript, untranscribedCount } from '../assign-transcript'

function segment(index: number, startMs: number, endMs: number): SpeakerSegment {
  return {
    id: `seg-${String(index)}`,
    sceneId: 'cena',
    characterId: 'reference-voice',
    startMs,
    endMs,
    text: `Trecho de referência ${String(index)}`,
    orderIndex: index - 1,
  }
}

describe('assignTranscript', () => {
  it('coloca cada frase no trecho em que ela realmente acontece', () => {
    const segments = [segment(1, 0, 2_000), segment(2, 3_000, 5_000)]
    const result = assignTranscript(segments, [
      { startMs: 100, endMs: 1_900, text: 'Bom dia' },
      { startMs: 3_100, endMs: 4_800, text: 'Você chegou tarde' },
    ])

    expect(result[0]?.text).toBe('Bom dia')
    expect(result[1]?.text).toBe('Você chegou tarde')
  })

  it('junta na ordem do tempo quando o VAD agrupou duas frases', () => {
    const segments = [segment(1, 0, 6_000)]
    const result = assignTranscript(segments, [
      { startMs: 3_000, endMs: 5_000, text: 'e depois saiu' },
      { startMs: 200, endMs: 2_000, text: 'Ele entrou' },
    ])

    expect(result[0]?.text).toBe('Ele entrou e depois saiu')
  })

  it('não repete a mesma frase em dois trechos vizinhos', () => {
    // A frase mora quase toda no primeiro trecho e só encosta no segundo.
    const segments = [segment(1, 0, 2_000), segment(2, 2_000, 4_000)]
    const result = assignTranscript(segments, [{ startMs: 300, endMs: 2_200, text: 'Uma frase só' }])

    expect(result[0]?.text).toBe('Uma frase só')
    expect(result[1]?.text).toBe('Trecho de referência 2')
  })

  it('mantém o rótulo genérico quando nada foi entendido ali', () => {
    const segments = [segment(1, 0, 2_000), segment(2, 8_000, 9_000)]
    const result = assignTranscript(segments, [{ startMs: 100, endMs: 1_800, text: 'Só a primeira' }])

    expect(result[1]?.text).toBe('Trecho de referência 2')
    expect(untranscribedCount(segments, result)).toBe(1)
  })

  it('devolve os trechos intactos quando a transcrição vem vazia', () => {
    const segments = [segment(1, 0, 2_000)]
    expect(assignTranscript(segments, [])).toBe(segments)
  })
})
