import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { normalizeMatchCode } from '@/lib/match-code'
import { applyTake } from '@/lib/online-match'
import { audioKeyFromTakePathname, MAX_TAKE_BYTES } from '@/lib/online-match-media'
import { matchStore, MatchStoreUnavailable } from '@/lib/server/match-store'

export const dynamic = 'force-dynamic'

interface Context {
  readonly params: Promise<{ readonly codigo: string }>
}

const payloadSchema = z.object({
  segmentId: z.string().min(1).max(200),
  playerId: z.string().min(1).max(100),
  mediaStartOffsetMs: z.number(),
  sampleRate: z.number().int().positive(),
})

/** Emite um token restrito a um único WAV, somente para o dono da vez atual. */
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

  try {
    const body = (await request.json()) as HandleUploadBody
    const response = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const payload = payloadSchema.safeParse(
          clientPayload ? (JSON.parse(clientPayload) as unknown) : null,
        )
        if (!payload.success) throw new Error('Dados da tomada inválidos.')

        const audioKey = audioKeyFromTakePathname(code, payload.data.segmentId, pathname)
        if (!audioKey) throw new Error('Destino da tomada inválido.')

        const state = await store.read(code)
        if (!state) throw new Error('Partida não encontrada.')
        const authorized = applyTake(
          state,
          payload.data.segmentId,
          {
            playerId: payload.data.playerId,
            url: '',
            mediaStartOffsetMs: payload.data.mediaStartOffsetMs,
            sampleRate: payload.data.sampleRate,
          },
          Date.now(),
        )
        if (!authorized.ok) throw new Error(authorized.reason)

        return {
          allowedContentTypes: ['audio/wav', 'audio/x-wav', 'audio/wave'],
          maximumSizeInBytes: MAX_TAKE_BYTES,
          addRandomSuffix: false,
          // O nome contém UUID; repetir a mesma URL nunca pode trocar a voz.
          allowOverwrite: false,
          tokenPayload: JSON.stringify({
            code,
            segmentId: payload.data.segmentId,
            playerId: payload.data.playerId,
            audioKey,
          }),
        }
      },
      // A confirmação síncrona da rota `/tomadas` faz o CAS. O callback
      // precisa existir apenas para a SDK concluir o protocolo de upload.
      onUploadCompleted: () => Promise.resolve(),
    })
    return NextResponse.json(response)
  } catch (cause) {
    return NextResponse.json(
      { error: cause instanceof Error ? cause.message : 'Não conseguimos autorizar a tomada.' },
      { status: 400 },
    )
  }
}
