import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const VALID_VIDEO = resolve(import.meta.dirname, 'fixtures/video-with-reference-audio.mp4')

/**
 * Partida online entre dois navegadores.
 *
 * Dois contextos separados são o ponto do teste: sessões diferentes, storages
 * diferentes, exatamente como dois aparelhos. Um único contexto compartilharia
 * o localStorage e os dois "jogadores" teriam o mesmo id — o teste passaria sem
 * exercitar nada do que importa.
 */
async function abrirVideo(page: Page): Promise<void> {
  await page.goto('/enviar')
  await page.getByTestId('local-video-input').setInputFiles(VALID_VIDEO)
  await expect(page.getByRole('heading', { name: 'video-with-reference-audio.mp4' })).toBeVisible({
    timeout: 60_000,
  })
  await page.getByTestId('local-take-mode-online').click()
}

test.describe('partida online', () => {
  test('dois aparelhos revezam as falas pelo código da partida', async ({ browser }) => {
    const anfitriao = await browser.newContext()
    const convidado = await browser.newContext()
    const paginaA = await anfitriao.newPage()
    const paginaB = await convidado.newPage()

    try {
      await abrirVideo(paginaA)
      await paginaA.getByTestId('online-criar').click()
      await expect(paginaA.getByTestId('online-escolher-personagem')).toBeVisible({
        timeout: 30_000,
      })

      // O código mostrado é o que a pessoa manda para o amigo.
      const titulo = await paginaA.getByTestId('online-escolher-personagem').innerText()
      const codigo = /([0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4})/.exec(
        titulo,
      )?.[1]
      expect(codigo).toBeDefined()

      await paginaA.getByTestId('online-apelido').fill('Ana')
      await paginaA.getByTestId('online-personagem-voz-1').click()
      await paginaA.getByTestId('online-confirmar-personagem').click()
      await expect(paginaA.getByTestId('online-aguardando-dupla')).toBeVisible({ timeout: 30_000 })

      // Segundo aparelho entra pelo código, com o mesmo arquivo de vídeo.
      await abrirVideo(paginaB)
      await paginaB.getByTestId('online-codigo').fill(codigo ?? '')
      await paginaB.getByTestId('online-entrar-codigo').click()
      await expect(paginaB.getByTestId('online-escolher-personagem')).toBeVisible({
        timeout: 30_000,
      })

      // A voz da Ana não aparece mais na lista: personagem tomado é tomado.
      await expect(paginaB.getByTestId('online-personagem-voz-1')).toHaveCount(0)
      await paginaB.getByTestId('online-apelido').fill('Bia')
      await paginaB.getByTestId('online-personagem-voz-2').click()
      await paginaB.getByTestId('online-confirmar-personagem').click()

      // Sem recarregar: o anfitrião descobre sozinho que a dupla se formou.
      await expect(paginaA.getByTestId('online-turno')).toContainText('Bia', { timeout: 30_000 })

      // Exatamente um dos dois está na vez, e só ele vê o botão de gravar.
      const vezDeA = await paginaA.getByTestId('online-minha-vez').count()
      const vezDeB = await paginaB.getByTestId('online-minha-vez').count()
      expect(vezDeA + vezDeB).toBe(1)

      const daVez = vezDeA === 1 ? paginaA : paginaB
      const parado = vezDeA === 1 ? paginaB : paginaA
      await expect(daVez.getByTestId('local-start-dub')).toBeVisible()
      await expect(parado.getByTestId('local-start-dub')).toHaveCount(0)

      // Quem está na vez grava e envia; a vez passa para o outro aparelho.
      await daVez.getByTestId('local-start-dub').click()
      await expect(daVez.getByTestId('online-enviar-fala')).toBeVisible({ timeout: 40_000 })
      await daVez.getByTestId('online-enviar-fala').click()

      await expect(parado.getByTestId('online-minha-vez')).toBeVisible({ timeout: 30_000 })
      await expect(daVez.getByTestId('online-vez-do-outro')).toBeVisible({ timeout: 30_000 })

      // A fala gravada num aparelho chega ao outro para ser ouvida.
      await expect(parado.getByTestId('stitched-playback')).toContainText('1 fala montada')
    } finally {
      await anfitriao.close()
      await convidado.close()
    }
  })

  test('o vídeo viaja com a partida: só um dos dois precisa ter o arquivo', async ({
    request,
  }) => {
    const criada = await request.post('/api/partidas', {
      data: {
        videoId: 'video-do-anfitriao',
        videoName: 'cena.mp4',
        durationMs: 10_000,
        segments: [
          { id: 's1', characterId: 'voz-1', startMs: 0, endMs: 2_000, text: 'a' },
          { id: 's2', characterId: 'voz-2', startMs: 2_500, endMs: 4_000, text: 'b' },
        ],
      },
    })
    expect(criada.ok()).toBe(true)
    const { code } = (await criada.json()) as { code: string }

    // Sem vídeo guardado, chegar com outro arquivo continua sendo recusado:
    // seria dublar cenas diferentes achando que é a mesma.
    const semVideo = await request.post(`/api/partidas/${code}`, {
      data: { playerId: 'intruso', name: 'Intruso', characterId: 'voz-2', videoId: 'outro' },
    })
    expect(semVideo.status()).toBe(409)
    expect(await semVideo.text()).toContain('mesmo arquivo')

    // Com o vídeo na partida, quem entra recebe o arquivo e a conferência
    // deixa de fazer sentido — os dois passam a ter o mesmo material.
    const enviado = await request.post(`/api/partidas/${code}/video`, {
      multipart: {
        playerId: 'anfitriao',
        video: { name: 'cena.mp4', mimeType: 'video/mp4', buffer: readFileSync(VALID_VIDEO) },
      },
    })
    expect(enviado.ok()).toBe(true)

    const entrada = await request.post(`/api/partidas/${code}`, {
      data: { playerId: 'convidado', name: 'Bia', characterId: 'voz-2', videoId: 'outro' },
    })
    expect(entrada.ok()).toBe(true)

    const baixado = await request.get(`/api/partidas/${code}/video`)
    expect(baixado.ok()).toBe(true)
    expect(Buffer.from(await baixado.body()).equals(readFileSync(VALID_VIDEO))).toBe(true)
  })
})
