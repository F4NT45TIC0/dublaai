import { describe, expect, it } from 'vitest'
import type { SpeakerSegment } from '@dubla/shared'
import { stitchTakes } from '../stitch-takes'
import {
  isSceneCovered,
  ORIGINAL_PAD_MS,
  originalTakesFor,
  pendingRecordSegments,
  type SegmentSource,
} from '../segment-sources'

function segment(index: number, startMs: number, endMs: number): SpeakerSegment {
  return {
    id: `seg-${String(index)}`,
    sceneId: 'cena',
    characterId: 'reference-voice',
    startMs,
    endMs,
    text: `Trecho ${String(index)}`,
    orderIndex: index - 1,
  }
}

const SAMPLE_RATE = 16_000

/** Áudio original sintético: uma constante 1 por toda a duração. */
function originalAudio(durationMs: number) {
  return {
    samples: new Float32Array(Math.round((durationMs / 1000) * SAMPLE_RATE)).fill(1),
    sampleRate: SAMPLE_RATE,
  }
}

describe('originalTakesFor', () => {
  it('gera tomada só para os trechos marcados como original', () => {
    const segments = [segment(1, 0, 1_000), segment(2, 2_000, 3_000)]
    const sources: Record<string, SegmentSource> = { 'seg-2': 'original' }

    const takes = originalTakesFor(segments, sources, originalAudio(4_000), 4_000)

    expect(takes).toHaveLength(1)
    expect(takes[0]?.windowStartMs).toBe(2_000 - ORIGINAL_PAD_MS)
    expect(takes[0]?.windowEndMs).toBe(3_000 + ORIGINAL_PAD_MS)
  })

  it('usa offset zero — o áudio original nasce junto com o vídeo', () => {
    const segments = [segment(1, 500, 1_500)]
    const takes = originalTakesFor(segments, { 'seg-1': 'original' }, originalAudio(3_000), 3_000)

    expect(takes[0]?.mediaStartOffsetMs).toBe(0)
  })

  it('não deixa a folga escapar dos limites da cena', () => {
    const segments = [segment(1, 0, 2_000)]
    const takes = originalTakesFor(segments, { 'seg-1': 'original' }, originalAudio(2_000), 2_000)

    expect(takes[0]?.windowStartMs).toBe(0)
    expect(takes[0]?.windowEndMs).toBe(2_000)
  })

  it('a costura coloca a voz original no lugar certo da timeline', () => {
    const segments = [segment(1, 1_000, 2_000)]
    const takes = originalTakesFor(segments, { 'seg-1': 'original' }, originalAudio(3_000), 3_000)

    const { samples, placed } = stitchTakes(takes, 3_000, SAMPLE_RATE)

    expect(placed).toBe(1)
    // Meio do trecho: som presente. Fora dele: silêncio.
    expect(Math.abs(samples[Math.round(1.5 * SAMPLE_RATE)] ?? 0)).toBeGreaterThan(0.9)
    expect(samples[Math.round(0.5 * SAMPLE_RATE)] ?? 0).toBe(0)
    expect(samples[Math.round(2.5 * SAMPLE_RATE)] ?? 0).toBe(0)
  })
})

describe('pendingRecordSegments', () => {
  it('ignora quem está com a voz original', () => {
    const segments = [segment(1, 0, 1_000), segment(2, 2_000, 3_000), segment(3, 4_000, 5_000)]
    const pending = pendingRecordSegments(segments, { 'seg-2': 'original' }, { 'seg-1': {} })

    expect(pending.map((s) => s.id)).toEqual(['seg-3'])
  })

  it('a cena fecha misturando gravação e voz original', () => {
    const segments = [segment(1, 0, 1_000), segment(2, 2_000, 3_000)]

    expect(isSceneCovered(segments, { 'seg-2': 'original' }, { 'seg-1': {} })).toBe(true)
    expect(isSceneCovered(segments, {}, { 'seg-1': {} })).toBe(false)
  })

  it('cena sem trechos não conta como completa', () => {
    expect(isSceneCovered([], {}, {})).toBe(false)
  })
})
