import { NextResponse } from 'next/server'
import { z } from 'zod'
import { normalizeMatchCode } from '@/lib/match-code'
import { applyTake } from '@/lib/online-match'
import {
  audioKeyFromTakePathname,
  isWavContentType,
  MAX_TAKE_BYTES,
  safeTakeSegmentId,
  takeAudioKey,
} from '@/lib/online-match-media'
import { matchStore, MatchStoreUnavailable } from '@/lib/server/match-store'

export const dynamic = 'force-dynamic'

interface Context {
  readonly params: Promise<{ readonly codigo: string }>
}

interface TakeFields {
  readonly segmentId: string
  readonly playerId: string
  readonly mediaStartOffsetMs: number
  readonly sampleRate: number
}

const confirmSchema = z.object({
  segmentId: z.string().min(1).max(200),
  playerId: z.string().min(1).max(100),
  mediaStartOffsetMs: z.number(),
  sampleRate: z.number().int().positive(),
  pathname: z.string().min(1).max(500),
})

type MatchStore = ReturnType<typeof matchStore>

async function commitTake(
  store: MatchStore,
  code: string,
  fields: TakeFields,
  url: string,
): Promise<Response> {
  const now = Date.now()
  const updated = await store.update<string | null>(code, (fresh) => {
    const result = applyTake(
      fresh,
      fields.segmentId,
      {
        playerId: fields.playerId,
        url,
        mediaStartOffsetMs: fields.mediaStartOffsetMs,
        sampleRate: fields.sampleRate,
      },
      now,
    )
    return result.ok
      ? { kind: 'commit', state: result.state, value: null }
      : { kind: 'reject', value: result.reason }
  })
  if (!updated.found) {
    return NextResponse.json({ error: 'Partida não encontrada.' }, { status: 404 })
  }
  if (!updated.committed) {
    return NextResponse.json(
      { error: updated.value ?? 'Não conseguimos guardar esta fala.' },
      { status: 409 },
    )
  }
  return NextResponse.json({ state: updated.state })
}

async function confirmDirectUpload(
  request: Request,
  store: MatchStore,
  code: string,
): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Confirmação da tomada inválida.' }, { status: 400 })
  }
  const parsed = confirmSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Confirmação da tomada inválida.' }, { status: 400 })
  }
  const { pathname, ...fields } = parsed.data
  const audioKey = audioKeyFromTakePathname(code, fields.segmentId, pathname)
  if (!audioKey) {
    return NextResponse.json({ error: 'Arquivo fora desta partida ou trecho.' }, { status: 400 })
  }

  // Evita usar `head` como leitor de caminhos e repete a autorização feita
  // ao emitir o token. O CAS abaixo ainda é a decisão final.
  const before = await store.read(code)
  if (!before) return NextResponse.json({ error: 'Partida não encontrada.' }, { status: 404 })
  const pending = applyTake(before, fields.segmentId, { ...fields, url: '' }, Date.now())
  if (!pending.ok) return NextResponse.json({ error: pending.reason }, { status: 409 })

  let meta
  try {
    const { head } = await import('@vercel/blob')
    meta = await head(pathname)
  } catch {
    return NextResponse.json(
      { error: 'O upload da tomada ainda não foi encontrado.' },
      { status: 409 },
    )
  }
  if (meta.pathname !== pathname || meta.size <= 0 || meta.size > MAX_TAKE_BYTES) {
    return NextResponse.json({ error: 'Arquivo de áudio fora do tamanho aceito.' }, { status: 413 })
  }
  if (!isWavContentType(meta.contentType)) {
    return NextResponse.json({ error: 'O arquivo enviado não é um WAV.' }, { status: 415 })
  }

  const url = `/api/partidas/${code}/audio/${audioKey}`
  return await commitTake(store, code, fields, url)
}

async function receiveLocalUpload(
  request: Request,
  store: MatchStore,
  code: string,
): Promise<Response> {
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
  if (audio.type && !isWavContentType(audio.type)) {
    return NextResponse.json({ error: 'O arquivo enviado não é um WAV.' }, { status: 415 })
  }

  const state = await store.read(code)
  if (!state) return NextResponse.json({ error: 'Partida não encontrada.' }, { status: 404 })

  // O segmento vem do cliente e vira nome de arquivo. Sem esta conferência,
  // um id com "../" escreveria fora da pasta da partida.
  const segment = state.segments.find((candidate) => candidate.id === segmentId)
  const safeSegmentId = safeTakeSegmentId(segmentId)
  if (!segment || !safeSegmentId) {
    return NextResponse.json({ error: 'Trecho desconhecido.' }, { status: 404 })
  }

  const fields = { segmentId, playerId, mediaStartOffsetMs, sampleRate }
  const pending = applyTake(state, segmentId, { ...fields, url: '' }, Date.now())
  if (!pending.ok) return NextResponse.json({ error: pending.reason }, { status: 409 })

  // Desenvolvimento/E2E não possuem Blob para upload direto. O nome ainda é
  // imutável para duas requisições nunca se sobrescreverem antes do CAS.
  const audioKey = takeAudioKey(segmentId, crypto.randomUUID())
  if (!audioKey) return NextResponse.json({ error: 'Trecho desconhecido.' }, { status: 404 })
  const url = await store.putAudio(code, audioKey, await audio.arrayBuffer())
  return await commitTake(store, code, fields, url)
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

  return request.headers.get('content-type')?.includes('application/json')
    ? await confirmDirectUpload(request, store, code)
    : await receiveLocalUpload(request, store, code)
}
