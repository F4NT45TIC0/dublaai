'use client'

import { upload } from '@vercel/blob/client'
import type { MatchSegment, MatchState } from '@/lib/online-match'
import {
  MAX_TAKE_BYTES,
  takeAudioKey,
  takeBlobPathname,
  type MatchTakeUploadAccess,
} from './online-match-media'

export type { MatchTakeUploadAccess } from './online-match-media'

export type MatchUploadAccess = 'private' | 'public'

/**
 * Intervalo de consulta do estado da partida.
 *
 * É polling, e não WebSocket, por uma razão concreta: funções serverless não
 * mantêm conexão aberta, então um socket exigiria um serviço à parte só para
 * isso. Num jogo de turnos, esperar até 2 s para saber que chegou a sua vez é
 * imperceptível ao lado de gravar uma fala.
 */
export const MATCH_POLL_MS = 2_000

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string') return body.error
  } catch {
    // Resposta sem JSON (proxy, timeout de borda) cai na mensagem genérica.
  }
  return 'Não conseguimos falar com a partida agora.'
}

export async function createMatch(input: {
  hostId: string
  videoId: string
  videoName: string
  durationMs: number
  segments: readonly MatchSegment[]
  characterNames?: readonly string[]
  videoUrl?: string
}): Promise<{ code: string; state: MatchState; uploadAccess: MatchUploadAccess | null }> {
  const response = await fetch('/api/partidas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!response.ok) throw new Error(await readError(response))
  return (await response.json()) as {
    code: string
    state: MatchState
    uploadAccess: MatchUploadAccess | null
  }
}

export async function fetchMatch(
  code: string,
  signal?: AbortSignal,
  playerId?: string,
  preparing = false,
): Promise<MatchState> {
  const params = new URLSearchParams()
  if (playerId) params.set('playerId', playerId)
  if (preparing) params.set('preparing', '1')
  const query = params.size > 0 ? `?${params.toString()}` : ''
  const response = await fetch(`/api/partidas/${encodeURIComponent(code)}${query}`, {
    cache: 'no-store',
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) throw new Error(await readError(response))
  return ((await response.json()) as { state: MatchState }).state
}

/** Libera a vaga; `keepalive` deixa o clique concluir mesmo se a rota mudar logo depois. */
export async function leaveMatchRemote(code: string, playerId: string): Promise<void> {
  const response = await fetch(`/api/partidas/${encodeURIComponent(code)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId }),
    keepalive: true,
  })
  if (!response.ok) throw new Error(await readError(response))
}

/** Libera uma vaga somente depois que o servidor confirma o timeout dela. */
export async function reclaimDisconnectedPlayerRemote(
  code: string,
  requesterId: string,
  playerId: string,
): Promise<MatchState> {
  const response = await fetch(`/api/partidas/${encodeURIComponent(code)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requesterId, playerId }),
  })
  if (!response.ok) throw new Error(await readError(response))
  return ((await response.json()) as { state: MatchState }).state
}

export async function joinMatchRemote(
  code: string,
  input: { playerId: string; name: string; characterId: string; videoId: string },
): Promise<MatchState> {
  const response = await fetch(`/api/partidas/${encodeURIComponent(code)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!response.ok) throw new Error(await readError(response))
  return ((await response.json()) as { state: MatchState }).state
}

/** Confirma que este aparelho terminou de preparar a cena da partida. */
export async function markPlayerReadyRemote(code: string, playerId: string): Promise<MatchState> {
  const response = await fetch(`/api/partidas/${encodeURIComponent(code)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId, ready: true }),
  })
  if (!response.ok) throw new Error(await readError(response))
  return ((await response.json()) as { state: MatchState }).state
}

