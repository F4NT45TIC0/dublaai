import { NextResponse } from 'next/server'
import { z } from 'zod'
import { MAX_VIDEO_BYTES } from '@/lib/local-video'
import { normalizeMatchCode } from '@/lib/match-code'
import { isExpired } from '@/lib/online-match'
import { matchStore, MatchStoreUnavailable } from '@/lib/server/match-store'

export const dynamic = 'force-dynamic'

interface Context {
  readonly params: Promise<{ readonly codigo: string }>
}

const confirmSchema = z.object({
  playerId: z.string().min(1).max(100),
  pathname: z.string().min(1).max(500),
})

type StoreAberto =
  | { readonly store: ReturnType<typeof matchStore>; readonly erro?: undefined }
  | { readonly store?: undefined; readonly erro: Response }

function abrirStore(): StoreAberto {
  try {
    return { store: matchStore() }
  } catch (cause) {
    if (cause instanceof MatchStoreUnavailable) {
      return { erro: NextResponse.json({ error: cause.message }, { status: 503 }) }
    }
    throw cause
  }
}

function blobAccess(url: string): 'private' | 'public' {
  return new URL(url).hostname.includes('.private.blob.') ? 'private' : 'public'
}

/** Confirma upload direto em produção ou recebe o fixture pequeno em desenvolvimento. */
export async function POST(request: Request, context: Context): Promise<Response> {
  const code = normalizeMatchCode((await context.params).codigo)
  if (!code) return NextResponse.json({ error: 'Código inválido.' }, { status: 400 })

  const aberto = abrirStore()
  if (aberto.erro) return aberto.erro
  const { store } = aberto

  if (request.headers.get('content-type')?.includes('application/json')) {
    const parsed = confirmSchema.safeParse(await request.json())
    if (!parsed.success) {
      return NextResponse.json({ error: 'Confirmação de vídeo inválida.' }, { status: 400 })
    }

    const { playerId, pathname } = parsed.data
    const prefix = `partidas/${code}/video/`
    if (!pathname.startsWith(prefix) || pathname.includes('..')) {
      return NextResponse.json({ error: 'Arquivo fora desta partida.' }, { status: 400 })
    }

    let meta
    try {
      const { head } = await import('@vercel/blob')
      meta = await head(pathname)
    } catch {
      return NextResponse.json(
        { error: 'O upload do vídeo ainda não foi encontrado.' },
        { status: 409 },
      )
    }
    if (meta.pathname !== pathname || meta.size <= 0 || meta.size > MAX_VIDEO_BYTES) {
      return NextResponse.json({ error: 'Vídeo fora do tamanho aceito.' }, { status: 413 })
    }
    if (meta.contentType && !meta.contentType.startsWith('video/')) {
      return NextResponse.json({ error: 'O arquivo enviado não é um vídeo.' }, { status: 415 })
    }

    const now = Date.now()
    const access = blobAccess(meta.url)
    const updated = await store.update(code, (state) => {
      if (isExpired(state, now)) {
        return { kind: 'reject', value: 'Esta partida expirou.' } as const
      }
      if (state.hostId !== playerId) {
        return { kind: 'reject', value: 'Somente o anfitrião pode enviar o vídeo.' } as const
      }
      if (state.videoShared) {
        return { kind: 'reject', value: 'Esta partida já tem um vídeo.' } as const
      }
      return {
        kind: 'commit',
        state: {
          ...state,
          videoShared: true,
          videoPathname: meta.pathname,
          videoContentType: meta.contentType || 'video/mp4',
          videoSize: meta.size,
          videoAccess: access,
          updatedAt: now,
        },
        value: null,
      } as const
    })
    if (!updated.found) {
      return NextResponse.json({ error: 'Partida não encontrada.' }, { status: 404 })
    }
    if (!updated.committed) {
      return NextResponse.json({ error: updated.value }, { status: 409 })
    }
    return NextResponse.json({ state: updated.state })
  }

  // O fallback multipart só existe no store de arquivo usado por dev/E2E.
  const form = await request.formData()
  const video = form.get('video')
  const playerId = form.get('playerId')
  if (!(video instanceof Blob) || typeof playerId !== 'string') {
    return NextResponse.json({ error: 'Envio incompleto.' }, { status: 400 })
  }
  if (video.size === 0 || video.size > MAX_VIDEO_BYTES) {
    return NextResponse.json({ error: 'O vídeo precisa ter no máximo 1 GB.' }, { status: 413 })
  }
  if (video.type && !video.type.startsWith('video/')) {
    return NextResponse.json({ error: 'O arquivo enviado não é um vídeo.' }, { status: 415 })
  }

  const before = await store.read(code)
  if (!before) return NextResponse.json({ error: 'Partida não encontrada.' }, { status: 404 })
  if (isExpired(before, Date.now())) {
    return NextResponse.json({ error: 'Esta partida expirou.' }, { status: 410 })
  }
  if (before.hostId !== playerId) {
    return NextResponse.json({ error: 'Somente o anfitrião pode enviar o vídeo.' }, { status: 403 })
  }
  if (before.videoShared) {
    return NextResponse.json({ error: 'Esta partida já tem um vídeo.' }, { status: 409 })
  }

  await store.putVideo(code, await video.arrayBuffer())
  const now = Date.now()
  const updated = await store.update(code, (state) => {
    if (isExpired(state, now)) {
      return { kind: 'reject', value: 'Esta partida expirou.' } as const
    }
    if (state.hostId !== playerId) {
      return { kind: 'reject', value: 'Somente o anfitrião pode enviar o vídeo.' } as const
    }
    if (state.videoShared) {
      return { kind: 'reject', value: 'Esta partida já tem um vídeo.' } as const
    }
    return {
      kind: 'commit',
      state: {
        ...state,
        videoShared: true,
        videoContentType: video.type || 'video/mp4',
        videoSize: video.size,
        updatedAt: now,
      },
      value: null,
    } as const
  })
  if (!updated.found) {
    return NextResponse.json({ error: 'Partida não encontrada.' }, { status: 404 })
  }
  if (!updated.committed) {
    return NextResponse.json({ error: updated.value }, { status: 409 })
  }
  return NextResponse.json({ state: updated.state })
}

