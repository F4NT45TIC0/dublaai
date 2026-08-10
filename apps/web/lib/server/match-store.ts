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
  /** Devolve o WAV guardado, ou `null` se ele não existe. */
  readAudio(code: string, segmentId: string): Promise<ArrayBuffer | null>
  /** Guarda o vídeo da partida, para quem entrar depois baixar. */
  putVideo(code: string, bytes: ArrayBuffer): Promise<void>
  readVideo(code: string): Promise<ArrayBuffer | null>
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

/**
 * Um store do Blob é público OU privado, e o `put` recusa o modo errado.
 *
 * Preferimos privado: são gravações de voz, e num store privado o arquivo
 * responde 403 para quem tentar a URL direta — só o servidor, de posse do
 * token, consegue lê-lo. Stores antigos são públicos, então o modo é
 * descoberto na primeira escrita e lembrado daí em diante.
 */
let blobAccess: 'private' | 'public' | null = null

function isWrongAccessError(cause: unknown): boolean {
  return cause instanceof Error && /access on a (private|public) store/i.test(cause.message)
}

async function putWithDetectedAccess<T>(
  write: (access: 'private' | 'public') => Promise<T>,
): Promise<T> {
  if (blobAccess) return await write(blobAccess)
  try {
    const result = await write('private')
    blobAccess = 'private'
    return result
  } catch (cause) {
    if (!isWrongAccessError(cause)) throw cause
    const result = await write('public')
    blobAccess = 'public'
    return result
  }
}

/** Lê um blob privado. Sem o token, a mesma URL responde 403. */
async function fetchBlob(url: string): Promise<Response> {
  return await fetch(url, {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${process.env['BLOB_READ_WRITE_TOKEN'] ?? ''}` },
  })
}

function blobStore(): MatchStore {
  const statePath = (code: string) => `partidas/${code}/estado.json`
  const audioPath = (code: string, segmentId: string) => `partidas/${code}/${segmentId}.wav`
  const videoPath = (code: string) => `partidas/${code}/cena.mp4`

  return {
    async read(code) {
      const { head } = await import('@vercel/blob')
      try {
        // `head` resolve o caminho para a URL do objeto sem baixar o conteúdo.
        const meta = await head(statePath(code))
        const response = await fetchBlob(meta.url)
        if (!response.ok) return null
        return (await response.json()) as MatchState
      } catch {
        // O SDK lança quando o blob não existe; partida inexistente não é erro.
        return null
      }
    },

    async write(state) {
      const { put } = await import('@vercel/blob')
      await putWithDetectedAccess(
        async (access) =>
          await put(statePath(state.code), JSON.stringify(state), {
            access,
            contentType: 'application/json',
            // Sem isto o SDK acrescenta um sufixo aleatório e o próximo `read`
            // não encontraria o estado que acabou de ser gravado.
            addRandomSuffix: false,
            allowOverwrite: true,
            cacheControlMaxAge: 0,
          }),
      )
    },

    async putAudio(code, segmentId, bytes) {
      const { put } = await import('@vercel/blob')
      await putWithDetectedAccess(
        async (access) =>
          await put(audioPath(code, segmentId), bytes, {
            access,
            contentType: 'audio/wav',
            addRandomSuffix: false,
            allowOverwrite: true,
          }),
      )
      // A URL do Blob nunca chega ao navegador: o áudio sai pela rota da
      // própria aplicação, que é o único lugar com o token para lê-lo.
      return `/api/partidas/${code}/audio/${segmentId}`
    },

    async readAudio(code, segmentId) {
      const { head } = await import('@vercel/blob')
      try {
        const meta = await head(audioPath(code, segmentId))
        const response = await fetchBlob(meta.url)
        if (!response.ok) return null
        return await response.arrayBuffer()
      } catch {
        return null
      }
    },

    async putVideo(code, bytes) {
      const { put } = await import('@vercel/blob')
      await putWithDetectedAccess(
        async (access) =>
          await put(videoPath(code), bytes, {
            access,
            contentType: 'video/mp4',
            addRandomSuffix: false,
            allowOverwrite: true,
          }),
      )
    },

    async readVideo(code) {
      const { head } = await import('@vercel/blob')
      try {
        const meta = await head(videoPath(code))
        const response = await fetchBlob(meta.url)
        if (!response.ok) return null
        return await response.arrayBuffer()
      } catch {
        return null
      }
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

    async readAudio(code, segmentId) {
      return await lerArquivo(join(dir(code), `${segmentId}.wav`))
    },

    async putVideo(code, bytes) {
      await mkdir(dir(code), { recursive: true })
      await writeFile(join(dir(code), 'cena.mp4'), Buffer.from(bytes))
    },

    async readVideo(code) {
      return await lerArquivo(join(dir(code), 'cena.mp4'))
    },
  }
}

async function lerArquivo(caminho: string): Promise<ArrayBuffer | null> {
  try {
    const bytes = await readFile(caminho)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  } catch {
    return null
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


