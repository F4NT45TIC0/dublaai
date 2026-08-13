'use client'

import type { MatchPlayer, MatchSegment, MatchState, MatchTake } from '@/lib/online-match'
import { BUCKET_PARTIDAS, caminhoDaTomada, caminhoDoVideo, supabase } from '@/lib/supabase'

/**
 * Transporte da partida sobre o Supabase.
 *
 * O formato de estado é o mesmo de antes, de propósito: toda a interface, a
 * regra de turno e os testes continuam falando `MatchState`. O que muda é
 * apenas por onde ele chega — funções do banco em vez de um JSON no Blob, e
 * aviso por Realtime em vez de releitura em laço.
 */

/** Forma bruta devolvida por `abrir_partida`. Validada antes de virar estado. */
interface SalaBruta {
  codigo?: unknown
  hostId?: unknown
  videoId?: unknown
  videoName?: unknown
  durationMs?: unknown
  segmentos?: unknown
  personagens?: unknown
  videoUrl?: unknown
  videoPath?: unknown
  criadaEm?: unknown
  atualizadaEm?: unknown
  jogadores?: unknown
  tomadas?: unknown
}

/**
 * Validade das URLs assinadas do áudio.
 *
 * O bucket é privado, então cada tomada vira um link temporário. Uma hora cobre
 * qualquer partida — que expira em 24 — e o estado é reemitido a cada mudança,
 * renovando os links muito antes de vencerem.
 */
const ASSINATURA_SEGUNDOS = 60 * 60

function texto(valor: unknown, padrao = ''): string {
  return typeof valor === 'string' ? valor : padrao
}

function numero(valor: unknown, padrao = 0): number {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : padrao
}

function instante(valor: unknown): number {
  const t = typeof valor === 'string' ? Date.parse(valor) : Number.NaN
  return Number.isNaN(t) ? Date.now() : t
}

function segmentos(valor: unknown): readonly MatchSegment[] {
  if (!Array.isArray(valor)) return []
  return valor.flatMap((item): MatchSegment[] => {
    if (typeof item !== 'object' || item === null) return []
    const bruto = item as Record<string, unknown>
    const id = texto(bruto['id'])
    if (id === '') return []
    return [
      {
        id,
        characterId: texto(bruto['characterId'], 'voz-1'),
        startMs: numero(bruto['startMs']),
        endMs: numero(bruto['endMs']),
        text: texto(bruto['text']),
      },
    ]
  })
}

function jogadores(valor: unknown): readonly MatchPlayer[] {
  if (!Array.isArray(valor)) return []
  return valor.flatMap((item): MatchPlayer[] => {
    if (typeof item !== 'object' || item === null) return []
    const bruto = item as Record<string, unknown>
    const id = texto(bruto['id'])
    if (id === '') return []
    return [
      {
        id,
        name: texto(bruto['nome'], 'Jogador'),
        characterId: texto(bruto['personagemId'], 'voz-1'),
        ready: bruto['pronto'] === true,
        lastSeenAt: instante(bruto['vistoEm']),
      },
    ]
  })
}

/**
 * Converte a resposta do banco em estado da partida.
 *
 * As URLs do áudio são assinadas aqui porque o bucket é privado: sem assinatura
 * o navegador do outro jogador receberia 400 ao tentar ouvir a fala. Assinar em
 * lote evita uma ida ao servidor por tomada.
 */
