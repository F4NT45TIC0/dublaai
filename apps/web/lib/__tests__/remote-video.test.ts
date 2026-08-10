import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadRemoteVideo, validateRemoteVideoUrl } from '../remote-video'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('URL direta de vídeo', () => {
  it('aceita HTTPS e localhost, inclusive URL assinada', () => {
    expect(validateRemoteVideoUrl('https://cdn.example.com/cena.mp4?token=segredo')).toBeNull()
    expect(validateRemoteVideoUrl('http://localhost:4100/cena.webm')).toBeNull()
  })

  it('recusa páginas conhecidas, credenciais, HTTP remoto e playlists', () => {
    expect(validateRemoteVideoUrl('https://youtube.com/watch?v=abc')).toContain('não são arquivos')
    expect(validateRemoteVideoUrl('https://user:secret@example.com/cena.mp4')).toContain(
      'usuário ou senha',
    )
    expect(validateRemoteVideoUrl('http://example.com/cena.mp4')).toContain('Use uma URL HTTPS')
    expect(validateRemoteVideoUrl('https://cdn.example.com/live.m3u8')).toContain('HLS/DASH')
  })

  it('baixa uma resposta de vídeo como File sem enviar credenciais', async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response(new Uint8Array([0, 1, 2, 3]).buffer, {
          headers: { 'content-type': 'video/mp4', 'content-length': '4' },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const file = await downloadRemoteVideo('https://cdn.example.com/minha-cena.mp4')

    expect(file.name).toBe('minha-cena.mp4')
    expect(file.type).toBe('video/mp4')
    expect(file.size).toBe(4)
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ credentials: 'omit', mode: 'cors', referrerPolicy: 'no-referrer' }),
    )
  })

  it('recusa HTML mesmo quando a requisição responde com sucesso', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Promise.resolve(
          new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
        ),
      ),
    )

    await expect(downloadRemoteVideo('https://example.com/watch/123')).rejects.toThrow(
      'página ou playlist',
    )
  })
})
