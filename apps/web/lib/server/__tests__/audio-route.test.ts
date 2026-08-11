// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'

const routeMocks = vi.hoisted(() => ({
  isExpired: vi.fn(),
  read: vi.fn(),
  readAudio: vi.fn(),
}))

vi.mock('@/lib/match-code', () => ({ normalizeMatchCode: (code: string) => code }))
vi.mock('@/lib/online-match', () => ({ isExpired: routeMocks.isExpired }))
vi.mock('@/lib/server/match-store', () => ({
  MatchStoreUnavailable: class MatchStoreUnavailable extends Error {},
  matchStore: () => ({ read: routeMocks.read, readAudio: routeMocks.readAudio }),
}))

import { GET } from '../../../app/api/partidas/[codigo]/audio/[trecho]/route'

const CODE = 'K7M29XQP4TVB'
const TAKE = 's1-chave'
const URL = `/api/partidas/${CODE}/audio/${TAKE}`

function context() {
  return { params: Promise.resolve({ codigo: CODE, trecho: TAKE }) }
}

function authorizedState() {
  return {
    createdAt: 1,
    takes: { s1: { url: URL } },
  }
}

afterEach(() => {
  routeMocks.isExpired.mockReset()
  routeMocks.read.mockReset()
  routeMocks.readAudio.mockReset()
})

describe('GET da tomada online', () => {
  it('repassa a stream do Blob com tamanho, ETag e cache privado', async () => {
    routeMocks.isExpired.mockReturnValue(false)
    routeMocks.read.mockResolvedValue(authorizedState())
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([82, 73, 70, 70]))
        controller.close()
      },
    })
    routeMocks.readAudio.mockResolvedValue({
      kind: 'stream',
      stream,
      contentLength: 4,
      etag: 'etag-da-tomada',
    })

    const response = await GET(new Request(`https://dubla.ai${URL}`), context())

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/wav')
    expect(response.headers.get('content-length')).toBe('4')
    expect(response.headers.get('etag')).toBe('etag-da-tomada')
    expect(response.headers.get('cache-control')).toBe('private, max-age=3600')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([82, 73, 70, 70])
  })

  it('preserva o fallback local em bytes sem inventar ETag', async () => {
    routeMocks.isExpired.mockReturnValue(false)
    routeMocks.read.mockResolvedValue(authorizedState())
    routeMocks.readAudio.mockResolvedValue({
      kind: 'bytes',
      bytes: new Uint8Array([1, 2, 3]).buffer,
      contentLength: 3,
    })

    const response = await GET(new Request(`http://localhost${URL}`), context())

    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('3')
    expect(response.headers.get('etag')).toBeNull()
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3])
  })

  it('não lê o Blob quando a partida expirou ou não autorizou aquela URL', async () => {
    routeMocks.read.mockResolvedValue(authorizedState())
    routeMocks.isExpired.mockReturnValue(true)

    const expired = await GET(new Request(`https://dubla.ai${URL}`), context())
    expect(expired.status).toBe(404)
    expect(routeMocks.readAudio).not.toHaveBeenCalled()

    routeMocks.isExpired.mockReturnValue(false)
    routeMocks.read.mockResolvedValue({ createdAt: 1, takes: { s1: { url: '/outra' } } })
    const unauthorized = await GET(new Request(`https://dubla.ai${URL}`), context())
    expect(unauthorized.status).toBe(404)
    expect(routeMocks.readAudio).not.toHaveBeenCalled()
  })
})
