// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MatchState } from '../../online-match'

interface TokenEvent {
  readonly type: 'blob.generate-client-token'
  readonly payload: {
    readonly pathname: string
    readonly clientPayload: string | null
    readonly multipart: boolean
  }
}

interface HandleUploadInvocation {
  readonly body: TokenEvent
  readonly onBeforeGenerateToken: (
    pathname: string,
    clientPayload: string | null,
  ) => Promise<unknown>
}

type UpdateDecision =
  | { readonly kind: 'commit'; readonly state: MatchState; readonly value: unknown }
  | { readonly kind: 'reject'; readonly value: unknown }

const routeMocks = vi.hoisted(() => ({
  captureTokenOptions: vi.fn<(options: unknown) => void>(),
  handleUpload: vi.fn<(input: HandleUploadInvocation) => Promise<unknown>>(),
  head: vi.fn<
    (pathname: string) => Promise<{
      pathname: string
      size: number
      contentType: string
    }>
  >(),
  putAudio: vi.fn(),
  read: vi.fn<(code: string) => Promise<MatchState | null>>(),
  update:
    vi.fn<(code: string, decide: (state: MatchState) => UpdateDecision) => Promise<unknown>>(),
}))

vi.mock('@vercel/blob/client', () => ({ handleUpload: routeMocks.handleUpload }))
vi.mock('@vercel/blob', () => ({ head: routeMocks.head }))
vi.mock('@/lib/match-code', () => ({ normalizeMatchCode: (code: string) => code }))
vi.mock('@/lib/online-match', () => import('../../online-match'))
vi.mock('@/lib/online-match-media', () => import('../../online-match-media'))
vi.mock('@/lib/server/match-store', () => ({
  MatchStoreUnavailable: class MatchStoreUnavailable extends Error {},
  matchStore: () => ({
    putAudio: routeMocks.putAudio,
    read: routeMocks.read,
    update: routeMocks.update,
  }),
}))

import { POST as confirmTake } from '../../../app/api/partidas/[codigo]/tomadas/route'
import { POST as authorizeTake } from '../../../app/api/partidas/[codigo]/tomadas/upload/route'
import { MAX_TAKE_BYTES } from '../../online-match-media'

const CODE = 'K7M29XQP4TVB'
const PATHNAME = `partidas/${CODE}/s1-9898c8ef-1358-4476-b96b-72cf979467f8.wav`

function context() {
  return { params: Promise.resolve({ codigo: CODE }) }
}

function readyState(overrides: Partial<MatchState> = {}): MatchState {
  const now = Date.now()
  return {
    code: CODE,
    hostId: 'p1',
    storageAccess: 'private',
    videoId: 'video-abc',
    videoName: 'cena.mp4',
    durationMs: 4_000,
    segments: [
      { id: 's1', characterId: 'voz-1', startMs: 0, endMs: 1_500, text: 'Oi' },
      { id: 's2', characterId: 'voz-2', startMs: 2_000, endMs: 3_500, text: 'Olá' },
    ],
    players: [
      {
        id: 'p1',
        name: 'Ana',
        characterId: 'voz-1',
        ready: true,
        lastSeenAt: now,
      },
      {
        id: 'p2',
        name: 'Bia',
        characterId: 'voz-2',
        ready: true,
        lastSeenAt: now,
      },
    ],
    takes: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function tokenRequest(
  pathname = PATHNAME,
  payload: Record<string, unknown> = {
    segmentId: 's1',
    playerId: 'p1',
    mediaStartOffsetMs: -120,
    sampleRate: 48_000,
  },
): Request {
  return new Request(`https://dubla.ai/api/partidas/${CODE}/tomadas/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'blob.generate-client-token',
      payload: {
        pathname,
        clientPayload: JSON.stringify(payload),
        multipart: false,
      },
    } satisfies TokenEvent),
  })
}

function confirmationRequest(
  overrides: Partial<{
    segmentId: string
    playerId: string
    mediaStartOffsetMs: number
    sampleRate: number
    pathname: string
  }> = {},
): Request {
  return new Request(`https://dubla.ai/api/partidas/${CODE}/tomadas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      segmentId: 's1',
      playerId: 'p1',
      mediaStartOffsetMs: -120,
      sampleRate: 48_000,
      pathname: PATHNAME,
      ...overrides,
    }),
  })
}

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error
}

