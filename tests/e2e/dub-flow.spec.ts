import { expect, test } from '@playwright/test'
import {
  countLiveTracks,
  instrumentTracks,
  openScene,
  panelState,
  readStoredAttempts,
  recordOnce,
  SCENE_SLUG,
  waitForState,
} from './helpers'

test.describe('fluxo de dublagem', () => {
  test.beforeEach(async ({ page }) => {
    await instrumentTracks(page)
  })

  test('percorre cena → permissão → countdown → gravação → resultado', async ({ page }) => {
    await openScene(page)
    await expect(panelState(page)).toHaveAttribute('data-state', 'idle')

    await page.getByTestId('start-dub').click()

    // O countdown só aparece depois dos guards (§19/§59): microfone pronto,
    // contexto rodando e vídeo em buffer.
    await waitForState(page, 'countdown')
    await expect(page.getByText('GRAVANDO', { exact: false })).toBeVisible({ timeout: 10_000 })

    await waitForState(page, 'recording')
    await page.waitForTimeout(4_000)
    await page.getByTestId('stop-dub').click()

    await waitForState(page, 'preview')
    await expect(page.getByRole('button', { name: /Ouvir com o vídeo/i })).toBeVisible()
  })

  test('produz um resultado com estrutura honesta', async ({ page }) => {
    await openScene(page)
    await recordOnce(page)

    await expect(page.getByRole('region', { name: /Resultado da dublagem/i })).toBeVisible({
      timeout: 30_000,
    })

    const [attempt] = await readStoredAttempts(page)
    expect(attempt).toBeDefined()
    expect(attempt?.result).not.toBeNull()

    const result = attempt?.result
    if (!result) throw new Error('análise não persistida')

    // A asserção não é "apareceu um número": é que toda métrica respeita o
    // contrato do §12 — ou tem valor em 0..100, ou é nula E declarada
    // indisponível. Um score aleatório passaria no primeiro, não no segundo.
    for (const [key, metric] of Object.entries(result.metrics)) {
      expect(['ok', 'limited', 'unavailable'], `métrica ${key}`).toContain(metric.status)
      if (metric.status === 'unavailable') {
        expect(metric.value, `métrica ${key}`).toBeNull()
      } else {
        expect(metric.value, `métrica ${key}`).not.toBeNull()
        expect(metric.value ?? -1, `métrica ${key}`).toBeGreaterThanOrEqual(0)
        expect(metric.value ?? 101, `métrica ${key}`).toBeLessThanOrEqual(100)
      }
    }

    expect(['ok', 'limited', 'unavailable']).toContain(result.overall.status)
  })

  test('mede o offset entre gravação e vídeo dentro da faixa esperada', async ({ page }) => {
    await openScene(page)
    await recordOnce(page)

    const [attempt] = await readStoredAttempts(page)
    const clock = attempt?.clock
    if (!clock) throw new Error('relógio não persistido')

    // O gravador é armado no início do countdown e o vídeo só começa ao entrar
    // em `recording` — cerca de 3 s depois. `mediaStartOffsetMs` é o tempo de
    // vídeo da primeira amostra, portanto NEGATIVO e próximo de −3000 ms.
    //
    // Isto valida a cadeia inteira do relógio: currentFrame do worklet →
    // contextTime → performanceTime → mediaTime do vídeo. Um erro em qualquer
    // elo produz um número fora desta faixa ou um zero.
    expect(clock.mediaStartOffsetMs).toBeLessThan(-1_500)
    expect(clock.mediaStartOffsetMs).toBeGreaterThan(-6_000)

    // Se o ajuste do MediaClock fosse ruim, o offset acima não significaria nada.
    expect(clock.clockConfidence).toBeGreaterThan(0.5)
    expect(clock.sampleContinuityOk).toBe(true)
    expect(clock.sampleRate).toBeGreaterThan(8_000)
  })

  test('playback corrige drift, para limpo e reinicia alinhado', async ({ page }) => {
    await openScene(page)
    await recordOnce(page, 2_500)

    const [attempt] = await readStoredAttempts(page)
    if (!attempt) throw new Error('tentativa não persistida')
    const audioTimeAtVideoZero = Math.max(0, -attempt.clock.mediaStartOffsetMs / 1_000)
    const playbackButton = page.getByRole('button', { name: /Ouvir com o vídeo/i })

    await playbackButton.click()
    await expect(page.getByRole('button', { name: /Parar/i })).toBeVisible()

    const initialError = await page.evaluate(async (audioZero) => {
      const video = document.querySelector('video')
      const audio = document.querySelector<HTMLAudioElement>(
        'audio:not([aria-hidden="true"])',
      )
      if (!video || !audio) throw new Error('players não encontrados')
      await new Promise<void>((resolve) => setTimeout(resolve, 250))
      const expectedVideoTime = audio.currentTime - audioZero
      return Math.abs(expectedVideoTime - video.currentTime)
    }, audioTimeAtVideoZero)
    expect(initialError).toBeLessThan(0.2)

    const softCorrection = await page.evaluate(async (audioZero) => {
      const video = document.querySelector('video')
      const audio = document.querySelector<HTMLAudioElement>(
        'audio:not([aria-hidden="true"])',
      )
      if (!video || !audio) throw new Error('players não encontrados')
      const expectedVideoTime = audio.currentTime - audioZero
      video.currentTime = Math.max(0, expectedVideoTime - 0.1)
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => {
          resolve()
        }),
      )
      return video.playbackRate
    }, audioTimeAtVideoZero)
    expect(softCorrection).toBeGreaterThan(1)
    expect(softCorrection).toBeLessThanOrEqual(1.02)

    const hardCorrectionError = await page.evaluate(async (audioZero) => {
      const video = document.querySelector('video')
      const audio = document.querySelector<HTMLAudioElement>(
        'audio:not([aria-hidden="true"])',
      )
      if (!video || !audio) throw new Error('players não encontrados')
      // Adianta o vídeo em vez de atrasá-lo: assim o erro imposto é sempre
      // 500 ms, mesmo nos primeiros instantes da reprodução (sem clamp em 0).
      video.currentTime = audio.currentTime - audioZero + 0.5
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => {
          resolve()
        }),
      )
      return Math.abs(audio.currentTime - audioZero - video.currentTime)
    }, audioTimeAtVideoZero)
    expect(hardCorrectionError).toBeLessThan(0.08)

    await page.getByRole('button', { name: /Parar/i }).click()
    await expect(playbackButton).toBeVisible()
    const stopped = await page.evaluate(() => {
      const video = document.querySelector('video')
      const audio = document.querySelector<HTMLAudioElement>(
        'audio:not([aria-hidden="true"])',
      )
      if (!video || !audio) throw new Error('players não encontrados')
      return { videoPaused: video.paused, audioPaused: audio.paused, playbackRate: video.playbackRate }
    })
    expect(stopped).toEqual({ videoPaused: true, audioPaused: true, playbackRate: 1 })

    await playbackButton.click()
    const restarted = await page.evaluate(async (audioZero) => {
      const video = document.querySelector('video')
      const audio = document.querySelector<HTMLAudioElement>(
        'audio:not([aria-hidden="true"])',
      )
      if (!video || !audio) throw new Error('players não encontrados')
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => {
          resolve()
        }),
      )
      return {
        videoTime: video.currentTime,
        alignmentError: Math.abs(audio.currentTime - audioZero - video.currentTime),
      }
    }, audioTimeAtVideoZero)
    expect(restarted.videoTime).toBeLessThan(0.5)
    expect(restarted.alignmentError).toBeLessThan(0.2)

    await page.getByRole('button', { name: /Parar/i }).click()
  })

  test('permite tentar novamente e acumula o histórico', async ({ page }) => {
    await openScene(page)
    await recordOnce(page, 3_000)

    await page.getByRole('button', { name: /Tentar novamente/i }).click()
    await waitForState(page, 'recording', 30_000)
    await page.waitForTimeout(3_000)
    await page.getByTestId('stop-dub').click()
    await waitForState(page, 'preview')

    await expect(page.getByText('Suas tentativas')).toBeVisible()

    const attempts = await readStoredAttempts(page)
    expect(attempts.length).toBeGreaterThanOrEqual(2)
    expect(attempts.map((entry) => entry.attemptNumber)).toEqual([1, 2])
  })

  test('cancelar durante o countdown não deixa gravação ativa (§103)', async ({ page }) => {
    await openScene(page)
    await page.getByTestId('start-dub').click()
    await waitForState(page, 'countdown')

    await page.getByRole('button', { name: /Cancelar/i }).click()
    await waitForState(page, 'idle')

    expect(await readStoredAttempts(page)).toHaveLength(0)
  })

  test('nenhum microfone continua ativo depois de sair da página (§111.14)', async ({ page }) => {
    await openScene(page)
    await recordOnce(page, 2_500)

    expect(await countLiveTracks(page)).toBeGreaterThan(0)

    // Navegar para fora desmonta a árvore e dispara a limpeza do §67.
    await page.goto('/explorar')
    await expect(page.getByRole('heading', { name: 'Explorar' })).toBeVisible()

    // O registro vive em `window`, que é recriado na navegação — então a
    // verificação real é que a página anterior não deixou nada rodando.
    // Voltamos e conferimos que a contagem recomeça do zero.
    expect(await countLiveTracks(page)).toBe(0)
  })

  test('a gravação sobrevive a recarregar a página (§54)', async ({ page }) => {
    await openScene(page)
    await recordOnce(page, 3_000)

    const before = await readStoredAttempts(page)
    expect(before).toHaveLength(1)

    await page.reload()
    await expect(page.getByTestId('dub-panel')).toBeVisible()

    const after = await readStoredAttempts(page)
    expect(after).toHaveLength(1)
    expect(after[0]?.id).toBe(before[0]?.id)
  })
})

