'use client'

import {
  DublaError,
  type DubMode,
  type RecordingClockInfo,
  type ScoreResult,
} from '@dubla/shared'

/**
 * Persistência local das gravações (ADR 0006).
 *
 * Divisão deliberada:
 *   - **OPFS** guarda o áudio. São megabytes por tentativa, e o OPFS é feito
 *     para arquivos — o IndexedDB engasga com blobs grandes em alguns
 *     navegadores.
 *   - **IndexedDB** guarda os metadados, que precisam ser consultáveis por
 *     cena e ordenáveis por tentativa.
 *
 * Os nomes dos campos espelham as colunas de `recordings`/`analyses` em
 * `db/migrations/0001_init.sql`. Na Fase 5 a implementação troca; o tipo que a
 * UI consome, não.
 */

const DB_NAME = 'dublaai'
const DB_VERSION = 1
const ATTEMPTS_STORE = 'attempts'
const BLOBS_STORE = 'blobs'
const RECORDINGS_DIR = 'recordings'

export interface StoredAttempt {
  readonly id: string
  readonly sceneId: string
  readonly attemptNumber: number
  /** Fala que esta tomada cobre, no modo fala-a-fala. Ausente = cena inteira. */
  readonly segmentId?: string
  readonly mode: DubMode
  readonly storageKey: string
  readonly durationMs: number
  readonly sampleRate: number
  readonly clock: RecordingClockInfo
  readonly result: ScoreResult | null
  readonly createdAt: string
}

/**
 * Converte um `IDBRequest` em promessa.
 *
 * O tipo é declarado por quem chama porque a API do IndexedDB devolve
 * `IDBRequest<any>` em quase tudo — a conversão fica concentrada aqui, num
 * lugar só, em vez de espalhada por cada operação.
 */
function promisify<T>(request: IDBRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result as T)
    }
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB falhou'))
    }
  })
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new DublaError('STORAGE_UNAVAILABLE'))
      return
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(ATTEMPTS_STORE)) {
        const store = db.createObjectStore(ATTEMPTS_STORE, { keyPath: 'id' })
        store.createIndex('sceneId', 'sceneId', { unique: false })
      }
      // Só usado quando o OPFS não existe.
      if (!db.objectStoreNames.contains(BLOBS_STORE)) {
        db.createObjectStore(BLOBS_STORE)
      }
    }

    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(new DublaError('STORAGE_UNAVAILABLE', { cause: request.error }))
    }
  })

  return dbPromise
}

function supportsOpfs(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function'
}

async function recordingsDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(RECORDINGS_DIR, { create: true })
}

/**
 * Grava o áudio e os metadados.
 *
 * Quota estourada vira `STORAGE_QUOTA_EXCEEDED` — um erro que a UI sabe
 * explicar e que oferece apagar gravações antigas. O §58 é explícito: nunca
 * simplesmente resetar a gravação do usuário.
 */
export async function saveAttempt(attempt: StoredAttempt, wav: ArrayBuffer): Promise<void> {
  try {
    if (supportsOpfs()) {
      const directory = await recordingsDirectory()
      const handle = await directory.getFileHandle(attempt.storageKey, { create: true })
      const writable = await handle.createWritable()
      await writable.write(wav)
      await writable.close()
    } else {
      const db = await openDatabase()
      const transaction = db.transaction(BLOBS_STORE, 'readwrite')
      await promisify<IDBValidKey>(
        transaction
          .objectStore(BLOBS_STORE)
          .put(new Blob([wav], { type: 'audio/wav' }), attempt.storageKey),
      )
    }

    const db = await openDatabase()
    const transaction = db.transaction(ATTEMPTS_STORE, 'readwrite')
    await promisify<IDBValidKey>(transaction.objectStore(ATTEMPTS_STORE).put(attempt))
  } catch (error) {
    throw toStorageError(error)
  }
}

/** Atualiza só o resultado — a análise termina depois da gravação. */
export async function updateAttemptResult(id: string, result: ScoreResult): Promise<void> {
  try {
    const db = await openDatabase()
    const transaction = db.transaction(ATTEMPTS_STORE, 'readwrite')
    const store = transaction.objectStore(ATTEMPTS_STORE)
    const existing = await promisify<StoredAttempt | undefined>(store.get(id))
    if (!existing) return
    await promisify<IDBValidKey>(store.put({ ...existing, result }))
  } catch (error) {
    throw toStorageError(error)
  }
}

export async function listAttempts(sceneId: string): Promise<StoredAttempt[]> {
  try {
    const db = await openDatabase()
    const transaction = db.transaction(ATTEMPTS_STORE, 'readonly')
    const index = transaction.objectStore(ATTEMPTS_STORE).index('sceneId')
    const attempts = await promisify<StoredAttempt[]>(index.getAll(sceneId))
    return attempts.sort((a, b) => a.attemptNumber - b.attemptNumber)
  } catch {
    // Falha ao listar não pode impedir o usuário de gravar de novo.
    return []
  }
}

/** Object URL do áudio guardado. Quem chama é responsável por revogar (§67). */
export async function loadAudioUrl(attempt: StoredAttempt): Promise<string | null> {
  try {
    if (supportsOpfs()) {
      const directory = await recordingsDirectory()
      const handle = await directory.getFileHandle(attempt.storageKey)
      return URL.createObjectURL(await handle.getFile())
    }

    const db = await openDatabase()
    const transaction = db.transaction(BLOBS_STORE, 'readonly')
    const blob = await promisify<Blob | undefined>(
      transaction.objectStore(BLOBS_STORE).get(attempt.storageKey),
    )
    return blob ? URL.createObjectURL(blob) : null
  } catch {
    return null
  }
}

/**
 * Exclusão real (§42): remove o arquivo e a linha, não só a referência na UI.
 */
export async function deleteAttempt(attempt: StoredAttempt): Promise<void> {
  try {
    if (supportsOpfs()) {
      const directory = await recordingsDirectory()
      await directory.removeEntry(attempt.storageKey).catch(() => undefined)
    } else {
      const db = await openDatabase()
      const transaction = db.transaction(BLOBS_STORE, 'readwrite')
      await promisify<undefined>(transaction.objectStore(BLOBS_STORE).delete(attempt.storageKey))
    }

    const db = await openDatabase()
    const transaction = db.transaction(ATTEMPTS_STORE, 'readwrite')
    await promisify<undefined>(transaction.objectStore(ATTEMPTS_STORE).delete(attempt.id))
  } catch (error) {
    throw toStorageError(error)
  }
}

/** Apaga tudo. É o "excluir histórico" que o §42 exige. */
export async function deleteAllAttempts(): Promise<void> {
  const db = await openDatabase()
  const transaction = db.transaction(ATTEMPTS_STORE, 'readwrite')
  const store = transaction.objectStore(ATTEMPTS_STORE)
  const all = await promisify<StoredAttempt[]>(store.getAll())
  for (const attempt of all) await deleteAttempt(attempt)
}

function toStorageError(error: unknown): DublaError {
  if (error instanceof DublaError) return error
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return new DublaError('STORAGE_QUOTA_EXCEEDED', { cause: error })
  }
  return new DublaError('STORAGE_UNAVAILABLE', { cause: error })
}
