'use client'

import type { SpeakerSegment } from '@dubla/shared'
import type { ReferenceRequest, ReferenceResponse, SpeakerDetection } from '@/workers/reference.worker'

export interface PreparedVideoReference {
  readonly status: 'ready'
  readonly referenceFeatures: ArrayBuffer
  readonly peaks: Int8Array
  readonly segments: readonly SpeakerSegment[]
  readonly speechRatio: number
  /** Estimativa de quantas pessoas falam. Corrigível pela pessoa, nunca fato. */
  readonly speakers: SpeakerDetection
}

export interface UnavailableVideoReference {
  readonly status: 'unavailable'
  readonly reason: string
}

export type VideoReference = PreparedVideoReference | UnavailableVideoReference

const REFERENCE_TIMEOUT_MS = 30_000

/** Decodifica o áudio do contêiner e deixa todo DSP pesado para o worker. */
export async function prepareVideoReference(
  video: Blob,
  sceneId: string,
  durationMs: number,
  signal?: AbortSignal,
): Promise<VideoReference> {
  try {
    throwIfAborted(signal)
    const encoded = await withAbort(video.arrayBuffer(), signal)
    throwIfAborted(signal)

    // OfflineAudioContext decodifica sem abrir dispositivo e sem depender da
    // política de autoplay. Um frame basta; só usamos decodeAudioData.
    const decoder = new OfflineAudioContext(1, 1, 44_100)
    const audio = await withAbort(decoder.decodeAudioData(encoded), signal)
    throwIfAborted(signal)

    const targetFrames = Math.max(1, Math.round((durationMs / 1_000) * audio.sampleRate))
    const samples = new Float32Array(targetFrames)
    const copyFrames = Math.min(targetFrames, audio.length)

    for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
      const source = audio.getChannelData(channel)
      const scale = 1 / audio.numberOfChannels
      for (let frame = 0; frame < copyFrames; frame += 1) {
        samples[frame] = (samples[frame] ?? 0) + (source[frame] ?? 0) * scale
      }
    }

    const reference = await analyzeReference(samples, audio.sampleRate, sceneId, signal)
    if (reference.segments.length === 0) {
      return {
        status: 'unavailable',
        reason:
          'Não detectamos fala no áudio original. O vídeo ainda pode ser dublado, mas ficará sem forma de onda e pontuação.',
      }
    }
    return reference
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    return {
      status: 'unavailable',
      reason:
        'Não conseguimos extrair uma faixa de áudio compatível. O vídeo ainda pode ser dublado, mas ficará sem forma de onda e pontuação.',
    }
  }
}

function analyzeReference(
  samples: Float32Array,
  sampleRate: number,
  sceneId: string,
  signal?: AbortSignal,
): Promise<PreparedVideoReference> {
  throwIfAborted(signal)
  return new Promise<PreparedVideoReference>((resolve, reject) => {
    const worker = new Worker(new URL('../workers/reference.worker.ts', import.meta.url), {
      type: 'module',
    })
    const requestId = crypto.randomUUID()
    const timeoutId = setTimeout(() => {
      cleanup()
      reject(new Error('A análise da referência demorou mais do que o esperado.'))
    }, REFERENCE_TIMEOUT_MS)

    const cleanup = () => {
      clearTimeout(timeoutId)
      signal?.removeEventListener('abort', onAbort)
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
      worker.removeEventListener('messageerror', onMessageError)
      worker.terminate()
    }
    const onAbort = () => {
      cleanup()
      reject(new DOMException('Análise cancelada.', 'AbortError'))
    }
    const onMessage = (event: MessageEvent<ReferenceResponse>) => {
      if (event.data.requestId !== requestId) return
      cleanup()
      if (!event.data.ok) {
        reject(new Error(event.data.message))
        return
      }
      resolve({
        status: 'ready',
        referenceFeatures: event.data.referenceFeatures,
        peaks: event.data.peaks,
        segments: event.data.segments,
        speechRatio: event.data.speechRatio,
        speakers: event.data.speakers,
      })
    }
    const onError = (event: ErrorEvent) => {
      cleanup()
      reject(new Error('Não conseguimos executar a análise da referência.', { cause: event.error }))
    }
    const onMessageError = () => {
      cleanup()
      reject(new Error('A resposta da análise da referência ficou inválida.'))
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    worker.addEventListener('messageerror', onMessageError)

    const request: ReferenceRequest = { requestId, sceneId, samples, sampleRate }
    worker.postMessage(request, [samples.buffer])
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new DOMException('Análise cancelada.', 'AbortError')
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  throwIfAborted(signal)

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new DOMException('Análise cancelada.', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (cause: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(cause instanceof Error ? cause : new Error('Falha ao preparar o vídeo.'))
      },
    )
  })
}
