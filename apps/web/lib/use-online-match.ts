'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { normalizeMatchCode } from '@/lib/match-code'
import {
  createMatch,
  fetchMatch,
  joinMatchRemote,
  localPlayerId,
  MATCH_POLL_MS,
  sendTake,
} from '@/lib/online-match-client'
import {
  currentPlayer,
  currentSegment,
  isMatchComplete,
  isPlayerTurn,
  type MatchSegment,
  type MatchState,
} from '@/lib/online-match'

export interface OnlineMatchScene {
  readonly videoId: string
  readonly videoName: string
  readonly durationMs: number
  readonly segments: readonly MatchSegment[]
}

export interface OnlineMatch {
  readonly state: MatchState | null
  readonly playerId: string
  readonly busy: boolean
  readonly error: string | null
  /** Trecho que está na vez, seja de quem for. */
  readonly activeSegment: MatchSegment | null
  readonly myTurn: boolean
  readonly complete: boolean
  readonly waitingFor: string | null
  create: () => Promise<string | null>
  /** Carrega uma partida pelo código, sem ainda ocupar personagem. */
  peek: (code: string) => Promise<boolean>
  join: (code: string, name: string, characterId: string) => Promise<boolean>
  submit: (segmentId: string, wav: Blob, mediaStartOffsetMs: number, sampleRate: number) => Promise<boolean>
  leave: () => void
  clearError: () => void
}

/**
 * Partida online, do ponto de vista deste aparelho.
 *
 * O estado verdadeiro mora no servidor; aqui só existe uma cópia atualizada por
 * consulta periódica. Toda regra de turno é reconferida lá (§78) — o que esta
 * camada decide é apenas o que mostrar, nunca o que vale.
 */
export function useOnlineMatch(scene: OnlineMatchScene): OnlineMatch {
  const [state, setState] = useState<MatchState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [playerId, setPlayerId] = useState('')

  useEffect(() => {
    setPlayerId(localPlayerId())
  }, [])

  const code = state?.code ?? null
  const complete = state ? isMatchComplete(state) : false

  // Enquanto a cena não fecha, o aparelho parado precisa saber quando chega a
  // vez dele. Depois de completa, continuar consultando seria só gasto.
  const stateRef = useRef<MatchState | null>(null)
  stateRef.current = state
  useEffect(() => {
    if (!code || complete) return
    const controller = new AbortController()

    // Laço aberto com saída explícita: a conferência de cancelamento vem
    // DEPOIS da espera, que é justamente onde o efeito costuma ser desmontado.
    // Testar antes, no cabeçalho do laço, faria o compilador considerar a
    // conferência de baixo redundante — e ela não é.
    const tick = async () => {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, MATCH_POLL_MS))
        if (controller.signal.aborted) return
        try {
          const fresh = await fetchMatch(code, controller.signal)
          // Só reescreve quando algo mudou: assim a árvore não re-renderiza a
          // cada dois segundos enquanto ninguém joga.
          if (fresh.updatedAt !== stateRef.current?.updatedAt) setState(fresh)
        } catch {
          // Queda de rede momentânea não derruba a partida — a próxima volta
          // resolve. Cancelamento cai aqui também e sai no teste do topo.
        }
      }
    }
    void tick()

    return () => {
      controller.abort()
    }
  }, [code, complete])

  const create = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await createMatch(scene)
      setState(result.state)
      return result.code
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não conseguimos criar a partida.')
      return null
    } finally {
      setBusy(false)
    }
  }, [scene])

  const peek = useCallback(async (rawCode: string) => {
    const normalized = normalizeMatchCode(rawCode)
    if (!normalized) {
      setError('Esse código não está completo. Confira os 12 caracteres.')
      return false
    }
    setBusy(true)
    setError(null)
    try {
      setState(await fetchMatch(normalized))
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não encontramos essa partida.')
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  const join = useCallback(
    async (rawCode: string, name: string, characterId: string) => {
      const normalized = normalizeMatchCode(rawCode)
      if (!normalized) {
        setError('Esse código não está completo. Confira os 12 caracteres.')
        return false
      }
      setBusy(true)
      setError(null)
      try {
        const fresh = await joinMatchRemote(normalized, {
          playerId,
          name,
          characterId,
          videoId: scene.videoId,
        })
        setState(fresh)
        return true
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Não conseguimos entrar na partida.')
        return false
      } finally {
        setBusy(false)
      }
    },
    [playerId, scene.videoId],
  )

  const submit = useCallback(
    async (segmentId: string, wav: Blob, mediaStartOffsetMs: number, sampleRate: number) => {
      if (!code) return false
      setBusy(true)
      setError(null)
      try {
        const fresh = await sendTake(code, {
          segmentId,
          playerId,
          mediaStartOffsetMs,
          sampleRate,
          wav,
        })
        setState(fresh)
        return true
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Não conseguimos enviar sua fala.')
        return false
      } finally {
        setBusy(false)
      }
    },
    [code, playerId],
  )

  const leave = useCallback(() => {
    setState(null)
    setError(null)
  }, [])

  const clearError = useCallback(() => {
    setError(null)
  }, [])

  const activeSegment = state ? currentSegment(state) : null
  const waiting = state ? currentPlayer(state) : null

  return {
    state,
    playerId,
    busy,
    error,
    activeSegment,
    myTurn: state ? isPlayerTurn(state, playerId) : false,
    complete,
    waitingFor: waiting && waiting.id !== playerId ? waiting.name : null,
    create,
    peek,
    join,
    submit,
    leave,
    clearError,
  }
}
