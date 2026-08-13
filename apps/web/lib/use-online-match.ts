'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { normalizeMatchCode } from '@/lib/match-code'
import {
  createMatch,
  fetchMatch,
  joinMatchRemote,
  leaveMatchRemote,
  localPlayerId,
  markPlayerReadyRemote,
  MATCH_POLL_MS,
  pullMatchVideo,
  reclaimDisconnectedPlayerRemote,
  sendTake,
  shareMatchVideo,
  type MatchUploadAccess,
} from '@/lib/online-match-client'
import { downloadRemoteVideo } from '@/lib/remote-video'
import {
  currentPlayer,
  currentSegment,
  isMatchComplete,
  isMatchReady,
  isPlayerTurn,
  type MatchSegment,
  type MatchState,
} from '@/lib/online-match'

export interface OnlineMatchScene {
  readonly videoId: string
  readonly videoName: string
  readonly durationMs: number
  readonly segments: readonly MatchSegment[]
  readonly characterNames?: readonly string[]
  /** Presente quando a cena foi aberta por link. */
  readonly videoUrl?: string
}

export interface OnlineMatch {
  readonly state: MatchState | null
  readonly playerId: string
  readonly busy: boolean
  readonly uploadProgress: number | null
  readonly error: string | null
  /** Trecho que está na vez, seja de quem for. */
  readonly activeSegment: MatchSegment | null
  readonly myTurn: boolean
  readonly complete: boolean
  /** Os dois jogadores estão na sala e prontos. Antes disso não há rodízio. */
  readonly duplaCompleta: boolean
  readonly waitingFor: string | null
  create: (scene: OnlineMatchScene, video?: Blob) => Promise<string | null>
  /** Repete o envio caso a sala tenha sido criada, mas a rede tenha falhado. */
  shareVideo: (video: Blob, fileName: string) => Promise<boolean>
  /** Traz a cena da partida — do link de origem ou do arquivo guardado. */
  pullVideo: (from?: MatchState) => Promise<File | null>
  /** Carrega uma partida pelo código, sem ainda ocupar personagem. */
  peek: (code: string) => Promise<MatchState | null>
  join: (code: string, name: string, characterId: string, videoId: string) => Promise<boolean>
  ready: () => Promise<boolean>
  submit: (
    segmentId: string,
    wav: Blob,
    mediaStartOffsetMs: number,
    sampleRate: number,
  ) => Promise<boolean>
  leave: () => Promise<boolean>
  reclaim: (playerId: string) => Promise<boolean>
  clearError: () => void
}

/**
 * Partida online, do ponto de vista deste aparelho.
 *
 * O estado verdadeiro mora no servidor; aqui só existe uma cópia atualizada por
 * consulta periódica. Toda regra de turno é reconferida lá (§78) — o que esta
 * camada decide é apenas o que mostrar, nunca o que vale.
 */
const CURRENT_MATCH_KEY = 'dublaai:partida-atual'
const CURRENT_UPLOAD_ACCESS_KEY = 'dublaai:partida-upload'

