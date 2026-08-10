'use client'

import type { TranscribeRequest, TranscribeResponse, TranscribedChunk } from '@/workers/transcribe.worker'

export interface TranscribeProgress {
  /** 0..1 do download do modelo. O reconhecimento em si não reporta fração. */
  readonly loadedRatio: number
}

/**
 * O modelo pode levar minutos na primeira vez (download) e o reconhecimento de
 * 5 minutos de vídeo não é instantâneo. O teto existe só para não deixar a
 * pessoa presa numa tela que nunca responde.
 */
const TRANSCRIBE_TIMEOUT_MS = 10 * 60_000

/** Roda o Whisper local sobre o áudio já decodificado. O áudio não sai do aparelho. */
export function transcribeReference(
  samples: Float32Array,
  sampleRate: number,
  onProgress: (progress: TranscribeProgress) => void,
  signal?: AbortSignal,
): Promise<readonly TranscribedChunk[]> {
  return new Promise<readonly TranscribedChunk[]>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException('Transcrição cancelada.', 'AbortError'))
      return
    }

    const worker = new Worker(new URL('../workers/transcribe.worker.ts', import.meta.url), {
      type: 'module',
    })
    const requestId = crypto.randomUUID()

    const timeoutId = setTimeout(() => {
      cleanup()
      reject(new Error('A transcrição demorou mais do que o esperado e foi interrompida.'))
    }, TRANSCRIBE_TIMEOUT_MS)

    const cleanup = () => {
      clearTimeout(timeoutId)
      signal?.removeEventListener('abort', onAbort)
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
      worker.terminate()
    }
    const onAbort = () => {
      cleanup()
      reject(new DOMException('Transcrição cancelada.', 'AbortError'))
    }
    const onMessage = (event: MessageEvent<TranscribeResponse>) => {
      const data = event.data
      if (data.requestId !== requestId) return
      if (data.kind === 'progress') {
        onProgress({ loadedRatio: data.loadedRatio })
        return
      }
      cleanup()
      if (data.ok) resolve(data.chunks)
      else reject(new Error(data.message))
    }
    const onError = (event: ErrorEvent) => {
      cleanup()
      reject(
        new Error('Não conseguimos carregar o reconhecimento de fala neste navegador.', {
          cause: event.error,
        }),
      )
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)

    // A cópia evita entregar o buffer que a página ainda usa na forma de onda.
    const copy = samples.slice()
    const request: TranscribeRequest = { requestId, samples: copy, sampleRate }
    worker.postMessage(request, [copy.buffer])
  })
}
