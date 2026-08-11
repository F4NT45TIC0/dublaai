import { describe, expect, it } from 'vitest'
import type { SpeakerSegment } from '@dubla/shared'
import { planStitchedPlayback, type RemoteStitchedTake } from '../stitched-playback-plan'
import type { RecorderAttempt } from '../use-recorder'

const SEGMENTS: readonly SpeakerSegment[] = [
  {
    id: 's1',
    sceneId: 'scene',
    characterId: 'voz-1',
    startMs: 500,
    endMs: 2_000,
    text: 'Primeira fala',
    orderIndex: 0,
  },
  {
    id: 's2',
    sceneId: 'scene',
    characterId: 'voz-2',
    startMs: 2_500,
    endMs: 4_000,
    text: 'Segunda fala',
    orderIndex: 1,
  },
  {
    id: 's3',
    sceneId: 'scene',
    characterId: 'voz-1',
    startMs: 4_500,
    endMs: 6_000,
    text: 'Terceira fala',
    orderIndex: 2,
  },
]

function attempt(id: string, segmentId: string): RecorderAttempt {
  return {
    id,
    attemptNumber: 1,
    segmentId,
    wavUrl: `blob:${id}`,
    durationMs: 2_000,
    clock: {
      sampleRate: 48_000,
      startFrame: 0,
      videoStartMediaTime: 0,
      mediaStartOffsetMs: -700,
      estimatedInputLatencyMs: 10,
      clockConfidence: 1,
      sampleContinuityOk: true,
    },
    result: null,
  }
}

describe('plano da cena costurada', () => {
  it('deduplica a mesma fala local e remota e usa o fim da última fala pronta', () => {
    const remoteS1: RemoteStitchedTake = {
      segmentId: 's1',
      url: '/api/partidas/ABC/audio/s1',
      mediaStartOffsetMs: -700,
    }
    const plan = planStitchedPlayback(
      [attempt('local-s1', 's1'), attempt('local-s2', 's2')],
      SEGMENTS,
      undefined,
      [remoteS1],
    )

    expect(plan.remoteTakes).toEqual([remoteS1])
    expect(plan.localTakes.map(([segmentId]) => segmentId)).toEqual(['s2'])
    expect([...plan.readySegmentIds]).toEqual(['s1', 's2'])
    expect(plan.lastReadyEndMs).toBe(4_000)
  })

  it('mantém apenas a versão remota mais recente e deixa a voz original prevalecer', () => {
    const plan = planStitchedPlayback(
      [attempt('local-s1', 's1'), attempt('local-s2', 's2')],
      SEGMENTS,
      { s1: 'original' },
      [
        { segmentId: 's2', url: '/audio/antigo', mediaStartOffsetMs: -700 },
        { segmentId: 's2', url: '/audio/aceito', mediaStartOffsetMs: -650 },
        { segmentId: 's1', url: '/audio/ignorado', mediaStartOffsetMs: -700 },
      ],
    )

    expect(plan.remoteTakes).toEqual([
      { segmentId: 's2', url: '/audio/aceito', mediaStartOffsetMs: -650 },
    ])
    expect(plan.localTakes).toEqual([])
    expect([...plan.originalSegmentIds]).toEqual(['s1'])
    expect(plan.readySegmentIds.size).toBe(2)
  })
})
