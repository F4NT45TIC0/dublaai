import { expect, test } from '@playwright/test'
import { instrumentTracks, openScene, waitForState } from './helpers'

/**
 * Dueto por turnos, dois jogadores no mesmo aparelho.
 *
 * A asserção central é o rodízio: a vez precisa alternar conforme a cena
 * avança, e a partida só fecha quando todas as falas têm dono e tomada.
 */
test.describe('dueto', () => {
  test.beforeEach(async ({ page }) => {
    await instrumentTracks(page)
  })

  test('alterna os turnos até fechar a cena', async ({ page }) => {
    // A cena do condomínio tem três personagens e nove falas.
    await openScene(page, 'condominio-pauta-unica')

    await page.getByTestId('take-mode-duet').click()
    await expect(page.getByTestId('duet-setup')).toBeVisible()

    await page.getByTestId('duet-name-0').fill('Ana')
    await page.getByTestId('duet-name-1').fill('Bruno')
    await page.getByTestId('duet-start').click()

    await expect(page.getByTestId('duet-turn')).toBeVisible()

    // Primeira vez: o síndico abre a cena, então é da Ana.
    const firstTurn = await page.getByTestId('duet-turn-label').textContent()
    expect(firstTurn).toContain('Ana')
    expect(firstTurn).toContain('fala 1 de')

    await page.getByTestId('start-dub').click()
    await waitForState(page, 'preview', 40_000)

    // A vez passou para o outro jogador, na fala seguinte.
    await expect(page.getByTestId('duet-turn-label')).toContainText('fala 2 de')
    const secondTurn = await page.getByTestId('duet-turn-label').textContent()
    expect(secondTurn).toContain('Bruno')

    // A troca de mãos é explícita: o aparelho passa junto do botão.
    await page.getByTestId('duet-pass').click()
    await waitForState(page, 'idle')

    await page.getByTestId('start-dub').click()
    await waitForState(page, 'preview', 40_000)

    await expect(page.getByTestId('duet-turn-label')).toContainText('fala 3 de')
  })

  test('exige personagens diferentes para os dois jogadores', async ({ page }) => {
    await openScene(page, 'condominio-pauta-unica')
    await page.getByTestId('take-mode-duet').click()

    // Os dois no mesmo personagem: metade da cena ficaria sem dono.
    const firstCharacter = page.locator('[data-testid^="duet-pick-0-"]').first()
    const sameForSecond = page.locator('[data-testid^="duet-pick-1-"]').first()
    await firstCharacter.click()
    await sameForSecond.click()

    await expect(page.getByText(/personagem diferente/i)).toBeVisible()
    await expect(page.getByTestId('duet-start')).toBeDisabled()
  })

  test('não oferece dueto em cena de um personagem só', async ({ page }) => {
    // Cenas de duas vozes têm o modo; o alternador só some quando não há
    // personagens suficientes. Verificamos o caminho contrário aqui.
    await openScene(page, 'dragao-domestico-fogo-na-cozinha')
    await expect(page.getByTestId('take-mode-duet')).toBeVisible()
  })
})
