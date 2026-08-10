import { NextResponse } from 'next/server'
import { normalizeMatchCode } from '@/lib/match-code'
import { applyTake } from '@/lib/online-match'
import { matchStore, MatchStoreUnavailable } from '@/lib/server/match-store'

export const dynamic = 'force-dynamic'

/**
 * Teto do WAV de uma tomada.
 *
 * Um trecho de fala raramente passa de poucos segundos; 25 MB cobrem com folga
 * até uma fala longa em 48 kHz. O limite existe para que o modo online não vire
 * um depósito de arquivos com a desculpa de ser uma dublagem.
 */
const MAX_TAKE_BYTES = 25 * 1024 * 1024

interface Context {
  readonly params: Promise<{ readonly codigo: string }>
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const code = normalizeMatchCode((await context.params).codigo)
  if (!code) return NextResponse.json({ error: 'Código inválido.' }, { status: 400 })

  let store
  try {
    store = matchStore()
  } catch (cause) {
    if (cause instanceof MatchStoreUnavailable) {
      return NextResponse.json({ error: cause.message }, { status: 503 })
    }
    throw cause
  }

  const form = await request.formData()
  const segmentId = form.get('segmentId')
  const playerId = form.get('playerId')
  const offsetRaw = form.get('mediaStartOffsetMs')
  const rateRaw = form.get('sampleRate')
  const audio = form.get('audio')

  if (
    typeof segmentId !== 'string' ||
    typeof playerId !== 'string' ||
    typeof offsetRaw !== 'string' ||
    typeof rateRaw !== 'string' ||
    !(audio instanceof Blob)
  ) {
    return NextResponse.json({ error: 'Tomada incompleta.' }, { status: 400 })
  }

  const mediaStartOffsetMs = Number(offsetRaw)
  const sampleRate = Number(rateRaw)
  if (!Number.isFinite(mediaStartOffsetMs) || !Number.isInteger(sampleRate) || sampleRate <= 0) {
    return NextResponse.json({ error: 'Relógio da tomada inválido.' }, { status: 400 })
  }
  if (audio.size === 0 || audio.size > MAX_TAKE_BYTES) {
    return NextResponse.json({ error: 'Arquivo de áudio fora do tamanho aceito.' }, { status: 413 })
  }

  const state = await store.read(code)
  if (!state) return NextResponse.json({ error: 'Partida não encontrada.' }, { status: 404 })

  // O segmento vem do cliente e vira nome de arquivo. Sem esta conferência, um
  // id com "../" escreveria fora da pasta da partida.
  const segment = state.segments.find((candidate) => candidate.id === segmentId)
  if (!segment) return NextResponse.json({ error: 'Trecho desconhecido.' }, { status: 404 })
  const safeSegmentId = segmentId.replace(/[^a-zA-Z0-9_-]/g, '')
  if (safeSegmentId === '') {
    return NextResponse.json({ error: 'Trecho desconhecido.' }, { status: 404 })
  }

  // A gravação só é guardada depois que a regra do turno aprova. Ao contrário,
  // qualquer um encheria o armazenamento com áudio de partida alheia.
  const bytes = await audio.arrayBuffer()
  const pending = applyTake(
    state,
    segmentId,
    { playerId, url: '', mediaStartOffsetMs, sampleRate },
    Date.now(),
  )
  if (!pending.ok) return NextResponse.json({ error: pending.reason }, { status: 409 })

  const url = await store.putAudio(code, safeSegmentId, bytes)
  const stored = applyTake(
    state,
    segmentId,
    { playerId, url, mediaStartOffsetMs, sampleRate },
    Date.now(),
  )
  if (!stored.ok) return NextResponse.json({ error: stored.reason }, { status: 409 })

  await store.write(stored.state)
  return NextResponse.json({ state: stored.state })
}
