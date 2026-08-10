/// <reference lib="webworker" />

import { decodeReferenceFeatures, extractFeatures } from '@dubla/dsp'
import { computeScore } from '@dubla/scoring'
import type { DubMode, ScoreResult, SpeakerSegment } from '@dubla/shared'

/**
 * Worker de análise.
 *
 * STFT + YIN + DTW sobre 20 s de áudio levam centenas de milissegundos. No
 * thread principal isso congelaria a interface exatamente no momento em que o
 * usuário está mais ansioso pelo resultado (§61).
 *
 * O worker importa `@dubla/dsp` e `@dubla/scoring` — os mesmos pacotes que
 * rodariam no servidor na Fase 5. Como o motor é determinístico e sem I/O, os
 * dois lados produzem o mesmo número (ARCHITECTURE §2.2).
 */

export interface AnalysisRequest {
  readonly requestId: string
  readonly samples: Float32Array
  readonly sampleRate: number
  readonly referenceFeatures: ArrayBuffer
  readonly segments: readonly SpeakerSegment[]
  readonly mode: DubMode
  readonly recordingOffsetMs: number
  readonly autoGainControlActive: boolean
  readonly sampleContinuityOk: boolean
  /**
   * Trecho da cena a analisar, no modo fala-a-fala.
   *
   * Sem ele, uma gravação de um segmento só seria comparada contra a cena
   * inteira e o DTW alinharia fala contra silêncio.
   */
  readonly window?: { readonly startMs: number; readonly endMs: number }
}

export type AnalysisResponse =
  | { readonly requestId: string; readonly ok: true; readonly result: ScoreResult }
  | { readonly requestId: string; readonly ok: false; readonly message: string }

const scope = self as unknown as DedicatedWorkerGlobalScope

scope.onmessage = (event: MessageEvent<AnalysisRequest>) => {
  const request = event.data

  try {
    const reference = decodeReferenceFeatures(request.referenceFeatures)
    const user = extractFeatures(request.samples, request.sampleRate)

    const result = computeScore({
      mode: request.mode,
      reference,
      user,
      segments: request.segments,
      recordingOffsetMs: request.recordingOffsetMs,
      ...(request.window === undefined ? {} : { window: request.window }),
      flags: {
        autoGainControlActive: request.autoGainControlActive,
        sampleContinuityOk: request.sampleContinuityOk,
      },
    })

    const response: AnalysisResponse = { requestId: request.requestId, ok: true, result }
    scope.postMessage(response)
  } catch (error) {
    const response: AnalysisResponse = {
      requestId: request.requestId,
      ok: false,
      message: error instanceof Error ? error.message : 'falha desconhecida na análise',
    }
    scope.postMessage(response)
  }
}
