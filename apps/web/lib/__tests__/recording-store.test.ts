import { afterEach, describe, expect, it, vi } from 'vitest'

interface FakeAttempt {
  readonly id: string
  readonly sceneId: string
  readonly storageKey: string
}

function successfulRequest<T>(result: T): IDBRequest<T> {
  const request = {
    error: null,
    onerror: null,
    onsuccess: null,
    result: undefined,
  } as unknown as IDBRequest<T>

  queueMicrotask(() => {
    Object.defineProperty(request, 'result', {
      configurable: true,
      value: result,
    })
    request.onsuccess?.(new Event('success'))
  })

  return request
}

function fakeIndexedDb(attempts: Map<string, FakeAttempt>, blobs: Map<string, Blob>): IDBFactory {
  const database = {
    transaction: (storeName: string) => ({
      objectStore: () => {
        if (storeName === 'attempts') {
          return {
            delete: (id: string) => {
              attempts.delete(id)
              return successfulRequest(undefined)
            },
            index: () => ({
              getAll: (sceneId: string) =>
                successfulRequest(
                  [...attempts.values()].filter((attempt) => attempt.sceneId === sceneId),
                ),
            }),
          }
        }

        return {
          delete: (storageKey: string) => {
            blobs.delete(storageKey)
            return successfulRequest(undefined)
          },
        }
      },
    }),
  } as unknown as IDBDatabase

  return {
    open: () => {
      const request = {
        error: null,
        onerror: null,
        onsuccess: null,
        onupgradeneeded: null,
        result: database,
      } as unknown as IDBOpenDBRequest
      queueMicrotask(() => {
        request.onsuccess?.(new Event('success'))
      })
      return request
    },
  } as unknown as IDBFactory
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('deleteAttemptsForScene', () => {
  it('remove metadados e áudios somente da cena informada', async () => {
    const attempts = new Map<string, FakeAttempt>([
      ['a-1', { id: 'a-1', sceneId: 'scene-a', storageKey: 'a-1.wav' }],
      ['a-2', { id: 'a-2', sceneId: 'scene-a', storageKey: 'a-2.wav' }],
      ['b-1', { id: 'b-1', sceneId: 'scene-b', storageKey: 'b-1.wav' }],
    ])
    const blobs = new Map([
      ['a-1.wav', new Blob()],
      ['a-2.wav', new Blob()],
      ['b-1.wav', new Blob()],
    ])
    vi.stubGlobal('indexedDB', fakeIndexedDb(attempts, blobs))

    const { deleteAttemptsForScene } = await import('../recording-store')
    await deleteAttemptsForScene('scene-a')

    expect([...attempts.keys()]).toEqual(['b-1'])
    expect([...blobs.keys()]).toEqual(['b-1.wav'])
  })
})
