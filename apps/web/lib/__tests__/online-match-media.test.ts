import { describe, expect, it } from 'vitest'
import {
  audioKeyFromTakePathname,
  isWavContentType,
  MAX_TAKE_BYTES,
  safeTakeSegmentId,
  takeAudioKey,
  takeBlobPathname,
} from '../online-match-media'

describe('mídia de uma tomada online', () => {
  it('mantém o limite em 32 MB e reconhece apenas MIME de WAV', () => {
    expect(MAX_TAKE_BYTES).toBe(32 * 1024 * 1024)
    expect(isWavContentType('audio/wav')).toBe(true)
    expect(isWavContentType('audio/x-wav; charset=binary')).toBe(true)
    expect(isWavContentType('audio/mpeg')).toBe(false)
  })

  it('gera um caminho imutável que a rota de áudio consegue resolver', () => {
    const key = takeAudioKey('fala:01', '9898c8ef-1358-4476-b96b-72cf979467f8')
    expect(key).toBe('fala01-9898c8ef-1358-4476-b96b-72cf979467f8')
    if (!key) return

    const pathname = takeBlobPathname('ABC123', key)
    expect(pathname).toBe('partidas/ABC123/fala01-9898c8ef-1358-4476-b96b-72cf979467f8.wav')
    expect(audioKeyFromTakePathname('ABC123', 'fala:01', pathname ?? '')).toBe(key)
  })

  it('recusa travessia, outra partida, outro trecho e identificador vazio', () => {
    expect(safeTakeSegmentId('../')).toBeNull()
    expect(takeAudioKey('s1', '../arquivo')).toBeNull()
    expect(takeBlobPathname('../', 's1-chave')).toBeNull()
    expect(audioKeyFromTakePathname('ABC123', 's1', 'partidas/OUTRA/s1-chave.wav')).toBeNull()
    expect(audioKeyFromTakePathname('ABC123', 's1', 'partidas/ABC123/s2-chave.wav')).toBeNull()
    expect(audioKeyFromTakePathname('ABC123', 's1', 'partidas/ABC123/sub/s1-chave.wav')).toBeNull()
  })
})
