import { readFile } from 'node:fs/promises'
import { NextResponse } from 'next/server'
import { normalizeMatchCode } from '@/lib/match-code'
import { localAudioAllowed, localAudioPath } from '@/lib/server/match-store'

export const dynamic = 'force-dynamic'

interface Context {
  readonly params: Promise<{ readonly codigo: string; readonly trecho: string }>
}

/**
 * Serve o WAV de uma tomada guardada em disco.
 *
 * Existe apenas para o desenvolvimento: em produção quem guarda é o Blob e ele
 * já entrega a própria URL. Fora do `next dev` esta rota responde 404 em vez de
 * expor o sistema de arquivos do servidor.
 */
export async function GET(_request: Request, context: Context): Promise<Response> {
  if (!localAudioAllowed()) {
    return NextResponse.json({ error: 'Indisponível.' }, { status: 404 })
  }

  const { codigo, trecho } = await context.params
  const code = normalizeMatchCode(codigo)
  // O trecho vira caminho: só aceitamos o alfabeto que nós mesmos geramos, sem
  // ponto nem barra, para que "../" não saia da pasta da partida.
  if (!code || !/^[a-zA-Z0-9_-]+$/.test(trecho)) {
    return NextResponse.json({ error: 'Não encontrado.' }, { status: 404 })
  }

  try {
    const bytes = await readFile(localAudioPath(code, trecho))
    return new Response(new Uint8Array(bytes), {
      headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' },
    })
  } catch {
    return NextResponse.json({ error: 'Não encontrado.' }, { status: 404 })
  }
}