function mockTokenProtocol(): void {
  routeMocks.handleUpload.mockImplementation(async (input) => {
    const options = await input.onBeforeGenerateToken(
      input.body.payload.pathname,
      input.body.payload.clientPayload,
    )
    routeMocks.captureTokenOptions(options)
    return { type: 'blob.generate-client-token', clientToken: 'token-restrito' }
  })
}

afterEach(() => {
  routeMocks.captureTokenOptions.mockReset()
  routeMocks.handleUpload.mockReset()
  routeMocks.head.mockReset()
  routeMocks.putAudio.mockReset()
  routeMocks.read.mockReset()
  routeMocks.update.mockReset()
})

describe('token privado de tomada', () => {
  it('autoriza somente o dono da fala atual e restringe tipo, tamanho e overwrite', async () => {
    mockTokenProtocol()
    routeMocks.read.mockResolvedValue(readyState())

    const response = await authorizeTake(tokenRequest(), context())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      type: 'blob.generate-client-token',
      clientToken: 'token-restrito',
    })
    expect(routeMocks.captureTokenOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedContentTypes: ['audio/wav', 'audio/x-wav', 'audio/wave'],
        maximumSizeInBytes: MAX_TAKE_BYTES,
        addRandomSuffix: false,
        allowOverwrite: false,
      }),
    )
    const options = routeMocks.captureTokenOptions.mock.calls[0]?.[0]
    if (!options || typeof options !== 'object' || !('tokenPayload' in options)) return
    expect(JSON.parse(String(options.tokenPayload))).toMatchObject({
      code: CODE,
      segmentId: 's1',
      playerId: 'p1',
      audioKey: 's1-9898c8ef-1358-4476-b96b-72cf979467f8',
    })
  })

  it.each([
    {
      name: 'jogador errado',
      pathname: PATHNAME,
      payload: { segmentId: 's1', playerId: 'p2', mediaStartOffsetMs: 0, sampleRate: 48_000 },
      error: /outro jogador/i,
    },
    {
      name: 'trecho desconhecido',
      pathname: `partidas/${CODE}/fantasma-chave.wav`,
      payload: {
        segmentId: 'fantasma',
        playerId: 'p1',
        mediaStartOffsetMs: 0,
        sampleRate: 48_000,
      },
      error: /desconhecido/i,
    },
    {
      name: 'fala futura fora da vez',
      pathname: `partidas/${CODE}/s2-chave.wav`,
      payload: { segmentId: 's2', playerId: 'p2', mediaStartOffsetMs: 0, sampleRate: 48_000 },
      error: /ainda não está na vez/i,
    },
    {
      name: 'pathname de outra partida',
      pathname: 'partidas/OUTRA/s1-chave.wav',
      payload: { segmentId: 's1', playerId: 'p1', mediaStartOffsetMs: 0, sampleRate: 48_000 },
      error: /destino/i,
    },
  ])('recusa $name', async ({ pathname, payload, error }) => {
    mockTokenProtocol()
    routeMocks.read.mockResolvedValue(readyState())

    const response = await authorizeTake(tokenRequest(pathname, payload), context())

    expect(response.status).toBe(400)
    expect(await errorOf(response)).toMatch(error)
    expect(routeMocks.captureTokenOptions).not.toHaveBeenCalled()
  })
})