export function useOnlineMatch(enabled = true): OnlineMatch {
  const [state, setState] = useState<MatchState | null>(null)
  const [busy, setBusy] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [playerId, setPlayerId] = useState('')
  const [uploadAccess, setUploadAccess] = useState<MatchUploadAccess | null>(null)

  useEffect(() => {
    if (!enabled) return
    const id = localPlayerId()
    setPlayerId(id)

    // Código e identidade sobrevivem ao refresh. O vídeo é baixado de novo
    // pela tela, mas a vaga, o turno e as tomadas continuam sendo os mesmos.
    const saved = localStorage.getItem(CURRENT_MATCH_KEY)
    if (!saved) return
    try {
      const upload = JSON.parse(localStorage.getItem(CURRENT_UPLOAD_ACCESS_KEY) ?? 'null') as {
        code?: unknown
        access?: unknown
      } | null
      if (upload?.code === saved && (upload.access === 'private' || upload.access === 'public')) {
        setUploadAccess(upload.access)
      }
    } catch {
      localStorage.removeItem(CURRENT_UPLOAD_ACCESS_KEY)
    }
    const restore = async () => {
      try {
        // Um refresh perde o Blob e a análise locais. A mesma leitura marca o
        // aparelho como "preparando" de forma atômica, antes de liberar turno.
        setState(await fetchMatch(saved, undefined, id, true))
      } catch {
        localStorage.removeItem(CURRENT_MATCH_KEY)
      }
    }
    void restore()
  }, [enabled])

  const code = state?.code ?? null
  const complete = state ? isMatchComplete(state) : false

  // Enquanto a cena não fecha, o aparelho parado precisa saber quando chega a
  // vez dele. Depois de completa, continuar consultando seria só gasto.
  const stateRef = useRef<MatchState | null>(null)
  stateRef.current = state
  useEffect(() => {
    if (!enabled || !code || complete) return
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
          const fresh = await fetchMatch(code, controller.signal, playerId)
          // Presença também depende do relógio. Re-renderizar a cada heartbeat
          // faz a outra ponta pausar assim que alguém fecha a página.
          setState(fresh)
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
  }, [code, complete, enabled, playerId])

  const remember = useCallback((next: MatchState) => {
    setState(next)
    localStorage.setItem(CURRENT_MATCH_KEY, next.code)
  }, [])

  const shareVideo = useCallback(
    async (video: Blob, fileName: string) => {
      const atual = stateRef.current
      if (!atual || playerId === '') return false
      setBusy(true)
      setUploadProgress(0)
      setError(null)
      try {
        const fresh = await shareMatchVideo(
          atual.code,
          playerId,
          video,
          fileName,
          uploadAccess,
          setUploadProgress,
        )
        remember(fresh)
        return true
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : 'Não conseguimos enviar o vídeo da partida. Tente novamente.',
        )
        return false
      } finally {
        setBusy(false)
        setUploadProgress(null)
      }
    },
    [playerId, remember, uploadAccess],
  )

  const create = useCallback(
    async (scene: OnlineMatchScene, video?: Blob) => {
      if (playerId === '') {
        setError('Preparando seu aparelho. Tente criar a partida novamente em um instante.')
        return null
      }
      setBusy(true)
      setError(null)
      try {
        const result = await createMatch({ ...scene, hostId: playerId })
        remember(result.state)
        setUploadAccess(result.uploadAccess)
        if (result.uploadAccess) {
          localStorage.setItem(
            CURRENT_UPLOAD_ACCESS_KEY,
            JSON.stringify({ code: result.code, access: result.uploadAccess }),
          )
        } else {
          localStorage.removeItem(CURRENT_UPLOAD_ACCESS_KEY)
        }

        // Com link, os dois baixam da origem. Com arquivo, a sala só fica pronta
        // depois que o Blob confirma o envio inteiro.
        if (video && !scene.videoUrl) {
          try {
            setUploadProgress(0)
            remember(
              await shareMatchVideo(
                result.state.code,
                playerId,
                video,
                scene.videoName,
                result.uploadAccess,
                setUploadProgress,
              ),
            )
          } catch (cause) {
            setError(
              cause instanceof Error
                ? `${cause.message} O código foi criado; tente enviar o vídeo novamente.`
                : 'Não conseguimos enviar o vídeo. O código foi criado; tente novamente.',
            )
          }
        }
        return result.code
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Não conseguimos criar a partida.')
        return null
      } finally {
        setBusy(false)
        setUploadProgress(null)
      }
    },
    [playerId, remember],
  )

  const pullVideo = useCallback(async (from?: MatchState) => {
    const atual = from ?? stateRef.current
    if (!atual) return null
    setBusy(true)
    setError(null)
    try {
      // O link vem primeiro: baixar da fonte não passa pelo nosso servidor nem
      // cria uma segunda cópia no Blob da partida.
      if (atual.videoUrl !== undefined) {
        return await downloadRemoteVideo(atual.videoUrl)
      }
      if (!atual.videoShared) return null
      return await pullMatchVideo(atual.code, atual.videoName)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Não conseguimos baixar o vídeo da partida.',
      )
      return null
    } finally {
      setBusy(false)
    }
  }, [])

  const peek = useCallback(
    async (rawCode: string) => {
      const normalized = normalizeMatchCode(rawCode)
      if (!normalized) {
        setError('Esse código não está completo. Confira os 12 caracteres.')
        return null
      }
      setBusy(true)
      setError(null)
      try {
        const fresh = await fetchMatch(normalized)
        remember(fresh)
        return fresh
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Não encontramos essa partida.')
        return null
      } finally {
        setBusy(false)
      }
    },
    [remember],
  )

  const join = useCallback(
    async (rawCode: string, name: string, characterId: string, videoId: string) => {
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
          videoId,
        })
        remember(fresh)
        // Entrar ocupa a vaga; ficar pronto é outra mutação deliberada. Assim
        // o servidor nunca libera a gravação entre o join e o fim do preparo.
        remember(await markPlayerReadyRemote(normalized, playerId))
        return true
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Não conseguimos entrar na partida.')
        return false
      } finally {
        setBusy(false)
      }
    },
    [playerId, remember],
  )

  const ready = useCallback(async () => {
    const atual = stateRef.current
    if (!atual || playerId === '') return false
    setBusy(true)
    setError(null)
    try {
      remember(await markPlayerReadyRemote(atual.code, playerId))
      return true
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Não conseguimos confirmar que você está pronto.',
      )
      return false
    } finally {
      setBusy(false)
    }
  }, [playerId, remember])

  const submit = useCallback(
    async (segmentId: string, wav: Blob, mediaStartOffsetMs: number, sampleRate: number) => {
      if (!code) return false
      setBusy(true)
      setError(null)
      try {
        const fresh = await sendTake(
          code,
          {
            segmentId,
            playerId,
            mediaStartOffsetMs,
            sampleRate,
            wav,
          },
          stateRef.current?.storageAccess ?? null,
        )
        remember(fresh)
        return true
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Não conseguimos enviar sua fala.')
        return false
      } finally {
        setBusy(false)
      }
    },
    [code, playerId, remember],
  )

  const leave = useCallback(async () => {
    const atual = stateRef.current
    setBusy(true)
    setError(null)
    try {
      const joined = atual?.players.some((player) => player.id === playerId) ?? false
      if (atual && playerId !== '' && joined) await leaveMatchRemote(atual.code, playerId)
      setState(null)
      setUploadAccess(null)
      localStorage.removeItem(CURRENT_MATCH_KEY)
      localStorage.removeItem(CURRENT_UPLOAD_ACCESS_KEY)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não conseguimos sair da partida.')
      return false
    } finally {
      setBusy(false)
    }
  }, [playerId])

  const reclaim = useCallback(
    async (disconnectedPlayerId: string) => {
      const atual = stateRef.current
      if (!atual || playerId === '') return false
      setBusy(true)
      setError(null)
      try {
        remember(await reclaimDisconnectedPlayerRemote(atual.code, playerId, disconnectedPlayerId))
        return true
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : 'Não conseguimos liberar a vaga desconectada.',
        )
        return false
      } finally {
        setBusy(false)
      }
    },
    [playerId, remember],
  )

  const clearError = useCallback(() => {
    setError(null)
  }, [])

  const activeSegment = state ? currentSegment(state) : null
  const waiting = state ? currentPlayer(state) : null

  return {
    state,
    playerId,
    busy,
    uploadProgress,
    error,
    activeSegment,
    myTurn: state ? isPlayerTurn(state, playerId) : false,
    complete,
    duplaCompleta: state ? isMatchReady(state, Date.now()) : false,
    waitingFor: waiting && waiting.id !== playerId ? waiting.name : null,
    create,
    shareVideo,
    pullVideo,
    peek,
    join,
    ready,
    submit,
    leave,
    reclaim,
    clearError,
  }
}
