'use client'

import { useEffect, useState } from 'react'
import { decodeReferenceFeatures, type ReferenceFeatures } from '@dubla/dsp'

export type ReferenceFeaturesState =
  | { status: 'loading' }
  | { status: 'ready'; features: ReferenceFeatures }
  | { status: 'error'; message: string }

/**
 * Carrega `reference.features.bin`.
 *
 * São ~35 KB por cena — contra megabytes do áudio de referência, que NÃO é
 * baixado no modo de dublagem (§14/§61). O parser valida o cabeçalho antes de
 * alocar qualquer buffer (docs/SECURITY.md §2).
 */
export function useReferenceFeatures(url: string): ReferenceFeaturesState {
  const [state, setState] = useState<ReferenceFeaturesState>({ status: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })

    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal })
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
        const buffer = await response.arrayBuffer()
        setState({ status: 'ready', features: decodeReferenceFeatures(buffer) })
      } catch (error) {
        if (controller.signal.aborted) return
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'falha desconhecida',
        })
      }
    })()

    // §67 — aborta a requisição pendente ao desmontar.
    return () => {
      controller.abort()
    }
  }, [url])

  return state
}