describe('confirmação do Blob da tomada', () => {
  it('valida head e grava a URL autorizada por CAS', async () => {
    let current = readyState()
    routeMocks.read.mockImplementation(() => Promise.resolve(current))
    routeMocks.head.mockResolvedValue({
      pathname: PATHNAME,
      size: 4_096,
      contentType: 'audio/wav',
    })
    routeMocks.update.mockImplementation((_code, decide) => {
      const decision = decide(current)
      if (decision.kind === 'reject') {
        return Promise.resolve({
          found: true,
          committed: false,
          state: current,
          value: decision.value,
        })
      }
      current = decision.state
      return Promise.resolve({
        found: true,
        committed: true,
        state: current,
        value: decision.value,
        write: { access: 'private', etag: 'estado-2' },
      })
    })

    const first = await confirmTake(confirmationRequest(), context())

    expect(first.status).toBe(200)
    expect(routeMocks.head).toHaveBeenCalledWith(PATHNAME)
    expect(current.takes['s1']).toEqual({
      playerId: 'p1',
      url: `/api/partidas/${CODE}/audio/s1-9898c8ef-1358-4476-b96b-72cf979467f8`,
      mediaStartOffsetMs: -120,
      sampleRate: 48_000,
    })

    const replay = await confirmTake(confirmationRequest(), context())
    expect(replay.status).toBe(409)
    expect(await errorOf(replay)).toMatch(/já foi gravado/i)
    expect(routeMocks.head).toHaveBeenCalledTimes(1)
  })

  it.each([
    {
      name: 'pathname retornado diferente',
      head: { pathname: `${PATHNAME}-outro`, size: 100, contentType: 'audio/wav' },
      status: 413,
      error: /tamanho aceito/i,
    },
    {
      name: 'arquivo vazio',
      head: { pathname: PATHNAME, size: 0, contentType: 'audio/wav' },
      status: 413,
      error: /tamanho aceito/i,
    },
    {
      name: 'arquivo grande demais',
      head: { pathname: PATHNAME, size: MAX_TAKE_BYTES + 1, contentType: 'audio/wav' },
      status: 413,
      error: /tamanho aceito/i,
    },
    {
      name: 'MIME que não é WAV',
      head: { pathname: PATHNAME, size: 100, contentType: 'audio/mpeg' },
      status: 415,
      error: /não é um WAV/i,
    },
  ])('recusa $name antes do CAS', async ({ head, status, error }) => {
    routeMocks.read.mockResolvedValue(readyState())
    routeMocks.head.mockResolvedValue(head)

    const response = await confirmTake(confirmationRequest(), context())

    expect(response.status).toBe(status)
    expect(await errorOf(response)).toMatch(error)
    expect(routeMocks.update).not.toHaveBeenCalled()
  })

  it('recusa pathname fora do trecho sem consultar o Blob', async () => {
    const response = await confirmTake(
      confirmationRequest({ pathname: `partidas/${CODE}/s2-chave.wav` }),
      context(),
    )

    expect(response.status).toBe(400)
    expect(await errorOf(response)).toMatch(/fora desta partida ou trecho/i)
    expect(routeMocks.read).not.toHaveBeenCalled()
    expect(routeMocks.head).not.toHaveBeenCalled()
  })

  it('transforma replay concorrente recusado pelo CAS em conflito', async () => {
    const before = readyState()
    routeMocks.read.mockResolvedValue(before)
    routeMocks.head.mockResolvedValue({
      pathname: PATHNAME,
      size: 100,
      contentType: 'audio/wav',
    })
    routeMocks.update.mockImplementation((_code, decide) => {
      const fresh = readyState({
        takes: {
          s1: {
            playerId: 'p1',
            url: '/fala-que-ganhou-a-corrida',
            mediaStartOffsetMs: 0,
            sampleRate: 48_000,
          },
        },
      })
      const decision = decide(fresh)
      if (decision.kind !== 'reject') throw new Error('O CAS deveria recusar o replay.')
      return Promise.resolve({
        found: true,
        committed: false,
        state: fresh,
        value: decision.value,
      })
    })

    const response = await confirmTake(confirmationRequest(), context())

    expect(response.status).toBe(409)
    expect(await errorOf(response)).toMatch(/já foi gravado/i)
  })
})
