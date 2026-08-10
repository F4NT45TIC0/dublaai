import 'server-only'

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MatchState } from '@/lib/online-match'

/**
 * Onde a partida online mora.
 *
 * Duas implementações, e a escolha NÃO é por conveniência: em produção o
 * armazenamento precisa ser compartilhado entre instâncias, e o disco de uma
 * função serverless não é. Por isso a fábrica se recusa a cair no disco fora do
 * desenvolvimento — uma partida que "funciona" e some no próximo request é pior
 * do que uma que avisa que não está configurada.
 */
export interface MatchStore {
  read(code: string): Promise<MatchState | null>
  write(state: MatchState): Promise<void>
  /** Guarda o WAV da tomada e devolve a URL de onde ele pode ser ouvido. */
  putAudio(code: string, segmentId: string, bytes: ArrayBuffer): Promise<string>
}

export class MatchStoreUnavailable extends Error {
  constructor() {
    super(
      'O modo online precisa de um Blob store da Vercel. Crie um em Storage → Blob no projeto ' +
        'e conecte-o; a variável BLOB_READ_WRITE_TOKEN aparece sozinha depois disso.',
    )
    this.name = 'MatchStoreUnavailable'
  }
}

/* ------------------------------------------------------------------ Blob */

function blobStore(): MatchStore {
  const statePath = (code: string) => `partidas/${code}/estado.json`

  return {
    async read(code) {
      const { head } = await import('@vercel/blob')
      try {
        // `head` resolve o caminho para a URL pública sem baixar o conteúdo.
        const meta = await head(statePath(code))
        const response = await fetch(meta.url, { cache: 'no-store' })
        if (!response.ok) return null
        return (await response.json()) as MatchState
      } catch {
        // O SDK lança quando o blob não existe; partida inexistente não é erro.
        return null
      }
    },

    async write(state) {
      const { put } = await import('@vercel/blob')
      await put(statePath(state.code), JSON.stringify(state), {
        access: 'public',
        contentType: 'application/json',
        // Sem isto o SDK acrescenta um sufixo aleatório e o próximo `read`
        // não encontraria o estado que acabou de ser gravado.
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 0,
      })
    },

    async putAudio(code, segmentId, bytes) {
      const { put } = await import('@vercel/blob')
      const result = await put(`partidas/${code}/${segmentId}.wav`, bytes, {
        access: 'public',
        contentType: 'audio/wav',
        addRandomSuffix: false,
        allowOverwrite: true,
      })
      return result.url
    },
  }
}

/* -------------------------------------------------------------- Arquivo */

/**
 * Só para desenvolvimento: `next dev` é um processo só, então o disco funciona
 * como armazenamento compartilhado entre as duas abas. Isso permite exercitar
 * a partida inteira na máquina, sem depender de nuvem nenhuma.
 */
function fileStore(): MatchStore {
  const root = matchDirectory()
  const dir = (code: string) => join(root, code)

  return {
    async read(code) {
      try {
        const raw = await readFile(join(dir(code), 'estado.json'), 'utf8')
        return JSON.parse(raw) as MatchState
      } catch {
        return null
      }
    },

    async write(state) {
      await mkdir(dir(state.code), { recursive: true })
      await writeFile(join(dir(state.code), 'estado.json'), JSON.stringify(state), 'utf8')
    },

    async putAudio(code, segmentId, bytes) {
      await mkdir(dir(code), { recursive: true })
      await writeFile(join(dir(code), `${segmentId}.wav`), Buffer.from(bytes))
      return `/api/partidas/${code}/audio/${segmentId}`
    },
  }
}

/* -------------------------------------------------------------- Fábrica */

/**
 * Disco só vale quando o processo é um só.
 *
 * Em `next dev` isso é verdade de graça. Fora dele, exige a variável explícita
 * — que existe para o teste de ponta a ponta, que roda a build de produção numa
 * máquina só. Ligar isso num deploy de verdade daria partidas que somem entre
 * requisições, por isso não há como cair aqui sem alguém ter escrito a
 * variável à mão.
 */
function fileStoreAllowed(): boolean {
  return process.env.NODE_ENV === 'development' || Boolean(process.env['DUBLA_MATCH_DIR'])
}

function matchDirectory(): string {
  return process.env['DUBLA_MATCH_DIR'] ?? join(process.cwd(), '.dubla-partidas')
}

export function matchStore(): MatchStore {
  // O Blob vem primeiro: onde ele existe, é ele que vale.
  if (process.env['BLOB_READ_WRITE_TOKEN']) return blobStore()
  if (fileStoreAllowed()) return fileStore()
  throw new MatchStoreUnavailable()
}

/** A tela pergunta isto antes de oferecer o modo online. */
export function isOnlineAvailable(): boolean {
  return Boolean(process.env['BLOB_READ_WRITE_TOKEN']) || fileStoreAllowed()
}

/** Caminho do WAV no armazenamento em disco (usado só pela rota de áudio). */
export function localAudioPath(code: string, segmentId: string): string {
  return join(matchDirectory(), code, `${segmentId}.wav`)
}

/** A rota de áudio local só responde onde o disco é o armazenamento. */
export function localAudioAllowed(): boolean {
  return !process.env['BLOB_READ_WRITE_TOKEN'] && fileStoreAllowed()
}
