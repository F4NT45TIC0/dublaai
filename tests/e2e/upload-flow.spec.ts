import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const NO_AUDIO_VIDEO = resolve(import.meta.dirname, 'fixtures/video-without-audio.mp4')
const VALID_VIDEO = resolve(import.meta.dirname, 'fixtures/video-with-reference-audio.mp4')
const VIDEO_OVER_LIMIT = resolve(import.meta.dirname, 'fixtures/video-over-limit.mp4')

interface ProbeResult {
  readonly streams?: readonly {
    readonly codec_name?: string
    readonly codec_type?: string
  }[]
}

function localDubPanel(page: Page) {
  return page.getByTestId('local-dub-panel')
}

async function waitForLocalState(page: Page, state: string, timeout = 60_000): Promise<void> {
  await expect(localDubPanel(page)).toHaveAttribute('data-state', state, { timeout })
}

function probeMedia(path: string): ProbeResult {
  const output = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,codec_name',
      '-of',
      'json',
      path,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  )
  return JSON.parse(output) as ProbeResult
}

test.describe('arquivo ou URL de vídeo', () => {
  test('extrai a referência, mostra a voz ao vivo, pontua e baixa o vídeo', async ({ page }) => {
    test.setTimeout(120_000)

    await page.goto('/enviar')
    await page.getByTestId('local-video-input').setInputFiles(VALID_VIDEO)

    await expect(
      page.getByRole('heading', { name: 'video-with-reference-audio.mp4' }),
    ).toBeVisible()
    await expect(
      page.getByRole('slider', { name: 'Forma de onda da referência do vídeo enviado' }),
    ).toBeVisible({ timeout: 30_000 })
    await waitForLocalState(page, 'idle')

    const selectedDuration = await page
      .locator('video[aria-label^="Vídeo para dublagem:"]')
      .evaluate((video: HTMLVideoElement) => video.duration)
    expect(selectedDuration).toBeGreaterThan(0)
    expect(selectedDuration).toBeLessThanOrEqual(60)

    await page.getByTestId('local-start-dub').click()
    await waitForLocalState(page, 'recording')
    const liveWaveform = page.getByRole('img', {
      name: 'Forma de onda da referência com sua voz ao vivo',
    })
    await expect(liveWaveform).toBeVisible()
    await expect
      .poll(
        async () =>
          liveWaveform.evaluate((canvas: HTMLCanvasElement) => {
            const context = canvas.getContext('2d')
            if (!context || canvas.width === 0 || canvas.height === 0) return false
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
            for (let index = 0; index < pixels.length; index += 4) {
              const red = pixels[index] ?? 0
              const green = pixels[index + 1] ?? 0
              const blue = pixels[index + 2] ?? 0
              if (green > 150 && green > red * 2 && green > blue) return true
            }
            return false
          }),
        { timeout: 5_000 },
      )
      .toBe(true)
    await page.waitForTimeout(2_000)
    await page.getByTestId('local-stop-dub').click()

    await waitForLocalState(page, 'preview')
    await expect(page.getByRole('button', { name: /Ouvir com o vídeo/i })).toBeVisible()
    await expect(page.getByRole('region', { name: /Resultado da dublagem/i })).toBeVisible({
      timeout: 30_000,
    })

    await page.getByTestId('export-dubbed-video').click()
    await expect(page.getByTestId('download-dubbed-video')).toBeVisible({ timeout: 45_000 })

    const downloadPromise = page.waitForEvent('download')
    await page.getByTestId('download-dubbed-video').click()
    const download = await downloadPromise
    const downloadPath = await download.path()

    expect(download.suggestedFilename()).toMatch(
      /^video-with-reference-audio-dublado\.(webm|mp4)$/,
    )
    expect(downloadPath, 'o navegador não materializou o download').not.toBeNull()
    if (!downloadPath) throw new Error('Download sem caminho local')
    expect(statSync(downloadPath).size).toBeGreaterThan(1_000)

    const probe = probeMedia(downloadPath)
    const streamTypes = probe.streams?.map((stream) => stream.codec_type) ?? []
    expect(streamTypes).toContain('video')
    expect(streamTypes).toContain('audio')
  })

  test('uma URL direta com CORS percorre o mesmo fluxo de pontuação', async ({ page }) => {
    test.setTimeout(90_000)
    const body = readFileSync(VALID_VIDEO)
    await page.route('https://media.example.test/cena-url.mp4', async (route) => {
      await route.fulfill({
        status: 200,
        body,
        contentType: 'video/mp4',
        headers: { 'access-control-allow-origin': '*' },
      })
    })

    await page.goto('/enviar')
    await page.getByTestId('remote-video-url').fill('https://media.example.test/cena-url.mp4')
    await page.getByRole('button', { name: 'Processar URL' }).click()

    await expect(page.getByRole('heading', { name: 'cena-url.mp4' })).toBeVisible({
      timeout: 30_000,
    })
    await expect(
      page.getByRole('slider', { name: 'Forma de onda da referência do vídeo enviado' }),
    ).toBeVisible()
    await waitForLocalState(page, 'idle')

    await page.getByTestId('local-start-dub').click()
    await waitForLocalState(page, 'recording')
    await page.waitForTimeout(2_000)
    await page.getByTestId('local-stop-dub').click()
    await waitForLocalState(page, 'preview')
    await expect(page.getByRole('region', { name: /Resultado da dublagem/i })).toBeVisible({
      timeout: 30_000,
    })
  })

  test('falas digitadas viram legenda e o modo fala-a-fala grava um trecho', async ({ page }) => {
    await page.goto('/enviar')
    await page.getByTestId('local-video-input').setInputFiles(VALID_VIDEO)
    await expect(
      page.getByRole('heading', { name: 'video-with-reference-audio.mp4' }),
    ).toBeVisible({ timeout: 60_000 })

    // A pessoa digita a fala do primeiro trecho — nada é transcrito sozinho.
    const editor = page.locator('summary', { hasText: 'Falas da cena' })
    await editor.click()
    await page.getByTestId('local-fala-0').fill('Olá, mundo da dublagem!')
    await expect(editor).toContainText('1 de')

    // Modo fala-a-fala: grava só o primeiro trecho e encerra sozinho.
    await page.getByTestId('local-take-mode-segment').click()
    await expect(page.getByTestId('local-start-dub')).toContainText('Dublar o trecho 1')

    await page.getByTestId('local-start-dub').click()
    await waitForLocalState(page, 'recording', 40_000)
    await waitForLocalState(page, 'preview', 40_000)

    // E a cena completa costurada fica disponível.
    await expect(page.getByTestId('stitched-playback')).toContainText('1 fala montada')
  })

  test('o botão de próxima fala avança sem obrigar a rolar a página', async ({ page }) => {
    await page.goto('/enviar')
    await page.getByTestId('local-video-input').setInputFiles(VALID_VIDEO)
    await expect(
      page.getByRole('heading', { name: 'video-with-reference-audio.mp4' }),
    ).toBeVisible({ timeout: 60_000 })

    await page.getByTestId('local-take-mode-segment').click()
    await expect(page.getByTestId('local-start-dub')).toContainText('trecho 1')

    await page.getByTestId('local-start-dub').click()
    await waitForLocalState(page, 'preview', 40_000)

    // O ciclo gravar → seguir acontece no mesmo lugar da tela.
    await page.getByTestId('local-next-segment').click()
    await waitForLocalState(page, 'idle')
    await expect(page.getByTestId('local-start-dub')).toContainText('trecho 2')
  })

  test('trechos com a voz original ficam de fora da gravação e entram na cena', async ({
    page,
  }) => {
    await page.goto('/enviar')
    await page.getByTestId('local-video-input').setInputFiles(VALID_VIDEO)
    await expect(
      page.getByRole('heading', { name: 'video-with-reference-audio.mp4' }),
    ).toBeVisible({ timeout: 60_000 })

    await page.getByTestId('local-take-mode-segment').click()

    // Deixa os trechos 2 e 3 com a voz do vídeo; só o 1 será dublado.
    await page.locator('summary', { hasText: /Falas da cena/i }).click()
    await page.getByTestId('local-fonte-1').click()
    await page.getByTestId('local-fonte-2').click()
    await expect(page.getByTestId('local-fonte-1')).toHaveAttribute('aria-pressed', 'true')

    await page.getByTestId('local-start-dub').click()
    await waitForLocalState(page, 'preview', 40_000)

    // A próxima pendência pula 2 e 3: quem está no original já está resolvido.
    await page.getByTestId('local-next-segment').click()
    await waitForLocalState(page, 'idle')
    await expect(page.getByTestId('local-start-dub')).toContainText('trecho 4')

    // A cena completa conta a tomada gravada e os dois trechos originais.
    await expect(page.getByTestId('stitched-playback')).toContainText('3 falas montadas')
  })

  test('nenhum microfone continua ativo depois de sair da página (§111.14)', async ({ page }) => {
    await page.addInitScript(() => {
      const registry: MediaStreamTrack[] = []
      ;(window as { __dublaTracks?: MediaStreamTrack[] }).__dublaTracks = registry
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
        const stream = await original(constraints)
        registry.push(...stream.getTracks())
        return stream
      }
    })

    await page.goto('/enviar')
    await page.getByTestId('local-video-input').setInputFiles(VALID_VIDEO)
    await expect(
      page.getByRole('heading', { name: 'video-with-reference-audio.mp4' }),
    ).toBeVisible({ timeout: 60_000 })

    await page.getByTestId('local-start-dub').click()
    await waitForLocalState(page, 'recording', 40_000)
    await page.waitForTimeout(2_000)
    await page.getByTestId('local-stop-dub').click()
    await waitForLocalState(page, 'preview', 40_000)

    const liveDuring = await page.evaluate(
      () =>
        ((window as { __dublaTracks?: MediaStreamTrack[] }).__dublaTracks ?? []).filter(
          (track) => track.readyState === 'live',
        ).length,
    )
    expect(liveDuring).toBeGreaterThan(0)

    // Sair da página desmonta a árvore e dispara a limpeza do §67.
    await page.goto('/')
    await expect(page.getByRole('heading', { name: /Dubla/ })).toBeVisible()
    const liveAfter = await page.evaluate(
      () =>
        ((window as { __dublaTracks?: MediaStreamTrack[] }).__dublaTracks ?? []).filter(
          (track) => track.readyState === 'live',
        ).length,
    )
    expect(liveAfter).toBe(0)
  })

  test('vídeo sem áudio continua disponível sem inventar pontuação', async ({ page }) => {
    await page.goto('/enviar')
    await page.getByTestId('local-video-input').setInputFiles(NO_AUDIO_VIDEO)

    await expect(page.getByText(/sem forma de onda e pontuação/i)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('slider', { name: /Forma de onda da referência/ })).toHaveCount(0)
    await waitForLocalState(page, 'idle')
  })

  test('recusa um vídeo real acima do limite de duração', async ({ page }) => {
    await page.goto('/enviar')
    await page.getByTestId('local-video-input').setInputFiles(VIDEO_OVER_LIMIT)

    await expect(page.locator('p[role="alert"]')).toHaveText(
      'O vídeo precisa ter no máximo 5 minutos.',
    )
    await expect(localDubPanel(page)).toHaveCount(0)
  })
})
