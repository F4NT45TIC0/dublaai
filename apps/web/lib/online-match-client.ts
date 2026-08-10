'use client'

import type { MatchSegment, MatchState } from '@/lib/online-match'

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
  videoId: string
  videoName: string
  durationMs: number
  segments: readonly MatchSegment[]
}): Promise<{ code: string; state: MatchState }> {
  const response = await fetch('/api/partidas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!response.ok) throw new Error(await readError(response))
  return (await response.json()) as { code: string; state: MatchState }
}

export async function fetchMatch(code: string, signal?: AbortSignal): Promise<MatchState> {
  const response = await fetch(`/api/partidas/${encodeURIComponent(code)}`, {
    cache: 'no-store',
    ...(signal ? { signal } : {}),
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

export async function sendTake(
  code: string,
  input: {
    segmentId: string
    playerId: string
    mediaStartOffsetMs: number
    sampleRate: number
    wav: Blob
  },
): Promise<MatchState> {
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
