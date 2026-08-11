// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MatchState } from '@/lib/online-match'

vi.mock('server-only', () => ({}))
const blobMocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }))
vi.mock('@vercel/blob', () => ({
  BlobNotFoundError: class BlobNotFoundError extends Error {},
  get: blobMocks.get,
  put: blobMocks.put,
}))

import { matchStore } from '../match-store'

const CODE = 'K7M29XQP4TVB'

function initialState(): MatchState {
  return {
    code: CODE,
    videoId: 'video-abc',
    videoName: 'cena.mp4',
    durationMs: 10_000,
    segments: [],
    players: [],
    takes: {},
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  }
}

describe('MatchStore local', () => {
  let directory = ''

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dubla-match-store-'))
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', '')
    vi.stubEnv('DUBLA_MATCH_DIR', directory)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
  })

  it('expõe que a escrita usou o disco', async () => {
    const receipt = await matchStore().write(initialState())

    expect(receipt).toEqual({ access: 'file', etag: null })
  })

  it('não grava uma decisão rejeitada', async () => {
    const store = matchStore()
    await store.write(initialState())

    const result = await store.update(CODE, () => ({ kind: 'reject', value: 'sem vez' }))

    expect(result).toMatchObject({ found: true, committed: false, value: 'sem vez' })
    expect((await store.read(CODE))?.durationMs).toBe(10_000)
  })

  it('serializa mutações concorrentes sem perder incremento', async () => {
    const store = matchStore()
    await store.write(initialState())

    await Promise.all(
      Array.from({ length: 20 }, async () => {
        await store.update(CODE, (state) => ({
          kind: 'commit',
          state: {
            ...state,
            durationMs: state.durationMs + 1,
            updatedAt: state.updatedAt + 1,
          },
          value: null,
        }))
      }),
    )

    expect((await store.read(CODE))?.durationMs).toBe(10_020)
  })

  it('mantém o fallback de áudio em bytes no disco local', async () => {
    const store = matchStore()
    const source = new Uint8Array([82, 73, 70, 70]).buffer

    expect(await store.putAudio(CODE, 's1-chave', source)).toBe(
      `/api/partidas/${CODE}/audio/s1-chave`,
    )
    const audio = await store.readAudio(CODE, 's1-chave')

    expect(audio).toMatchObject({ kind: 'bytes', contentLength: 4 })
    if (audio?.kind !== 'bytes') return
    expect([...new Uint8Array(audio.bytes)]).toEqual([82, 73, 70, 70])
  })
})

describe('MatchStore no Vercel Blob', () => {
  afterEach(() => {
    blobMocks.get.mockReset()
    blobMocks.put.mockReset()
    vi.unstubAllEnvs()
  })

  it('recusa store público em vez de usar estado mutável com cache antigo', async () => {
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'token-do-teste')
    vi.stubEnv('DUBLA_MATCH_DIR', '')
    blobMocks.put.mockRejectedValueOnce(new Error('Cannot use private access on a public store'))

    await expect(matchStore().write(initialState())).rejects.toThrow(/Blob privado/i)
    expect(blobMocks.put).toHaveBeenCalledTimes(1)
    expect(blobMocks.put).toHaveBeenCalledWith(
      `partidas/${CODE}/estado.json`,
      expect.any(String),
      expect.objectContaining({ access: 'private' }),
    )
  })

  it('devolve a stream privada do Blob sem convertê-la em arrayBuffer', async () => {
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'token-do-teste')
    vi.stubEnv('DUBLA_MATCH_DIR', '')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([82, 73, 70, 70]))
        controller.close()
      },
    })
    blobMocks.get.mockResolvedValueOnce({
      statusCode: 200,
      stream,
      blob: { size: 4, etag: 'etag-da-tomada' },
    })

    const audio = await matchStore().readAudio(CODE, 's1-chave')

    expect(blobMocks.get).toHaveBeenCalledWith(`partidas/${CODE}/s1-chave.wav`, {
      access: 'private',
      useCache: false,
    })
    expect(audio).toEqual({
      kind: 'stream',
      stream,
      contentLength: 4,
      etag: 'etag-da-tomada',
    })
  })
})
