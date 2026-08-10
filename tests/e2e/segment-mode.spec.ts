import { expect, test } from '@playwright/test'
import { instrumentTracks, openScene, readStoredAttempts, waitForState } from './helpers'

/**
 * Modo fala-a-fala.
 *
 * A asserção que importa não é "apareceu um número": é que cada tomada é
 * gravada e pontuada dentro da SUA janela, e que o resultado não afirma nada
 * sobre as falas que a pessoa não gravou.
 */
test.describe('modo fala-a-fala', () => {
  test.beforeEach(async ({ page }) => {
    await instrumentTracks(page)
  })

  test('grava e pontua uma fala isolada, sem inventar nota para as outras', async ({ page }) => {
    await openScene(page)

    await page.getByTestId('take-mode-segment').click()
    await expect(page.getByRole('button', { name: /Dublar a fala 1/i })).toBeVisible()

    // A lista de falas mostra o progresso.
    await expect(page.getByText(/0 de \d+ gravadas/)).toBeVisible()

    await page.getByTestId('start-dub').click()
    await waitForState(page, 'recording', 40_000)

    // A tomada termina sozinha ao fim da janela da fala — sem clicar em parar.
    await waitForState(page, 'preview', 40_000)

    const [attempt] = await readStoredAttempts(page)
    expect(attempt).toBeDefined()
    // A tomada precisa saber a que fala pertence.
    expect(attempt?.segmentId).toBeTruthy()

    const result = attempt?.result
    if (!result) throw new Error('análise não persistida')

    // Só a fala gravada é avaliada. Nenhuma nota é afirmada sobre as demais.
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0]?.segmentId).toBe(attempt.segmentId)

    // E o contrato do §12 continua valendo dentro da janela.
    for (const metric of Object.values(result.metrics)) {
      expect(['ok', 'limited', 'unavailable']).toContain(metric.status)
      if (metric.status === 'unavailable') expect(metric.value).toBeNull()
    }
  })

  test('o vídeo começa na fala escolhida, não no início da cena', async ({ page }) => {
    await openScene(page)
    await page.getByTestId('take-mode-segment').click()

    // Segunda fala da lista.
    await page.getByRole('button', { name: /^2\./ }).click()
    await expect(page.getByRole('button', { name: /Dublar a fala 2/i })).toBeVisible()

    await page.getByTestId('start-dub').click()
    await waitForState(page, 'recording', 40_000)

    const startedAt = await page.evaluate(() => {
      const video = document.querySelector('video')
      return video ? video.currentTime : -1
    })

    // A segunda fala nunca começa no zero: o vídeo foi posicionado nela.
    expect(startedAt).toBeGreaterThan(0.3)

    await waitForState(page, 'preview', 40_000)
  })

  test('cada fala guarda a própria tomada', async ({ page }) => {
    await openScene(page)
    await page.getByTestId('take-mode-segment').click()

    await page.getByTestId('start-dub').click()
    await waitForState(page, 'preview', 40_000)

    await page.getByRole('button', { name: /^2\./ }).click()
    await waitForState(page, 'idle')
    await page.getByTestId('start-dub').click()
    await waitForState(page, 'preview', 40_000)

    const attempts = await readStoredAttempts(page)
    expect(attempts).toHaveLength(2)

    const segmentIds = attempts.map((entry) => entry.segmentId)
    // As tomadas pertencem a falas diferentes.
    expect(new Set(segmentIds).size).toBe(2)

    await expect(page.getByText(/2 de \d+ gravadas/)).toBeVisible()
  })
})
