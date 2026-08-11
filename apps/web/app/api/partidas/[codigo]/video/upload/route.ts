import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
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

const payloadSchema = z.object({ playerId: z.string().min(1).max(100) })

/** Emite um token curto para o navegador subir o vídeo direto ao Vercel Blob. */
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

  const body = (await request.json()) as HandleUploadBody
  try {
    const response = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const payload = payloadSchema.safeParse(
          clientPayload ? (JSON.parse(clientPayload) as unknown) : null,
        )
        if (!payload.success) throw new Error('Identidade do anfitrião inválida.')

        const state = await store.read(code)
        if (!state) throw new Error('Partida não encontrada.')
        if (isExpired(state, Date.now())) throw new Error('Esta partida expirou.')
        if (state.hostId !== payload.data.playerId) {
          throw new Error('Somente o anfitrião pode enviar o vídeo.')
        }
        if (state.videoShared) throw new Error('Esta partida já tem um vídeo.')
        if (!pathname.startsWith(`partidas/${code}/video/`) || pathname.includes('..')) {
          throw new Error('Destino do vídeo inválido.')
        }

        return {
          allowedContentTypes: ['video/*'],
          maximumSizeInBytes: MAX_VIDEO_BYTES,
          addRandomSuffix: false,
          tokenPayload: JSON.stringify({ code, playerId: payload.data.playerId }),
        }
      },
      // A confirmação síncrona feita pelo navegador após `upload()` é a fonte
      // de verdade. O callback continua aceito para a SDK concluir o protocolo.
      onUploadCompleted: () => Promise.resolve(),
    })
    return NextResponse.json(response)
  } catch (cause) {
    return NextResponse.json(
      { error: cause instanceof Error ? cause.message : 'Não conseguimos autorizar o upload.' },
      { status: 400 },
    )
  }
}
