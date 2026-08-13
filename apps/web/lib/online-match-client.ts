'use client'

import { createMatchCode, normalizeMatchCode } from '@/lib/match-code'
import { MAX_TAKE_BYTES } from '@/lib/online-match-media'
import type { MatchSegment, MatchState } from '@/lib/online-match'
import {
  abrirPartida,
  baixarVideoDaSala,
  criarPartida,
  entrarNaPartida,
  enviarVideoDaSala,
  guardarTomada,
  marcarPresenca,
  sairDaPartida,
} from '@/lib/supabase-match'

import type { MatchTakeUploadAccess } from './online-match-media'

export type { MatchTakeUploadAccess }

/**
 * Cliente da partida.
 *
 * As assinaturas são as mesmas de quando a sala vivia no Blob, de propósito: a
 * tela, o hook e a regra de turno não precisaram mudar para a troca acontecer.
 * O que mudou foi tudo por baixo — cada função aqui vira uma chamada às funções
 * do banco, que exigem o código da sala e conferem as regras no servidor.
 *
 * O `uploadAccess` sobreviveu como `null` porque o hook ainda o carrega; no
 * Supabase o upload é sempre direto ao Storage, então não há mais modo a
 * escolher.
 */
export type MatchUploadAccess = 'private' | 'public'

/**
 * Intervalo do batimento de presença.
 *
 * Não é mais releitura: o estado chega por Realtime. Isto aqui só renova o
 * "estou aqui" do jogador, para o outro lado saber que a sala não foi
 * abandonada.
 */
export const MATCH_POLL_MS = 4_000

function exigirCodigo(code: string): string {
  const normalizado = normalizeMatchCode(code)
  if (!normalizado) throw new Error('Código de partida inválido.')
  return normalizado
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
  // O código nasce no navegador e vai como argumento: assim ele é o mesmo que
  // a pessoa vê na tela e o mesmo que o banco guarda, sem uma segunda volta.
  const formatado = createMatchCode()
  const codigo = exigirCodigo(formatado)

  const personagens =
    input.characterNames?.length === 2
      ? input.characterNames
      : ['Voz 1', 'Voz 2']

  const state = await criarPartida({
    codigo,
    hostId: input.hostId,
    videoId: input.videoId,
    videoName: input.videoName,
    durationMs: input.durationMs,
    segmentos: input.segments,
    personagens,
    ...(input.videoUrl === undefined ? {} : { videoUrl: input.videoUrl }),
  })

  return { code: formatado, state, uploadAccess: null }
}

/**
 * Lê a sala.
 *
 * Continua existindo para a restauração após um refresh e para o primeiro
 * carregamento; o acompanhamento contínuo é do Realtime. `preparing` marca o
 * aparelho como não pronto — um refresh perde o vídeo e a análise locais, então
 * ele não pode continuar no rodízio como se nada tivesse acontecido.
 */
export async function fetchMatch(
  code: string,
  _signal?: AbortSignal,
  playerId?: string,
  preparing = false,
): Promise<MatchState> {
  const codigo = exigirCodigo(code)
  if (playerId) {
    return await marcarPresenca(codigo, playerId, preparing ? false : undefined)
  }
  const estado = await abrirPartida(codigo)
  if (!estado) throw new Error('Partida não encontrada.')
  return estado
}

export async function leaveMatchRemote(code: string, playerId: string): Promise<void> {
  await sairDaPartida(exigirCodigo(code), playerId)
}

/**
 * Libera a vaga de quem caiu.
 *
 * A conferência de tempo mora no domínio (`reclaimDisconnectedPlayer`), e a
 * chamada em si é a mesma saída de sempre — o banco não distingue quem pede,
 * então quem decide se já deu o prazo é a tela, com o estado que o Realtime
 * acabou de entregar.
 */
export async function reclaimDisconnectedPlayerRemote(
  code: string,
  _requesterId: string,
  playerId: string,
): Promise<MatchState> {
  return await sairDaPartida(exigirCodigo(code), playerId)
}

export async function joinMatchRemote(
  code: string,
  input: { playerId: string; name: string; characterId: string; videoId: string },
): Promise<MatchState> {
  return await entrarNaPartida(exigirCodigo(code), input.playerId, input.name, input.characterId)
}

/** Renova o "estou aqui" sem mexer na prontidão. */
export async function markPresenceRemote(code: string, playerId: string): Promise<MatchState> {
  return await marcarPresenca(exigirCodigo(code), playerId)
}

/** Confirma que este aparelho terminou de preparar a cena da partida. */
export async function markPlayerReadyRemote(code: string, playerId: string): Promise<MatchState> {
  return await marcarPresenca(exigirCodigo(code), playerId, true)
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
  // Mantido porque o hook e os testes ainda o passam. No Supabase o upload é
  // sempre direto ao Storage, então não há modo a escolher.
  _access: MatchTakeUploadAccess | null = null,
): Promise<MatchState> {
  if (input.wav.size === 0 || input.wav.size > MAX_TAKE_BYTES) {
    throw new Error('Arquivo de áudio fora do tamanho aceito.')
  }
  return await guardarTomada({
    codigo: exigirCodigo(code),
    trechoId: input.segmentId,
    jogadorId: input.playerId,
    wav: input.wav,
    mediaStartOffsetMs: input.mediaStartOffsetMs,
    sampleRate: input.sampleRate,
  })
}

export async function shareMatchVideo(
  code: string,
  playerId: string,
  video: Blob,
  _fileName: string,
  _access: MatchUploadAccess | null,
  onProgress?: (percentage: number) => void,
): Promise<MatchState> {
  // O SDK do Storage não expõe progresso por byte. Marcar início e fim mantém a
  // barra honesta: ela mostra que algo está acontecendo, sem inventar uma
  // porcentagem que não é medida.
  onProgress?.(0)
  try {
    return await enviarVideoDaSala(exigirCodigo(code), playerId, video)
  } finally {
    onProgress?.(100)
  }
}

export async function pullMatchVideo(code: string, fileName: string): Promise<File> {
  const codigo = exigirCodigo(code)
  const estado = await abrirPartida(codigo)
  if (!estado) throw new Error('Partida não encontrada.')

  const arquivo = await baixarVideoDaSala(estado)
  if (!arquivo) throw new Error('Esta partida ainda não tem vídeo.')
  return new File([arquivo], fileName, { type: arquivo.type })
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