export async function mapearEstado(bruta: unknown): Promise<MatchState | null> {
  if (typeof bruta !== 'object' || bruta === null) return null
  const sala = bruta as SalaBruta
  const codigo = texto(sala.codigo)
  if (codigo === '') return null

  const tomadasBrutas =
    typeof sala.tomadas === 'object' && sala.tomadas !== null
      ? (sala.tomadas as Record<string, unknown>)
      : {}

  const caminhos: string[] = []
  for (const valor of Object.values(tomadasBrutas)) {
    if (typeof valor !== 'object' || valor === null) continue
    const caminho = texto((valor as Record<string, unknown>)['audioPath'])
    if (caminho !== '') caminhos.push(caminho)
  }

  const assinadas = new Map<string, string>()
  if (caminhos.length > 0) {
    const { data } = await supabase()
      .storage.from(BUCKET_PARTIDAS)
      .createSignedUrls(caminhos, ASSINATURA_SEGUNDOS)
    for (const item of data ?? []) {
      if (item.path && item.signedUrl) assinadas.set(item.path, item.signedUrl)
    }
  }

  const takes: Record<string, MatchTake> = {}
  for (const [trechoId, valor] of Object.entries(tomadasBrutas)) {
    if (typeof valor !== 'object' || valor === null) continue
    const bruto = valor as Record<string, unknown>
    const caminho = texto(bruto['audioPath'])
    const url = assinadas.get(caminho)
    // Sem link assinado a fala não toca; melhor omiti-la do que entregar uma
    // URL que dará erro no meio da partida.
    if (!url) continue
    takes[trechoId] = {
      playerId: texto(bruto['jogadorId']),
      url,
      mediaStartOffsetMs: numero(bruto['offsetMs']),
      sampleRate: numero(bruto['sampleRate'], 48_000),
    }
  }

  const personagens = Array.isArray(sala.personagens)
    ? sala.personagens.filter((nome): nome is string => typeof nome === 'string')
    : []
  const videoPath = texto(sala.videoPath)
  const videoUrl = texto(sala.videoUrl)

  return {
    code: codigo,
    hostId: texto(sala.hostId),
    videoId: texto(sala.videoId),
    videoName: texto(sala.videoName, 'cena.mp4'),
    durationMs: numero(sala.durationMs),
    segments: segmentos(sala.segmentos),
    ...(personagens.length > 0 ? { characterNames: personagens } : {}),
    players: jogadores(sala.jogadores),
    takes,
    ...(videoPath === '' ? {} : { videoShared: true, videoPathname: videoPath }),
    ...(videoUrl === '' ? {} : { videoUrl }),
    createdAt: instante(sala.criadaEm),
    updatedAt: instante(sala.atualizadaEm),
  }
}

async function chamar(nome: string, argumentos: Record<string, unknown>): Promise<MatchState> {
  const resposta: { data: unknown; error: { message: string } | null } = await supabase().rpc(
    nome,
    argumentos,
  )
  const { data, error } = resposta
  // As mensagens vêm das funções do banco, escritas para serem lidas por quem
  // está jogando — repassá-las é melhor do que traduzir para "algo deu errado".
  if (error) throw new Error(error.message)
  const estado = await mapearEstado(data)
  if (!estado) throw new Error('Partida não encontrada ou expirada.')
  return estado
}

export async function abrirPartida(codigo: string): Promise<MatchState | null> {
  const resposta: { data: unknown; error: { message: string } | null } = await supabase().rpc(
    'abrir_partida',
    { p_codigo: codigo },
  )
  if (resposta.error) throw new Error(resposta.error.message)
  return await mapearEstado(resposta.data)
}

export async function criarPartida(entrada: {
  codigo: string
  hostId: string
  videoId: string
  videoName: string
  durationMs: number
  segmentos: readonly MatchSegment[]
  personagens: readonly string[]
  videoUrl?: string
}): Promise<MatchState> {
  return await chamar('criar_partida', {
    p_codigo: entrada.codigo,
    p_host_id: entrada.hostId,
    p_video_id: entrada.videoId,
    p_video_name: entrada.videoName,
    p_duration_ms: Math.round(entrada.durationMs),
    p_segmentos: entrada.segmentos,
    p_personagens: entrada.personagens,
    p_video_url: entrada.videoUrl ?? null,
  })
}

export async function entrarNaPartida(
  codigo: string,
  jogadorId: string,
  nome: string,
  personagemId: string,
): Promise<MatchState> {
  return await chamar('entrar_na_partida', {
    p_codigo: codigo,
    p_jogador_id: jogadorId,
    p_nome: nome,
    p_personagem_id: personagemId,
  })
}

/** Heartbeat e prontidão na mesma chamada: os dois renovam a presença. */
export async function marcarPresenca(
  codigo: string,
  jogadorId: string,
  pronto?: boolean,
): Promise<MatchState> {
  return await chamar('marcar_presenca', {
    p_codigo: codigo,
    p_jogador_id: jogadorId,
    p_pronto: pronto ?? null,
  })
}

