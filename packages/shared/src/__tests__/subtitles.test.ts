import { describe, expect, it } from 'vitest'
import type { SubtitleSegment } from '../domain'
import { findActiveSubtitleIndex, SUBTITLE_LEAD_MS } from '../subtitles'

function segment(id: string, startMs: number, endMs: number): SubtitleSegment {
  return { id, sceneId: 'scene', startMs, endMs, text: id }
}

// Tempos reais da cena "Ponto final", arredondados.
const SUBTITLES: readonly SubtitleSegment[] = [
  segment('a', 900, 2_700),
  segment('b', 3_100, 3_800),
  segment('c', 4_200, 7_000),
]

describe('findActiveSubtitleIndex', () => {
  it('não mostra nada antes da janela de antecipação', () => {
    expect(findActiveSubtitleIndex(SUBTITLES, 0)).toBe(-1)
    expect(findActiveSubtitleIndex(SUBTITLES, 200)).toBe(-1)
  })

  it('mostra a legenda antes da fala começar', () => {
    // O dublador precisa ler antes de falar.
    expect(findActiveSubtitleIndex(SUBTITLES, 900 - SUBTITLE_LEAD_MS + 10)).toBe(0)
    expect(findActiveSubtitleIndex(SUBTITLES, 899)).toBe(0)
  })

  it('acompanha a cena fala a fala', () => {
    expect(findActiveSubtitleIndex(SUBTITLES, 1_500)).toBe(0)
    expect(findActiveSubtitleIndex(SUBTITLES, 2_699)).toBe(0)
    expect(findActiveSubtitleIndex(SUBTITLES, 3_200)).toBe(1)
    expect(findActiveSubtitleIndex(SUBTITLES, 5_000)).toBe(2)
  })

  it('some depois da cauda da última fala', () => {
    expect(findActiveSubtitleIndex(SUBTITLES, 7_500)).toBe(-1)
  })

  it('mantém a fala em andamento quando a próxima já está na antecipação', () => {
    // Em 2650 ms a fala 'a' ainda corre e 'b' (3100) já entrou na antecipação.
    // Trocar aqui apagaria o texto que a pessoa está dizendo naquele instante.
    expect(findActiveSubtitleIndex(SUBTITLES, 2_650)).toBe(0)
  })

  it('passa para a próxima assim que a anterior termina', () => {
    expect(findActiveSubtitleIndex(SUBTITLES, 2_950)).toBe(1)
  })

  it('lida com lista vazia', () => {
    expect(findActiveSubtitleIndex([], 1_000)).toBe(-1)
  })

  it('percorre a cena inteira sem buracos entre falas consecutivas', () => {
    // Varredura de 20 em 20 ms (um quadro de análise): entre o início da
    // antecipação da primeira e o fim da última, sempre há algo na tela.
    for (let ms = 900 - SUBTITLE_LEAD_MS; ms <= 7_000; ms += 20) {
      expect(findActiveSubtitleIndex(SUBTITLES, ms), `em ${String(ms)}ms`).toBeGreaterThanOrEqual(0)
    }
  })
})
