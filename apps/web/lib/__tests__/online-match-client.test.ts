import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const blobClient = vi.hoisted(() => ({
  upload: vi.fn<
    (
      pathname: string,
      body: Blob,
      options: {
        readonly access: string
        readonly clientPayload: string
        readonly contentType: string
        readonly handleUploadUrl: string
      },
    ) => Promise<{ pathname: string }>
  >(),
}))
vi.mock('@vercel/blob/client', () => ({ upload: blobClient.upload }))

import { sendTake } from '../online-match-client'

const CODE = 'ABC123DEF456'
const WAV = new Blob([new Uint8Array([82, 73, 70, 70])], { type: 'audio/wav' })

beforeEach(() => {
  blobClient.upload.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sendTake', () => {
  it('envia o WAV direto ao Blob privado e confirma somente o pathname', async () => {
    blobClient.upload.mockImplementation((pathname: string) => Promise.resolve({ pathname }))
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(Response.json({ state: { code: CODE, players: [], takes: {} } })),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await sendTake(
      CODE,
      {
        segmentId: 'fala-1',
        playerId: 'jogador-1',
        mediaStartOffsetMs: -120.4,
        sampleRate: 48_000,
        wav: WAV,
      },
      'private',
    )

    expect(result.code).toBe(CODE)
    const uploadCall = blobClient.upload.mock.calls[0]
    expect(uploadCall).toBeDefined()
    if (!uploadCall) return
    expect(uploadCall[0]).toMatch(/^partidas\/ABC123DEF456\/fala-1-[a-zA-Z0-9_-]+\.wav$/)
    expect(uploadCall[1]).toBe(WAV)
    expect(uploadCall[2]).toMatchObject({
      access: 'private',
      contentType: 'audio/wav',
      handleUploadUrl: `/api/partidas/${CODE}/tomadas/upload`,
    })
    expect(JSON.parse(uploadCall[2].clientPayload)).toEqual({
      segmentId: 'fala-1',
      playerId: 'jogador-1',
      mediaStartOffsetMs: -120,
      sampleRate: 48_000,
    })

    const confirmCall = fetchMock.mock.calls[0]
    expect(confirmCall).toBeDefined()
    if (!confirmCall) return
    expect(confirmCall[0]).toBe(`/api/partidas/${CODE}/tomadas`)
    expect(confirmCall[1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    const confirmationBody = confirmCall[1]?.body
    expect(typeof confirmationBody).toBe('string')
    if (typeof confirmationBody !== 'string') return
    expect(JSON.parse(confirmationBody)).toMatchObject({
      segmentId: 'fala-1',
      playerId: 'jogador-1',
      mediaStartOffsetMs: -120,
      sampleRate: 48_000,
      pathname: uploadCall[0],
    })
  })

  it('mantém multipart no store de arquivo usado em desenvolvimento', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(Response.json({ state: { code: CODE, players: [], takes: {} } })),
    )
    vi.stubGlobal('fetch', fetchMock)

    await sendTake(
      CODE,
      {
        segmentId: 'fala-1',
        playerId: 'jogador-1',
        mediaStartOffsetMs: 0,
        sampleRate: 48_000,
        wav: WAV,
      },
      'file',
    )

    expect(blobClient.upload).not.toHaveBeenCalled()
    const call = fetchMock.mock.calls[0]
    expect(call).toBeDefined()
    if (!call) return
    expect(call[1]?.body).toBeInstanceOf(FormData)
    const form = call[1]?.body
    if (!(form instanceof FormData)) return
    expect(form.get('segmentId')).toBe('fala-1')
    expect(form.get('audio')).toBeInstanceOf(Blob)
  })

  it('recusa arquivo vazio antes de iniciar qualquer upload', async () => {
    vi.stubGlobal('fetch', vi.fn())
    await expect(
      sendTake(
        CODE,
        {
          segmentId: 'fala-1',
          playerId: 'jogador-1',
          mediaStartOffsetMs: 0,
          sampleRate: 48_000,
          wav: new Blob([], { type: 'audio/wav' }),
        },
        'private',
      ),
    ).rejects.toThrow(/tamanho aceito/i)
    expect(blobClient.upload).not.toHaveBeenCalled()
  })
})
