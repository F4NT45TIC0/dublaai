import { NextResponse } from 'next/server'
import { normalizeMatchCode } from '@/lib/match-code'
import { matchStore, MatchStoreUnavailable } from '@/lib/server/match-store'

export const dynamic = 'force-dynamic'

/**
 * Teto do vídeo compartilhado.
 *
 * O limite de um vídeo local é 1 GB porque ele nunca sai do aparelho. Aqui ele
 * atravessa a rede duas vezes — sobe de um lado, desce do outro — e 1 GB numa
 * conexão doméstica é meia hora de espera antes de a brincadeira começar.
 * 200 MB cobrem com folga uma cena de 5 minutos em 720p; acima disso a tela
 * explica e os dois abrem o mesmo arquivo, como antes.
 */
const MAX_SHARED_VIDEO_BYTES = 200 * 1024 * 1024

interface Context {
  readonly params: Promise<{ readonly codigo: string }>
}

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

/** O anfitrião envia o vídeo da partida uma vez. */
export async function POST(request: Request, context: Context): Promise<Response> {
  const code = normalizeMatchCode((await context.params).codigo)
  if (!code) return NextResponse.json({ error: 'Código inválido.' }, { status: 400 })

  const aberto = abrirStore()
  if (aberto.erro) return aberto.erro
  const { store } = aberto

  const form = await request.formData()
  const video = form.get('video')
  const playerId = form.get('playerId')
  if (!(video instanceof Blob) || typeof playerId !== 'string') {
    return NextResponse.json({ error: 'Envio incompleto.' }, { status: 400 })
  }
  if (video.size === 0 || video.size > MAX_SHARED_VIDEO_BYTES) {
    return NextResponse.json(
      {
        error:
          'Para jogar online, o vídeo precisa ter no máximo 200 MB. Acima disso, os dois podem abrir o mesmo arquivo no próprio computador.',
      },
      { status: 413 },
    )
  }

  const state = await store.read(code)
  if (!state) return NextResponse.json({ error: 'Partida não encontrada.' }, { status: 404 })
  if (state.videoShared) {
    return NextResponse.json({ error: 'Esta partida já tem o vídeo.' }, { status: 409 })
  }

  await store.putVideo(code, await video.arrayBuffer())
  const atualizado = { ...state, videoShared: true, updatedAt: Date.now() }
  await store.write(atualizado)
  return NextResponse.json({ state: atualizado })
}

/** O convidado baixa o vídeo que o anfitrião enviou. */
export async function GET(_request: Request, context: Context): Promise<Response> {
  const code = normalizeMatchCode((await context.params).codigo)
  if (!code) return NextResponse.json({ error: 'Código inválido.' }, { status: 404 })

  const aberto = abrirStore()
  if (aberto.erro) return aberto.erro
  const { store } = aberto

  const state = await store.read(code)
  if (!state?.videoShared) {
    return NextResponse.json({ error: 'Esta partida não tem vídeo guardado.' }, { status: 404 })
  }

  const bytes = await store.readVideo(code)
  if (!bytes) return NextResponse.json({ error: 'Não encontrado.' }, { status: 404 })

  return new Response(bytes, {
    headers: {
      'Content-Type': 'video/mp4',
      // O vídeo é de quem está jogando, não de quem passar pela CDN.
      'Cache-Control': 'private, max-age=3600',
    },
  })
}
