import { NextResponse } from 'next/server'
import { z } from 'zod'
import { normalizeMatchCode } from '@/lib/match-code'
import {
  isExpired,
  joinMatch,
  leaveMatch,
  markPlayerReady,
  reclaimDisconnectedPlayer,
  touchPlayer,
} from '@/lib/online-match'
import { matchStore, MatchStoreUnavailable } from '@/lib/server/match-store'

export const dynamic = 'force-dynamic'

const joinSchema = z.object({
  playerId: z.string().min(1).max(100),
  name: z.string().min(1).max(40),
  characterId: z.string().min(1).max(100),
  videoId: z.string().min(1).max(200),
})

const readySchema = z.object({
  playerId: z.string().min(1).max(100),
  ready: z.literal(true),
})

const leaveSchema = z.object({
  playerId: z.string().min(1).max(100),
  requesterId: z.string().min(1).max(100).optional(),
})

interface Context {
  readonly params: Promise<{ readonly codigo: string }>
}

/**
 * Estado da partida. É o que a outra ponta consulta em intervalo para saber
 * quando chegou a vez dela.
 */
export async function GET(request: Request, context: Context): Promise<Response> {
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

  const heartbeatId = new URL(request.url).searchParams.get('playerId')
  const preparing = new URL(request.url).searchParams.get('preparing') === '1'
  let state
  try {
    if (heartbeatId && heartbeatId.length <= 100) {
      const now = Date.now()
      const touched = await store.update<string | null>(code, (current) => {
        // No refresh, o vídeo local desapareceu. O primeiro heartbeat também
        // tira o aparelho de pronto até o novo download e preparo terminarem.
        const result = preparing
          ? markPlayerReady(current, heartbeatId, now, false)
          : touchPlayer(current, heartbeatId, now)
        return result.ok
          ? { kind: 'commit', state: result.state, value: null }
          : { kind: 'reject', value: result.reason }
      })
      state = touched.found ? touched.state : null
    } else {
      state = await store.read(code)
    }
  } catch (cause) {
    if (cause instanceof MatchStoreUnavailable) {
      return NextResponse.json({ error: cause.message }, { status: 503 })
    }
    throw cause
  }
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

  const { playerId, name, characterId, videoId } = parsed.data
  const now = Date.now()
  let updated
  try {
    updated = await store.update<string | null>(code, (state) => {
      const result = joinMatch(state, { id: playerId, name, characterId }, videoId, now)
      return result.ok
        ? { kind: 'commit', state: result.state, value: null }
        : { kind: 'reject', value: result.reason }
    })
  } catch (cause) {
    if (cause instanceof MatchStoreUnavailable) {
      return NextResponse.json({ error: cause.message }, { status: 503 })
    }
    throw cause
  }
  if (!updated.found) {
    return NextResponse.json({ error: 'Partida não encontrada.' }, { status: 404 })
  }
  if (!updated.committed) {
    return NextResponse.json(
      { error: updated.value ?? 'Não conseguimos entrar na partida.' },
      { status: 409 },
    )
  }

  return NextResponse.json({ state: updated.state })
}

/** Marca o aparelho como pronto somente depois de ele preparar o vídeo. */
export async function PATCH(request: Request, context: Context): Promise<Response> {
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

  const parsed = readySchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Confirmação inválida.' }, { status: 400 })
  }

  const now = Date.now()
  let updated
  try {
    updated = await store.update<string | null>(code, (state) => {
      const result = markPlayerReady(state, parsed.data.playerId, now)
      return result.ok
        ? { kind: 'commit', state: result.state, value: null }
        : { kind: 'reject', value: result.reason }
    })
  } catch (cause) {
    if (cause instanceof MatchStoreUnavailable) {
      return NextResponse.json({ error: cause.message }, { status: 503 })
    }
    throw cause
  }
  if (!updated.found) {
    return NextResponse.json({ error: 'Partida não encontrada.' }, { status: 404 })
  }
  if (!updated.committed) {
    return NextResponse.json(
      { error: updated.value ?? 'Não conseguimos confirmar o aparelho.' },
      { status: 409 },
    )
  }

  return NextResponse.json({ state: updated.state })
}

/** Sai explicitamente, liberando a voz para a dupla não ficar presa numa vaga fantasma. */
export async function DELETE(request: Request, context: Context): Promise<Response> {
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

  const parsed = leaveSchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Saída inválida.' }, { status: 400 })
  }

  const now = Date.now()
  let updated
  try {
    updated = await store.update<string | null>(code, (state) => {
      const result = parsed.data.requesterId
        ? reclaimDisconnectedPlayer(state, parsed.data.requesterId, parsed.data.playerId, now)
        : leaveMatch(state, parsed.data.playerId, now)
      return result.ok
        ? { kind: 'commit', state: result.state, value: null }
        : { kind: 'reject', value: result.reason }
    })
  } catch (cause) {
    if (cause instanceof MatchStoreUnavailable) {
      return NextResponse.json({ error: cause.message }, { status: 503 })
    }
    throw cause
  }

  if (!updated.found) {
    return NextResponse.json({ error: 'Partida não encontrada.' }, { status: 404 })
  }
  if (!updated.committed) {
    return NextResponse.json(
      { error: updated.value ?? 'Não conseguimos sair da partida.' },
      { status: 409 },
    )
  }
  return NextResponse.json({ state: updated.state })
}