export async function sairDaPartida(codigo: string, jogadorId: string): Promise<MatchState> {
  return await chamar('sair_da_partida', { p_codigo: codigo, p_jogador_id: jogadorId })
}

/**
 * Sobe a tomada e a registra.
 *
 * O arquivo vai primeiro e o registro depois, nessa ordem: se a rede cair no
 * meio, sobra um arquivo órfão no bucket — que a faxina leva junto com a
 * partida. A ordem inversa deixaria a sala apontando para um áudio que não
 * existe, e a fala do outro jogador não tocaria.
 */
export async function guardarTomada(entrada: {
  codigo: string
  trechoId: string
  jogadorId: string
  wav: Blob
  mediaStartOffsetMs: number
  sampleRate: number
}): Promise<MatchState> {
  const caminho = caminhoDaTomada(entrada.codigo, entrada.trechoId, crypto.randomUUID())
  const { error } = await supabase()
    .storage.from(BUCKET_PARTIDAS)
    .upload(caminho, entrada.wav, { contentType: 'audio/wav', upsert: false })
  if (error) throw new Error('Não conseguimos enviar sua fala. Tente de novo.')

  return await chamar('guardar_tomada', {
    p_codigo: entrada.codigo,
    p_trecho_id: entrada.trechoId,
    p_jogador_id: entrada.jogadorId,
    p_audio_path: caminho,
    p_offset_ms: entrada.mediaStartOffsetMs,
    p_sample_rate: Math.round(entrada.sampleRate),
  })
}

export async function enviarVideoDaSala(
  codigo: string,
  jogadorId: string,
  video: Blob,
): Promise<MatchState> {
  const caminho = caminhoDoVideo(codigo)
  const { error } = await supabase()
    .storage.from(BUCKET_PARTIDAS)
    .upload(caminho, video, { contentType: video.type || 'video/mp4', upsert: true })
  if (error) throw new Error('Não conseguimos enviar o vídeo da partida.')

  return await chamar('registrar_video', {
    p_codigo: codigo,
    p_jogador_id: jogadorId,
    p_video_path: caminho,
  })
}

/** Baixa o vídeo da sala. O bucket é privado, então passa por link assinado. */
export async function baixarVideoDaSala(estado: MatchState): Promise<File | null> {
  if (!estado.videoPathname) return null
  const { data, error } = await supabase()
    .storage.from(BUCKET_PARTIDAS)
    .createSignedUrl(estado.videoPathname, ASSINATURA_SEGUNDOS)
  if (error || data.signedUrl === '') return null

  const resposta = await fetch(data.signedUrl)
  if (!resposta.ok) return null
  const blob = await resposta.blob()
  return new File([blob], estado.videoName, { type: blob.type || 'video/mp4' })
}

/**
 * Avisa quando a sala muda.
 *
 * É isto que substitui o laço de releitura: o outro aparelho é notificado, em
 * vez de descobrir na próxima volta. O `postgres_changes` acompanha as três
 * tabelas porque entrar na sala, ficar pronto e gravar uma fala mexem em
 * tabelas diferentes — e todas mudam o que a tela precisa mostrar.
 */
export function assinarSala(codigo: string, aoMudar: (estado: MatchState) => void): () => void {
  const cliente = supabase()
  const recarregar = () => {
    const puxar = async () => {
      try {
        const estado = await abrirPartida(codigo)
        if (estado) aoMudar(estado)
      } catch {
        // Falha momentânea não derruba a sala: o próximo evento recarrega.
      }
    }
    void puxar()
  }

  const canal = cliente
    .channel(`partida:${codigo}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'partidas', filter: `codigo=eq.${codigo}` },
      recarregar,
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'partida_jogadores', filter: `codigo=eq.${codigo}` },
      recarregar,
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'partida_tomadas', filter: `codigo=eq.${codigo}` },
      recarregar,
    )
    .subscribe()

  return () => {
    void cliente.removeChannel(canal)
  }
}
