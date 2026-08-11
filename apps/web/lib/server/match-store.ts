import 'server-only'

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MatchState } from '@/lib/online-match'

export type MatchStoreAccess = 'private' | 'public' | 'file'

/** Comprovante da escrita; o chamador pode repassar o modo do Blob ao cliente. */
export interface MatchStoreWriteResult {
  readonly access: MatchStoreAccess
  /** Ausente no disco local, que serializa mutações por processo em vez de CAS. */
  readonly etag: string | null
}

/**
 * Decisão pura tomada em cima da versão mais recente do estado.
 *
 * No Blob ela pode ser chamada novamente quando outra Function ganhar a corrida
 * do `ifMatch`; por isso não deve fazer upload, log externo nem outro efeito.
 */
export type MatchUpdateDecision<T> =
  | { readonly kind: 'commit'; readonly state: MatchState; readonly value: T }
  | { readonly kind: 'reject'; readonly value: T }

export type MatchUpdateResult<T> =
  | { readonly found: false }
  | {
      readonly found: true
      readonly committed: false
      readonly state: MatchState
      readonly value: T
    }
  | {
      readonly found: true
      readonly committed: true
      readonly state: MatchState
      readonly value: T
      readonly write: MatchStoreWriteResult
    }

/** Fonte do WAV sem obrigar produção a materializar o arquivo inteiro em memória. */
export type MatchAudioRead =
  | {
      readonly kind: 'stream'
      readonly stream: ReadableStream<Uint8Array>
      readonly contentLength: number
      readonly etag: string
    }
  | {
      readonly kind: 'bytes'
      readonly bytes: ArrayBuffer
      readonly contentLength: number
    }

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
  write(state: MatchState): Promise<MatchStoreWriteResult>
  /** Lê, decide e grava sem perder uma atualização concorrente. */
  update<T>(
    code: string,
    decide: (state: MatchState) => MatchUpdateDecision<T>,
  ): Promise<MatchUpdateResult<T>>
  /** Guarda o WAV da tomada e devolve a URL de onde ele pode ser ouvido. */
  putAudio(code: string, segmentId: string, bytes: ArrayBuffer): Promise<string>
  /** Devolve o WAV guardado, em stream no Blob e em bytes no disco local. */
  readAudio(code: string, segmentId: string): Promise<MatchAudioRead | null>
  /** Guarda o vídeo da partida, para quem entrar depois baixar. */
  putVideo(code: string, bytes: ArrayBuffer): Promise<void>
  readVideo(code: string): Promise<ArrayBuffer | null>
}

export class MatchStoreUnavailable extends Error {
  constructor(message?: string) {
    super(
      message ??
        'O modo online precisa de um Blob store da Vercel. Crie um em Storage → Blob no projeto ' +
          'e conecte-o; a variável BLOB_READ_WRITE_TOKEN aparece sozinha depois disso.',
    )
    this.name = 'MatchStoreUnavailable'
  }
}

export class MatchStoreConflict extends Error {
  constructor() {
    super('A partida mudou muitas vezes ao mesmo tempo. Tente novamente.')
    this.name = 'MatchStoreConflict'
  }
}

/* ------------------------------------------------------------------ Blob */

/**
 * O estado vivo exige um store privado. Só nele `useCache: false` oferece a
 * leitura consistente necessária para o CAS; um store público pode devolver a
 * versão anterior por até um minuto e perderia join, ready ou tomada.
 */
type BlobAccess = Exclude<MatchStoreAccess, 'file'>

let blobAccess: BlobAccess | null = null

interface DetectedBlobWrite<T> {
  readonly access: BlobAccess
  readonly result: T
}

function isWrongAccessError(cause: unknown): boolean {
  return cause instanceof Error && /access on a (private|public) store/i.test(cause.message)
}

async function putWithDetectedAccess<T>(
  write: (access: BlobAccess) => Promise<T>,
): Promise<DetectedBlobWrite<T>> {
  if (blobAccess === 'public') {
    throw new MatchStoreUnavailable(
      'As partidas precisam de um Vercel Blob privado. O store conectado é público; crie um store Private em Storage → Blob, conecte-o ao projeto e faça um novo deploy.',
    )
  }
  if (blobAccess) return { access: blobAccess, result: await write(blobAccess) }
  try {
    const result = await write('private')
    blobAccess = 'private'
    return { access: 'private', result }
  } catch (cause) {
    if (!isWrongAccessError(cause)) throw cause
    blobAccess = 'public'
    throw new MatchStoreUnavailable(
      'As partidas precisam de um Vercel Blob privado. O store conectado é público; crie um store Private em Storage → Blob, conecte-o ao projeto e faça um novo deploy.',
    )
  }
}