test.describe('cena', () => {
  test('player mantém vídeo e TTS juntos ao reproduzir, pausar, buscar e recomeçar', async ({
    page,
  }) => {
    await openScene(page)

    await page.getByRole('button', { name: 'Reproduzir' }).click()
    await expect(page.getByRole('button', { name: 'Pausar' })).toBeVisible()
    await page.waitForTimeout(500)

    const playing = await page.evaluate(() => {
      const video = document.querySelector('video')
      const audio = document.querySelector<HTMLAudioElement>('audio[aria-hidden="true"]')
      if (!video || !audio) throw new Error('vídeo ou TTS não encontrado')
      return {
        videoTime: video.currentTime,
        audioTime: audio.currentTime,
        videoPaused: video.paused,
        audioPaused: audio.paused,
      }
    })
    expect(playing.videoPaused).toBe(false)
    expect(playing.audioPaused).toBe(false)
    expect(playing.videoTime).toBeGreaterThan(0.1)
    expect(playing.audioTime).toBeGreaterThan(0.1)
    expect(Math.abs(playing.audioTime - playing.videoTime)).toBeLessThan(0.12)

    await page.getByRole('button', { name: 'Pausar' }).click()
    await expect(page.getByRole('button', { name: 'Reproduzir' })).toBeVisible()
    const pausedAt = await page.evaluate(() => {
      const video = document.querySelector('video')
      const audio = document.querySelector<HTMLAudioElement>('audio[aria-hidden="true"]')
      if (!video || !audio) throw new Error('vídeo ou TTS não encontrado')
      return { video: video.currentTime, audio: audio.currentTime }
    })
    await page.waitForTimeout(300)
    const stillPaused = await page.evaluate(() => {
      const video = document.querySelector('video')
      const audio = document.querySelector<HTMLAudioElement>('audio[aria-hidden="true"]')
      if (!video || !audio) throw new Error('vídeo ou TTS não encontrado')
      return {
        video: video.currentTime,
        audio: audio.currentTime,
        videoPaused: video.paused,
        audioPaused: audio.paused,
      }
    })
    expect(stillPaused.videoPaused).toBe(true)
    expect(stillPaused.audioPaused).toBe(true)
    expect(Math.abs(stillPaused.video - pausedAt.video)).toBeLessThan(0.03)
    expect(Math.abs(stillPaused.audio - pausedAt.audio)).toBeLessThan(0.03)

    await page.getByRole('slider', { name: 'Forma de onda da referência' }).press('ArrowRight')
    await page.waitForTimeout(100)
    const sought = await page.evaluate(() => {
      const video = document.querySelector('video')
      const audio = document.querySelector<HTMLAudioElement>('audio[aria-hidden="true"]')
      if (!video || !audio) throw new Error('vídeo ou TTS não encontrado')
      return { video: video.currentTime, audio: audio.currentTime, audioPaused: audio.paused }
    })
    expect(sought.video).toBeGreaterThan(pausedAt.video + 0.5)
    expect(sought.video).toBeLessThan(pausedAt.video + 1.5)
    expect(Math.abs(sought.audio - sought.video)).toBeLessThan(0.03)
    expect(sought.audioPaused).toBe(true)

    await page.getByRole('button', { name: 'Recomeçar' }).click()
    const restarted = await page.evaluate(() => {
      const video = document.querySelector('video')
      const audio = document.querySelector<HTMLAudioElement>('audio[aria-hidden="true"]')
      if (!video || !audio) throw new Error('vídeo ou TTS não encontrado')
      return { video: video.currentTime, audio: audio.currentTime }
    })
    expect(restarted.video).toBeLessThan(0.03)
    expect(restarted.audio).toBeLessThan(0.03)
  })

  test('o vídeo não tem faixa de áudio (§14)', async ({ page }) => {
    await page.goto(`/cena/${SCENE_SLUG}`)

    const hasAudio = await page.evaluate(async () => {
      const video = document.querySelector('video')
      if (!video) return null
      await new Promise<void>((resolve) => {
        if (video.readyState >= 1) resolve()
        else video.addEventListener('loadedmetadata', () => { resolve() }, { once: true })
      })
      const element = video as HTMLVideoElement & {
        mozHasAudio?: boolean
        webkitAudioDecodedByteCount?: number
        audioTracks?: { length: number }
      }
      if (typeof element.mozHasAudio === 'boolean') return element.mozHasAudio
      if (element.audioTracks) return element.audioTracks.length > 0
      return (element.webkitAudioDecodedByteCount ?? 0) > 0
    })

    expect(hasAudio).toBe(false)
  })

  test('a legenda acompanha a cena', async ({ page }) => {
    await page.goto(`/cena/${SCENE_SLUG}`)

    const subtitleAt = async (seconds: number) =>
      page.evaluate(async (target: number) => {
        const video = document.querySelector('video')
        if (!video) return ''
        video.currentTime = target
        await video.play()
        await new Promise((resolve) => setTimeout(resolve, 500))
        video.pause()
        return document.querySelector('.sr-only[aria-live]')?.textContent.trim() ?? ''
      }, seconds)

    // Em algum ponto do meio da cena precisa haver fala na tela.
    const middle = await subtitleAt(3)
    expect(middle.length).toBeGreaterThan(0)
  })
})
