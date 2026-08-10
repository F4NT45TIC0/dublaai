import { NextResponse } from 'next/server'
import { z } from 'zod'
import { normalizeMatchCode } from '@/lib/match-code'
import { isExpired, joinMatch } from '@/lib/online-match'
import { matchStore, MatchStoreUnavailable } from '@/lib/server/match-store'

export const dynamic = 'force-dynamic'

const joinSchema = z.object({
  playerId: z.string().min(1).max(100),
  name: z.string().min(1).max(40),
  characterId: z.string().min(1).max(100),
  videoId: z.string().min(1).max(200),
})

interface Context {
  readonly params: Promise<{ readonly codigo: string }>
}

/**
 * Estado da partida. É o que a outra ponta consulta em intervalo para saber
 * quando chegou a vez dela.
 */
export async function GET(_request: Request, context: Context): Promise<Response> {
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

  const state = await store.read(code)
  // Partida inexistente e código errado respondem igual, de propósito: a
  // diferença entre as duas diria a um curioso quais códigos existem.
  if (!state || isExpired(state, Date.now())) {
    return NextResponse.json({ error: 'Partida não encontrada.' }, { status: 404 })
  }

  return NextResponse.json({ state })
}

/** Entrar na partida escolhendo um personagem. */
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

  const parsed = joinSchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Dados de entrada inválidos.' }, { status: 400 })
  }

  const state = await store.read(code)
  if (!state) return NextResponse.json({ error: 'Partida não encontrada.' }, { status: 404 })

  const { playerId, name, characterId, videoId } = parsed.data
  const result = joinMatch(state, { id: playerId, name, characterId }, videoId, Date.now())
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 409 })

  await store.write(result.state)
  return NextResponse.json({ state: result.state })
}