interface BlobStateSnapshot {
  readonly state: MatchState
  readonly etag: string
  readonly access: BlobAccess
}

const STATE_CACHE_SECONDS = 60
const MAX_UPDATE_ATTEMPTS = 6

function accessFromBlobUrl(url: string): BlobAccess {
  return new URL(url).hostname.includes('.private.blob.') ? 'private' : 'public'
}

async function parseStateStream(stream: ReadableStream<Uint8Array>): Promise<MatchState> {
  return (await new Response(stream).json()) as MatchState
}

async function waitBeforeUpdateRetry(attempt: number): Promise<void> {
  const delayMs = 5 * 2 ** attempt
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs)
  })
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

  /**
   * O estado é o único Blob mutável da partida. `useCache: false` é obrigatório:
   * `cache: no-store` num `fetch` comum não fura o cache de origem do Blob.
   */
  const readSnapshot = async (code: string): Promise<BlobStateSnapshot | null> => {
    const { BlobNotFoundError, get, head } = await import('@vercel/blob')
    const pathname = statePath(code)

    try {
      let access = blobAccess
      let source = pathname

      // `get` exige o access. Numa Function fria ainda não houve escrita para
      // descobri-lo; `head` resolve a URL e o hostname revela o modo do store.
      if (!access) {
        const meta = await head(pathname)
        access = accessFromBlobUrl(meta.url)
        if (access === 'public') {
          blobAccess = access
          throw new MatchStoreUnavailable(
            'As partidas precisam de um Vercel Blob privado. O store conectado é público; crie um store Private em Storage → Blob, conecte-o ao projeto e faça um novo deploy.',
          )
        }
        blobAccess = access
        source = meta.url
      }

      const stored = await get(source, { access, useCache: false })
      if (stored?.statusCode !== 200) return null
      return {
        state: await parseStateStream(stored.stream),
        etag: stored.blob.etag,
        access,
      }
    } catch (cause) {
      // Falha de rede/configuração não pode se fantasiar de partida inexistente.
      if (cause instanceof BlobNotFoundError) return null
      throw cause
    }
  }

  const writeState = async (
    state: MatchState,
    ifMatch?: string,
  ): Promise<MatchStoreWriteResult> => {
    const { put } = await import('@vercel/blob')
    const stored = await putWithDetectedAccess(
      async (access) =>
        await put(statePath(state.code), JSON.stringify(state), {
          access,
          contentType: 'application/json',
          // Sem isto o SDK acrescenta um sufixo aleatório e o próximo `read`
          // não encontraria o estado que acabou de ser gravado.
          addRandomSuffix: false,
          allowOverwrite: true,
          // O SDK não aceita menos de um minuto. Leituras de estado usam
          // `useCache: false`, então ainda enxergam a escrita imediatamente.
          cacheControlMaxAge: STATE_CACHE_SECONDS,
          ...(ifMatch === undefined ? {} : { ifMatch }),
        }),
    )
    return { access: stored.access, etag: stored.result.etag }
  }

  return {
    async read(code) {
      return (await readSnapshot(code))?.state ?? null
    },

    async write(state) {
      return await writeState(state)
    },

    async update<T>(code: string, decide: (state: MatchState) => MatchUpdateDecision<T>) {
      const { BlobPreconditionFailedError } = await import('@vercel/blob')

      for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt += 1) {
        const snapshot = await readSnapshot(code)
        if (!snapshot) return { found: false }

        const decision = decide(snapshot.state)
        if (decision.kind === 'reject') {
          return {
            found: true,
            committed: false,
            state: snapshot.state,
            value: decision.value,
          }
        }
        if (decision.state.code !== code) {
          throw new Error('Uma mutação de partida não pode trocar o código armazenado.')
        }

        try {
          const write = await writeState(decision.state, snapshot.etag)
          return {
            found: true,
            committed: true,
            state: decision.state,
            value: decision.value,
            write,
          }
        } catch (cause) {
          if (!(cause instanceof BlobPreconditionFailedError)) throw cause
          if (attempt === MAX_UPDATE_ATTEMPTS - 1) throw new MatchStoreConflict()
          await waitBeforeUpdateRetry(attempt)
        }
      }

      // O laço sempre retorna ou lança; mantém o controle de fluxo explícito.
      throw new MatchStoreConflict()
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
      const { BlobNotFoundError, get } = await import('@vercel/blob')
      try {
        const stored = await get(audioPath(code, segmentId), {
          // O estado da partida já recusa stores públicos. Manter o access
          // explícito impede uma URL de voz acessível sem a nossa rota.
          access: 'private',
          useCache: false,
        })
        if (stored?.statusCode !== 200) return null
        return {
          kind: 'stream',
          stream: stored.stream,
          contentLength: stored.blob.size,
          etag: stored.blob.etag,
        }
      } catch (cause) {
        if (cause instanceof BlobNotFoundError) return null
        throw cause
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
 * O file store só é permitido num processo, mas duas requisições desse processo
 * ainda podem intercalar `read` e `write`. A fila por código dá a ele a mesma
 * semântica de `update` que o CAS fornece no Blob.
 */
const fileUpdateQueues = new Map<string, Promise<void>>()

async function withFileUpdateLock<T>(code: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileUpdateQueues.get(code) ?? Promise.resolve()
  let release: (() => void) | undefined
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(async () => {
    await current
  })
  fileUpdateQueues.set(code, tail)

  await previous
  try {
    return await operation()
  } finally {
    release?.()
    if (fileUpdateQueues.get(code) === tail) fileUpdateQueues.delete(code)
  }
}

/**
 * Só para desenvolvimento: `next dev` é um processo só, então o disco funciona
 * como armazenamento compartilhado entre as duas abas. Isso permite exercitar
 * a partida inteira na máquina, sem depender de nuvem nenhuma.
 */
function fileStore(): MatchStore {
  const dir = matchDirectory

  const readState = async (code: string): Promise<MatchState | null> => {
    try {
      const raw = await readFile(join(dir(code), 'estado.json'), 'utf8')
      return JSON.parse(raw) as MatchState
    } catch {
      return null
    }
  }

  const writeState = async (state: MatchState): Promise<MatchStoreWriteResult> => {
    await mkdir(dir(state.code), { recursive: true })
    await writeFile(join(dir(state.code), 'estado.json'), JSON.stringify(state), 'utf8')
    return { access: 'file', etag: null }
  }

  return {
    async read(code) {
      return await readState(code)
    },

    async write(state) {
      return await writeState(state)
    },

    async update<T>(code: string, decide: (state: MatchState) => MatchUpdateDecision<T>) {
      return await withFileUpdateLock(code, async () => {
        const state = await readState(code)
        if (!state) return { found: false }

        const decision = decide(state)
        if (decision.kind === 'reject') {
          return {
            found: true,
            committed: false,
            state,
            value: decision.value,
          }
        }
        if (decision.state.code !== code) {
          throw new Error('Uma mutação de partida não pode trocar o código armazenado.')
        }

        const write = await writeState(decision.state)
        return {
          found: true,
          committed: true,
          state: decision.state,
          value: decision.value,
          write,
        }
      })
    },

    async putAudio(code, segmentId, bytes) {
      await mkdir(dir(code), { recursive: true })
      await writeFile(join(dir(code), `${segmentId}.wav`), Buffer.from(bytes))
      return `/api/partidas/${code}/audio/${segmentId}`
    },

    async readAudio(code, segmentId) {
      const bytes = await lerArquivo(join(dir(code), `${segmentId}.wav`))
      return bytes ? { kind: 'bytes', bytes, contentLength: bytes.byteLength } : null
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

function matchDirectory(code: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(code)) {
    throw new Error('O código da partida não pode formar um caminho no disco.')
  }

  const configuredRoot = process.env['DUBLA_MATCH_DIR']
  if (configuredRoot) {
    // Raiz explícita de teste/local: não é um asset que deva entrar no deploy.
    return join(/*turbopackIgnore: true*/ configuredRoot, code)
  }

  // Manter o prefixo estático impede o tracer de incluir o projeto inteiro.
  return join(process.cwd(), '.dubla-partidas', code)
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
