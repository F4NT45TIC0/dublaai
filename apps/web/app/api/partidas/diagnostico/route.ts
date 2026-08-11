import { NextResponse } from 'next/server'
import { matchStore, MatchStoreUnavailable } from '@/lib/server/match-store'

export const dynamic = 'force-dynamic'

/**
 * Diz se o modo online está de pé — sem pedir o token a ninguém.
 *
 * Existe porque a pergunta "o Blob está certo?" só tinha uma resposta prática:
 * mandar o token para alguém testar, o que é justamente o que não se deve
 * fazer com um segredo. Aqui o próprio servidor dá a volta completa — escreve
 * um estado de mentira, lê de volta e compara — e responde o que aconteceu. O
 * token nunca sai de onde está.
 */
export async function GET(): Promise<Response> {
  const configurado = Boolean(process.env['BLOB_READ_WRITE_TOKEN'])

  let store
  try {
    store = matchStore()
  } catch (cause) {
    return NextResponse.json(
      {
        configurado,
        funcionando: false,
        detalhe:
          cause instanceof MatchStoreUnavailable
            ? cause.message
            : 'Não conseguimos abrir o armazenamento das partidas.',
      },
      { status: 503 },
    )
  }

  // Código fixo e reconhecível: o diagnóstico sobrescreve sempre o mesmo
  // objeto, em vez de deixar lixo novo no store a cada verificação.
  const codigo = 'DIAGNOSTIC00'
  const agora = Date.now()

  try {
    await store.write({
      code: codigo,
      videoId: 'diagnostico',
      videoName: 'diagnostico',
      durationMs: 1_000,
      segments: [],
      players: [],
      takes: {},
      createdAt: agora,
      updatedAt: agora,
    })

    const devolta = await store.read(codigo)
    if (devolta?.updatedAt !== agora) {
      return NextResponse.json(
        {
          configurado,
          funcionando: false,
          detalhe:
            'A escrita foi aceita, mas a leitura voltou diferente. Confira se o store conectado ao projeto é o mesmo que está sendo lido.',
        },
        { status: 503 },
      )
    }
  } catch (cause) {
    return NextResponse.json(
      {
        configurado,
        funcionando: false,
        detalhe: cause instanceof Error ? cause.message : 'Falha desconhecida no armazenamento.',
      },
      { status: 503 },
    )
  }

  return NextResponse.json({
    configurado,
    funcionando: true,
    armazenamento: configurado ? 'Vercel Blob' : 'disco local (desenvolvimento)',
    detalhe: 'Escrita e leitura funcionaram. O modo online está pronto.',
  })
}