/** Envia ao convidado exatamente o vídeo canônico da sala. */
export async function GET(_request: Request, context: Context): Promise<Response> {
  const code = normalizeMatchCode((await context.params).codigo)
  if (!code) return NextResponse.json({ error: 'Código inválido.' }, { status: 404 })

  const aberto = abrirStore()
  if (aberto.erro) return aberto.erro
  const { store } = aberto

  const state = await store.read(code)
  if (!state?.videoShared || isExpired(state, Date.now())) {
    return NextResponse.json({ error: 'Esta partida ainda não tem vídeo.' }, { status: 404 })
  }

  if (state.videoPathname && state.videoAccess) {
    const { get } = await import('@vercel/blob')
    const result = await get(state.videoPathname, {
      access: state.videoAccess,
      useCache: false,
    })
    if (result?.statusCode !== 200) {
      return NextResponse.json({ error: 'Vídeo não encontrado.' }, { status: 404 })
    }
    return new Response(result.stream, {
      headers: {
        'Content-Type': state.videoContentType ?? result.blob.contentType,
        'Content-Length': String(state.videoSize ?? result.blob.size),
        ETag: result.blob.etag,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-cache',
      },
    })
  }

  const bytes = await store.readVideo(code)
  if (!bytes) return NextResponse.json({ error: 'Vídeo não encontrado.' }, { status: 404 })
  return new Response(bytes, {
    headers: {
      'Content-Type': state.videoContentType ?? 'video/mp4',
      'Content-Length': String(bytes.byteLength),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600',
    },
  })
}
