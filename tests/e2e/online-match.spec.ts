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

  test('recusa quem chega com outro arquivo de vídeo', async ({ page, request }) => {
    await abrirVideo(page)
    await page.getByTestId('online-criar').click()
    await expect(page.getByTestId('online-escolher-personagem')).toBeVisible({ timeout: 30_000 })

    const texto = await page.getByTestId('online-escolher-personagem').innerText()
    const codigo = /([0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4})/.exec(
      texto,
    )?.[1]

    // O vídeo não trafega, então a única defesa contra dublar cenas diferentes
    // é a impressão digital do arquivo — conferida no servidor.
    const resposta = await request.post(`/api/partidas/${codigo ?? ''}`, {
      data: {
        playerId: 'intruso',
        name: 'Intruso',
        characterId: 'voz-2',
        videoId: 'arquivo-completamente-outro',
      },
    })
    expect(resposta.status()).toBe(409)
    expect(await resposta.text()).toContain('mesmo arquivo')
  })
})
