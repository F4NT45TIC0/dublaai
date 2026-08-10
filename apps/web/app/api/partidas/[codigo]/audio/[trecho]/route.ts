import { NextResponse } from 'next/server'
import { normalizeMatchCode } from '@/lib/match-code'
import { matchStore, MatchStoreUnavailable } from '@/lib/server/match-store'

export const dynamic = 'force-dynamic'

interface Context {
  readonly params: Promise<{ readonly codigo: string; readonly trecho: string }>
}

/**
 * Serve o WAV de uma tomada da partida.
 *
 * O áudio sai daqui, e não de uma URL do armazenamento, de propósito: no Blob
 * o store é privado, então o arquivo só é legível por quem tem o token — que
 * mora no servidor e nunca no navegador. Quem quiser ouvir precisa do código da
 * partida, e o código tem 60 bits.
 */
export async function GET(_request: Request, context: Context): Promise<Response> {
  const { codigo, trecho } = await context.params
  const code = normalizeMatchCode(codigo)
  // O trecho vira caminho no armazenamento: só passa o alfabeto que nós mesmos
  // geramos, sem ponto nem barra, para que "../" não saia da pasta da partida.
  if (!code || !/^[a-zA-Z0-9_-]+$/.test(trecho)) {
    return NextResponse.json({ error: 'Não encontrado.' }, { status: 404 })
  }

  let store
  try {
    store = matchStore()
  } catch (cause) {
    if (cause instanceof MatchStoreUnavailable) {
      return NextResponse.json({ error: cause.message }, { status: 503 })
    }
    throw cause
  }

  // A partida precisa existir e conhecer o trecho. Sem esta conferência, a
  // rota viraria um leitor genérico do armazenamento.
  const state = await store.read(code)
  if (!state?.segments.some((segment) => segment.id.replace(/[^a-zA-Z0-9_-]/g, '') === trecho)) {
    return NextResponse.json({ error: 'Não encontrado.' }, { status: 404 })
  }

  const bytes = await store.readAudio(code, trecho)
  if (!bytes) return NextResponse.json({ error: 'Não encontrado.' }, { status: 404 })

  return new Response(bytes, {
    headers: {
      'Content-Type': 'audio/wav',
      // A tomada é imutável (regravar exige outro trecho), mas é voz de alguém:
      // fica no cache do navegador, nunca em cache compartilhado.
      'Cache-Control': 'private, max-age=3600',
    },
  })
}
