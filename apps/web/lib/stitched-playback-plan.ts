import type { SpeakerSegment } from '@dubla/shared'
import type { SegmentSource } from './segment-sources'
import { bestTakePerSegment } from './take-modes'
import type { RecorderAttempt } from './use-recorder'

export interface RemoteStitchedTake {
  readonly segmentId: string
  readonly url: string
  readonly mediaStartOffsetMs: number
}

export interface StitchedPlaybackPlan {
  /** Tomadas locais que não foram substituídas por uma versão remota. */
  readonly localTakes: readonly (readonly [string, RecorderAttempt])[]
  /** Uma única tomada remota por fala. */
  readonly remoteTakes: readonly RemoteStitchedTake[]
  readonly originalSegmentIds: ReadonlySet<string>
  readonly readySegmentIds: ReadonlySet<string>
  readonly lastReadyEndMs: number
  readonly signature: string
}

/**
 * Decide qual fonte entra em cada fala antes de decodificar qualquer WAV.
 *
 * Uma tomada enviada para a partida também continua no histórico local. Sem
 * deduplicar aqui, a mesma voz seria contada duas vezes e somada duas vezes na
 * costura. A versão remota é a canônica porque foi a aceita pelo servidor; a
 * voz original, quando escolhida, tem precedência sobre ambas.
 */
export function planStitchedPlayback(
  attempts: readonly RecorderAttempt[],
  segments: readonly SpeakerSegment[],
  sources?: Readonly<Record<string, SegmentSource | undefined>>,
  remoteTakes?: readonly RemoteStitchedTake[],
): StitchedPlaybackPlan {
  const knownSegmentIds = new Set(segments.map((segment) => segment.id))
  const originalSegmentIds = new Set(
    segments.filter((segment) => sources?.[segment.id] === 'original').map((segment) => segment.id),
  )

  const remoteBySegment = new Map<string, RemoteStitchedTake>()
  for (const take of remoteTakes ?? []) {
    if (!knownSegmentIds.has(take.segmentId) || originalSegmentIds.has(take.segmentId)) continue
    remoteBySegment.set(take.segmentId, take)
  }

  const localTakes: [string, RecorderAttempt][] = []
  for (const [segmentId, attempt] of bestTakePerSegment(attempts)) {
    if (
      !knownSegmentIds.has(segmentId) ||
      originalSegmentIds.has(segmentId) ||
      remoteBySegment.has(segmentId)
    ) {
      continue
    }
    localTakes.push([segmentId, attempt])
  }

  const readySegmentIds = new Set(originalSegmentIds)
  for (const segmentId of remoteBySegment.keys()) readySegmentIds.add(segmentId)
  for (const [segmentId] of localTakes) readySegmentIds.add(segmentId)

  let lastReadyEndMs = 0
  const signatureParts: string[] = []
  const localBySegment = new Map(localTakes)
  for (const segment of segments) {
    if (!readySegmentIds.has(segment.id)) continue
    lastReadyEndMs = Math.max(lastReadyEndMs, segment.endMs)

    if (originalSegmentIds.has(segment.id)) {
      signatureParts.push(`orig:${segment.id}`)
      continue
    }
    const remote = remoteBySegment.get(segment.id)
    if (remote) {
      signatureParts.push(`rem:${segment.id}:${remote.url}:${String(remote.mediaStartOffsetMs)}`)
      continue
    }
    const local = localBySegment.get(segment.id)
    if (local) signatureParts.push(`loc:${segment.id}:${local.id}`)
  }

  return {
    localTakes,
    remoteTakes: [...remoteBySegment.values()],
    originalSegmentIds,
    readySegmentIds,
    lastReadyEndMs,
    signature: signatureParts.join('|'),
  }
}
