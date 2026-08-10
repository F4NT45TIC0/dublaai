import { describe, expect, it } from 'vitest'
import {
  createLocalVideoId,
  downloadableBaseName,
  validateLocalVideoFile,
  validateLocalVideoMetadata,
} from '../local-video'

describe('validação do vídeo local', () => {
  it('aceita exatamente 60 segundos', () => {
    expect(
      validateLocalVideoMetadata({ durationMs: 60_000, width: 1_920, height: 1_080 }),
    ).toBeNull()
  })

  it('recusa qualquer duração acima de 60 segundos', () => {
    expect(
      validateLocalVideoMetadata({ durationMs: 60_001, width: 1_920, height: 1_080 }),
    ).toBe('O vídeo precisa ter no máximo 1 minuto.')
  })

  it('recusa arquivo vazio e conteúdo declarado como não-vídeo', () => {
    expect(validateLocalVideoFile({ size: 0, type: 'video/mp4' })).toBe(
      'O arquivo de vídeo está vazio.',
    )
    expect(validateLocalVideoFile({ size: 100, type: 'text/plain' })).toBe(
      'Escolha um arquivo de vídeo válido.',
    )
  })

  it('recusa arquivo acima do limite de memória do navegador', () => {
    expect(validateLocalVideoFile({ size: 250 * 1024 * 1024 + 1, type: 'video/mp4' })).toBe(
      'O vídeo precisa ter no máximo 250 MB.',
    )
  })

  it('gera uma chave estável que distingue arquivos com conteúdo diferente', async () => {
    const firstFile = new File(['conteudo-a'], 'cena.mp4', { lastModified: 123 })
    const repeatedFile = new File(['conteudo-a'], 'cena.mp4', { lastModified: 123 })
    const secondFile = new File(['conteudo-b'], 'cena.mp4', { lastModified: 123 })
    const first = await createLocalVideoId(firstFile, 4_000)
    const repeated = await createLocalVideoId(repeatedFile, 4_000)
    const second = await createLocalVideoId(secondFile, 4_000)

    expect(first).toBe(repeated)
    expect(first).not.toBe(second)
  })

  it('cria um nome de download seguro e legível', () => {
    expect(downloadableBaseName('Minha cena incrível.mov')).toBe('Minha-cena-incrivel')
    expect(downloadableBaseName('...')).toBe('minha-cena')
  })
})
