import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createMatchCode, normalizeMatchCode } from '@/lib/match-code'
import { charactersOf, MIN_MATCH_CHARACTERS, type MatchState } from '@/lib/online-match'
import { matchStore, MatchStoreUnavailable } from '@/lib/server/match-store'

/** Partida é estado vivo: nada aqui pode ser pré-renderizado nem cacheado. */
export const dynamic = 'force-dynamic'

/**
 * O corpo vem do navegador, então é validado inteiro antes de virar estado.
 * Os limites não são decorativos: sem eles, um POST poderia gravar dezenas de
 * MB de "cena" no armazenamento com uma requisição só.
 */
const createSchema = z.object({
  videoId: z.string().min(1).max(200),
  videoName: z.string().min(1).max(300),
  durationMs: z.number().int().positive().max(5 * 60_000),
  // Só HTTPS: o link é repassado para o navegador de quem entrar, e um
  // endereço `javascript:` ou `data:` guardado aqui viraria arma na outra
  // ponta.
  videoUrl: z.url().startsWith('https://').max(2_000).optional(),
  segments: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        characterId: z.string().min(1).max(100),
        startMs: z.number().int().nonnegative(),
        endMs: z.number().int().positive(),
        text: z.string().max(300),
      }),
    )
    .min(1)
    .max(300),
})

export async function POST(request: Request): Promise<Response> {
  let store
  try {
    store = matchStore()
  } catch (cause) {
    if (cause instanceof MatchStoreUnavailable) {
      return NextResponse.json({ error: cause.message }, { status: 503 })
    }
    throw cause
  }

  const parsed = createSchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Dados da partida inválidos.' }, { status: 400 })
  }

  const { videoId, videoName, durationMs, segments, videoUrl } = parsed.data
  if (charactersOf(segments).length < MIN_MATCH_CHARACTERS) {
    return NextResponse.json(
      { error: 'A partida online precisa de uma cena com pelo menos duas vozes.' },
      { status: 400 },
    )
  }

  const code = createMatchCode()
  const storageKey = normalizeMatchCode(code)
  if (!storageKey) {
    // Só aconteceria se o gerador e o normalizador discordassem — o teste
    // cobre exatamente isso, mas o tipo continua exigindo o tratamento.
    return NextResponse.json({ error: 'Não conseguimos criar o código.' }, { status: 500 })
  }

  const now = Date.now()
  const state: MatchState = {
    code: storageKey,
    videoId,
    videoName,
    durationMs,
    segments,
    ...(videoUrl === undefined ? {} : { videoUrl }),
    players: [],
    takes: {},
    createdAt: now,
    updatedAt: now,
  }

  await store.write(state)
  return NextResponse.json({ code, state })
}
