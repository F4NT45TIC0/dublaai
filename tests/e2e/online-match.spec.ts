import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { confirmCharacterSetup, mockLocalTranscription } from './helpers'

const VALID_VIDEO = resolve(import.meta.dirname, 'fixtures/video-with-reference-audio.mp4')
const CANONICAL_LINE = 'A fala canônica chegou pelo código'

/**
 * Partida online entre dois navegadores.
 *
 * Dois contextos separados são o ponto do teste: sessões diferentes, storages
 * diferentes, exatamente como dois aparelhos. Um único contexto compartilharia
 * o localStorage e os dois "jogadores" teriam o mesmo id — o teste passaria sem
 * exercitar nada do que importa.
 */
async function abrirVideo(page: Page): Promise<void> {
  await page.goto('/multiplayer')
  await page.getByTestId('multiplayer-criar').click()
  await page.getByTestId('local-video-input').setInputFiles(VALID_VIDEO)
  await expect(page.getByRole('heading', { name: 'video-with-reference-audio.mp4' })).toBeVisible({
    timeout: 60_000,
  })
  await mockLocalTranscription(page)
  await page.getByTestId('ajustes-da-cena').locator('summary').click()
  await page.getByTestId('local-transcrever').click()
  await confirmCharacterSetup(page)
  await page.getByTestId('local-fala-0').fill(CANONICAL_LINE)
}

test.describe('partida online', () => {
  test('código bem-formado inexistente mostra o erro no landing', async ({ page }) => {
    await page.goto('/multiplayer')
    await page.getByTestId('online-codigo').fill('ZZZZ-ZZZZ-ZZZZ')
    await page.getByTestId('online-entrar-codigo').click()

    await expect(
      page.getByRole('alert').filter({ hasText: /partida não encontrada/i }),
    ).toBeVisible()
    await expect(page.getByTestId('online-codigo')).toBeVisible()
  })

  test('dois aparelhos revezam as falas pelo código da partida', async ({ browser, request }) => {
    test.setTimeout(210_000)
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
      const titulo = await paginaA.getByTestId('online-codigo-da-sala').innerText()
      const codigo = /([0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4})/.exec(
        titulo,
      )?.[1]
      expect(codigo).toBeDefined()

      await paginaA.getByTestId('online-apelido').fill('Ana')
      await expect(paginaA.getByTestId('online-personagem-voz-1')).toContainText('Burro')
      await paginaA.getByTestId('online-personagem-voz-1').click()
      await paginaA.getByTestId('online-confirmar-personagem').click()
      await expect(paginaA.getByTestId('online-aguardando-dupla')).toBeVisible({ timeout: 30_000 })
      // O servidor e a interface bloqueiam a primeira fala enquanto só há uma pessoa.
      await expect(paginaA.getByTestId('local-start-dub')).toHaveCount(0)

      // Segundo aparelho entra só com o código. O vídeo da anfitriã é baixado e
      // preparado automaticamente, sem seletor de arquivo.
      await paginaB.goto('/multiplayer')
      await paginaB.getByTestId('online-codigo').fill(codigo ?? '')
      await paginaB.getByTestId('online-entrar-codigo').click()
      await expect(paginaB.getByTestId('online-escolher-personagem')).toBeVisible({
        timeout: 90_000,
      })
      await expect(paginaB.getByTestId('local-video-input')).toHaveCount(0)
      await expect(paginaB.getByTestId('online-fala-da-vez')).toContainText(CANONICAL_LINE)

      // A voz da Ana não aparece mais na lista: personagem tomado é tomado.
      await expect(paginaB.getByTestId('online-personagem-voz-1')).toHaveCount(0)
      await expect(paginaB.getByTestId('online-personagem-voz-2')).toContainText('Shrek')
      await paginaB.getByTestId('online-apelido').fill('Bia')
      await paginaB.getByTestId('online-personagem-voz-2').click()
      await paginaB.getByTestId('online-confirmar-personagem').click()

      // Sem recarregar: o anfitrião descobre sozinho que a dupla se formou e
      // ambos já terminaram de preparar a mesma cena.
      await expect(paginaA.getByTestId('online-turno')).toContainText('Bia', { timeout: 30_000 })
      await expect(paginaA.getByTestId('online-turno')).toContainText('Pronto')

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
      await expect(parado.getByTestId('stitched-playback')).toContainText('1 de 8 falas prontas')

      // Fechar um aparelho pausa o servidor e a interface: estar apenas com a
      // vaga ocupada não conta como a segunda pessoa ainda estar na partida.
      await paginaB.close()
      await expect(paginaA.getByTestId('online-aguardando-prontos')).toBeVisible({
        timeout: 25_000,
      })
      await expect(paginaA.getByTestId('online-turno')).toContainText('Desconectado')
      await expect(paginaA.getByTestId('local-start-dub')).toHaveCount(0)

      // Quem continuou na sala consegue liberar a vaga de um aparelho que
      // desapareceu, sem precisar abandonar a partida inteira.
      await paginaA.getByTestId('online-liberar-vaga').click()
      await expect(paginaA.getByTestId('online-aguardando-dupla')).toBeVisible()
      const substitutoB = await request.post(`/api/partidas/${codigo ?? ''}`, {
        data: {
          playerId: 'substituto-b-e2e',
          name: 'Caio',
          characterId: 'voz-2',
          videoId: 'arquivo-ignorado-com-video-compartilhado',
        },
      })
      expect(substitutoB.ok(), await substitutoB.text()).toBe(true)
      await expect(paginaA.getByTestId('online-turno')).toContainText('Caio', { timeout: 15_000 })

      // O botão Sair precisa remover a vaga no servidor, não apenas voltar a
      // interface para o landing. Esperar a leitura confirmar a remoção evita
      // disputar o DELETE keepalive com a entrada do substituto.
      const anfitriaoId = await paginaA.evaluate(() => localStorage.getItem('dublaai:jogador'))
      expect(anfitriaoId).not.toBeNull()
      await paginaA.getByTestId('online-sair').click()
      await expect
        .poll(
          async () => {
            const response = await request.get(`/api/partidas/${codigo ?? ''}`)
            if (!response.ok()) return true
            const body = (await response.json()) as {
              state: { players: readonly { id: string }[] }
            }
            return body.state.players.some((player) => player.id === anfitriaoId)
          },
          { timeout: 15_000 },
        )
        .toBe(false)

      const substitutoA = await request.post(`/api/partidas/${codigo ?? ''}`, {
        data: {
          playerId: 'substituto-a-e2e',
          name: 'Dani',
          characterId: 'voz-1',
          videoId: 'arquivo-ignorado-com-video-compartilhado',
        },
      })
      expect(substitutoA.ok(), await substitutoA.text()).toBe(true)
    } finally {
      await anfitriao.close()
      await convidado.close()
    }
  })

  test('o vídeo viaja com a partida: só um dos dois precisa ter o arquivo', async ({ request }) => {
    const criada = await request.post('/api/partidas', {
      data: {
        videoId: 'video-do-anfitriao',
        hostId: 'anfitriao',
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

    const saiu = await request.delete(`/api/partidas/${code}`, {
      data: { playerId: 'convidado' },
    })
    expect(saiu.ok()).toBe(true)
    const depoisDaSaida = (await saiu.json()) as { state: { players: unknown[] } }
    expect(depoisDaSaida.state.players).toHaveLength(0)
  })
})