export async function sendTake(
  code: string,
  input: {
    segmentId: string
    playerId: string
    mediaStartOffsetMs: number
    sampleRate: number
    wav: Blob
  },
  access: MatchTakeUploadAccess | null = null,
): Promise<MatchState> {
  if (input.wav.size === 0 || input.wav.size > MAX_TAKE_BYTES) {
    throw new Error('Arquivo de áudio fora do tamanho aceito.')
  }

  if (access === 'private') {
    const mediaStartOffsetMs = Math.round(input.mediaStartOffsetMs)
    const audioKey = takeAudioKey(input.segmentId, crypto.randomUUID())
    const pathname = audioKey ? takeBlobPathname(code, audioKey) : null
    if (!pathname) throw new Error('Não conseguimos preparar o destino desta tomada.')

    const stored = await upload(pathname, input.wav, {
      access,
      handleUploadUrl: `/api/partidas/${encodeURIComponent(code)}/tomadas/upload`,
      clientPayload: JSON.stringify({
        segmentId: input.segmentId,
        playerId: input.playerId,
        mediaStartOffsetMs,
        sampleRate: input.sampleRate,
      }),
      contentType: 'audio/wav',
    })

    const response = await fetch(`/api/partidas/${encodeURIComponent(code)}/tomadas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        segmentId: input.segmentId,
        playerId: input.playerId,
        mediaStartOffsetMs,
        sampleRate: input.sampleRate,
        pathname: stored.pathname,
      }),
    })
    if (!response.ok) throw new Error(await readError(response))
    return ((await response.json()) as { state: MatchState }).state
  }

  // O store `file`, usado em desenvolvimento e no E2E, não emite token do
  // Blob. O fixture pequeno continua atravessando a rota multipart local.
  const form = new FormData()
  form.set('segmentId', input.segmentId)
  form.set('playerId', input.playerId)
  form.set('mediaStartOffsetMs', String(Math.round(input.mediaStartOffsetMs)))
  form.set('sampleRate', String(input.sampleRate))
  form.set('audio', input.wav, 'tomada.wav')

  const response = await fetch(`/api/partidas/${encodeURIComponent(code)}/tomadas`, {
    method: 'POST',
    body: form,
  })
  if (!response.ok) throw new Error(await readError(response))
  return ((await response.json()) as { state: MatchState }).state
}

/** Envia o vídeo da cena para a partida. Só o anfitrião faz isso, uma vez. */
export async function shareMatchVideo(
  code: string,
  playerId: string,
  video: Blob,
  fileName: string,
  access: MatchUploadAccess | null,
  onProgress?: (percentage: number) => void,
): Promise<MatchState> {
  // Em produção o arquivo vai direto do navegador ao Blob. Passá-lo pela
  // Function quebraria acima de 4,5 MB, muito antes do limite de vídeo do app.
  if (access) {
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '-').slice(-160) || 'cena.mp4'
    const pathname = `partidas/${code}/video/${crypto.randomUUID()}-${safeName}`
    const stored = await upload(pathname, video, {
      access,
      handleUploadUrl: `/api/partidas/${encodeURIComponent(code)}/video/upload`,
      clientPayload: JSON.stringify({ playerId }),
      ...(video.type ? { contentType: video.type } : {}),
      // A própria SDK divide, paraleliza e repete apenas as partes que falham.
      multipart: video.size > 100 * 1024 * 1024,
      ...(onProgress
        ? {
            onUploadProgress: ({ percentage }) => {
              onProgress(percentage)
            },
          }
        : {}),
    })

    const response = await fetch(`/api/partidas/${encodeURIComponent(code)}/video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId, pathname: stored.pathname }),
    })
    if (!response.ok) throw new Error(await readError(response))
    return ((await response.json()) as { state: MatchState }).state
  }

  // Desenvolvimento e E2E usam disco local e não possuem um Blob para upload
  // direto. Neles a rota antiga continua sendo a representação mais fiel.
  const form = new FormData()
  form.set('playerId', playerId)
  form.set('video', video, fileName)

  const response = await fetch(`/api/partidas/${encodeURIComponent(code)}/video`, {
    method: 'POST',
    body: form,
  })
  if (!response.ok) throw new Error(await readError(response))
  return ((await response.json()) as { state: MatchState }).state
}

/** Baixa o vídeo que o anfitrião guardou, para quem entrou depois. */
export async function pullMatchVideo(code: string, fileName: string): Promise<File> {
  const response = await fetch(`/api/partidas/${encodeURIComponent(code)}/video`)
  if (!response.ok) throw new Error(await readError(response))
  const blob = await response.blob()
  return new File([blob], fileName, { type: blob.type || 'video/mp4' })
}

/**
 * Identidade do jogador neste aparelho.
 *
 * Não é login: é só um identificador aleatório guardado localmente, para que
 * recarregar a página não faça a pessoa perder a vaga na partida. Nenhum dado
 * pessoal entra aqui — o apelido é digitado e fica visível só para a dupla.
 */
export function localPlayerId(): string {
  const key = 'dublaai:jogador'
  const existing = localStorage.getItem(key)
  if (existing) return existing
  const created = crypto.randomUUID()
  localStorage.setItem(key, created)
  return created
}
