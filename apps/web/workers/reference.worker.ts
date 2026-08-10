/// <reference lib="webworker" />

import {
  computeWaveformPeaks,
  encodeReferenceFeatures,
  estimateSpeakerCount,
  extractFeatures,
  frameToMs,
  quantizeFeatureSet,
} from '@dubla/dsp'
import type { SpeakerSegment } from '@dubla/shared'

export interface ReferenceRequest {
  readonly requestId: string
  readonly sceneId: string
  readonly samples: Float32Array
  readonly sampleRate: number
}

/**
 * Estimativa de quantas pessoas falam no vídeo enviado.
 *
 * É ESTIMATIVA: vozes parecidas, música e falas sobrepostas quebram o método.
 * A UI precisa mostrar a confiança e deixar a pessoa corrigir — nunca tratar
 * como fato nem bloquear o upload por causa dela (§12).
 */
export interface SpeakerDetection {
  readonly speakerCount: number
  readonly confidence: number
  readonly reason?: string
}

export type ReferenceResponse =
  | {
      readonly requestId: string
      readonly ok: true
      readonly referenceFeatures: ArrayBuffer
      readonly peaks: Int8Array
      readonly segments: readonly SpeakerSegment[]
      readonly speechRatio: number
      readonly speakers: SpeakerDetection
    }
  | { readonly requestId: string; readonly ok: false; readonly message: string }

const scope = self as unknown as DedicatedWorkerGlobalScope

scope.onmessage = (event: MessageEvent<ReferenceRequest>) => {
  const request = event.data

  try {
    const features = extractFeatures(request.samples, request.sampleRate)
    const peaks = computeWaveformPeaks(request.samples, request.sampleRate, 200)

    // Quantas vozes existem na cena. Alimenta a atribuição de personagem por
    // trecho e decide se o vídeo pode ser jogado em dupla.
    const speakers = estimateSpeakerCount(features)
    const clusterByRegion = new Map(
      speakers.regions.map((region) => [region.startFrame, region.cluster]),
    )

    const segments = features.regions.map((region, index): SpeakerSegment => {
      const cluster = clusterByRegion.get(region.startFrame)
      // Trechos curtos demais para entrar no agrupamento ficam com a primeira
      // voz em vez de virarem um personagem fantasma.
      const voice = cluster ?? 0
      return {
        id: `${request.sceneId}-reference-${String(index + 1)}`,
        sceneId: request.sceneId,
        characterId:
          speakers.speakerCount > 1 ? `voz-${String(voice + 1)}` : 'reference-voice',
        startMs: frameToMs(region.startFrame),
        endMs: frameToMs(region.endFrame),
        text:
          speakers.speakerCount > 1
            ? `Voz ${String(voice + 1)} · trecho ${String(index + 1)}`
            : `Trecho de referência ${String(index + 1)}`,
        orderIndex: index,
      }
    })

    // Uma cena arbitrária não tem o corpus necessário para calibrar
    // articulação. NaN faz essa métrica ficar honestamente indisponível; as
    // demais métricas continuam usando a mesma referência acústica.
    const referenceFeatures = encodeReferenceFeatures(
      quantizeFeatureSet(features),
      { dFloor: Number.NaN, dChance: Number.NaN },
      peaks,
    )

    const response: ReferenceResponse = {
      requestId: request.requestId,
      ok: true,
      referenceFeatures,
      peaks,
      segments,
      speechRatio: features.speechRatio,
      speakers: {
        speakerCount: speakers.speakerCount,
        confidence: speakers.confidence,
        ...(speakers.reason === undefined ? {} : { reason: speakers.reason }),
      },
    }
    scope.postMessage(response, [referenceFeatures, peaks.buffer as ArrayBuffer])
  } catch (cause) {
    const response: ReferenceResponse = {
      requestId: request.requestId,
      ok: false,
      message: cause instanceof Error ? cause.message : 'Falha ao analisar a referência sonora.',
    }
    scope.postMessage(response)
  }
}
