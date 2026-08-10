import { expect, test } from '@playwright/test'
import { instrumentTracks, openScene, panelState, waitForState } from './helpers'

/**
 * Teste de vazamento (§68).
 *
 * O produto precisa aguentar dezenas de tentativas seguidas sem degradar. Os
 * suspeitos são sempre os mesmos: `AudioContext` criado por gravação,
 * `MediaStreamTrack` não parada, object URL não revogada, worker não
 * terminado, listener não removido.
 *
 * A contagem começa a valer a partir do 5º ciclo: os primeiros carregam
 * módulos, criam o worker e aquecem cache, e essa subida é esperada.
 */

const CYCLES = Number(process.env['LEAK_CYCLES'] ?? 12)
const WARMUP = 4

interface ResourceSnapshot {
  readonly liveTracks: number
  readonly audioContexts: number
  readonly objectUrls: number
}

test('gravações consecutivas não acumulam recursos', async ({ page }) => {
  test.setTimeout(CYCLES * 20_000 + 60_000)

  await instrumentTracks(page)

  // Instrumenta AudioContext e object URLs antes de qualquer script da página.
  await page.addInitScript(() => {
    const counters = { audioContexts: 0, objectUrls: 0 }
    ;(window as { __dublaCounters?: typeof counters }).__dublaCounters = counters

    const OriginalContext = window.AudioContext
    // @ts-expect-error -- substituição intencional para contagem
    window.AudioContext = class extends OriginalContext {
      constructor(...args: ConstructorParameters<typeof OriginalContext>) {
        super(...args)
        counters.audioContexts += 1
      }
    }

    const createObjectURL = URL.createObjectURL.bind(URL)
    const revokeObjectURL = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = (object: Blob | MediaSource) => {
      counters.objectUrls += 1
      return createObjectURL(object)
    }
    URL.revokeObjectURL = (url: string) => {
      counters.objectUrls -= 1
      revokeObjectURL(url)
    }
  })

  const snapshot = async (): Promise<ResourceSnapshot> =>
    page.evaluate(() => {
      const counters = (
        window as { __dublaCounters?: { audioContexts: number; objectUrls: number } }
      ).__dublaCounters
      const tracks = (window as { __dublaTracks?: MediaStreamTrack[] }).__dublaTracks ?? []
      return {
        liveTracks: tracks.filter((track) => track.readyState === 'live').length,
        audioContexts: counters?.audioContexts ?? 0,
        objectUrls: counters?.objectUrls ?? 0,
      }
    })

  await openScene(page)

  let baseline: ResourceSnapshot | null = null

  for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
    const isFirst = cycle === 1
    if (isFirst) {
      await page.getByTestId('start-dub').click()
    } else {
      await page.getByRole('button', { name: /Tentar novamente/i }).click()
    }

    await waitForState(page, 'recording', 40_000)
    await page.waitForTimeout(1_200)
    await page.getByTestId('stop-dub').click()
    await waitForState(page, 'preview', 40_000)

    if (cycle === WARMUP) baseline = await snapshot()
  }

  const final = await snapshot()
  expect(baseline, 'baseline não capturado').not.toBeNull()
  if (!baseline) return

  // O §22 é explícito: UM AudioContext por sessão, não um por gravação.
  expect(final.audioContexts, 'AudioContext criados').toBeLessThanOrEqual(2)

  // Uma única track viva (a da sessão corrente) é o esperado.
  expect(final.liveTracks, 'tracks vivas').toBeLessThanOrEqual(1)

  // Object URLs crescem com o histórico de tentativas — uma por gravação é
  // legítimo, várias por gravação não.
  const growth = final.objectUrls - baseline.objectUrls
  expect(growth, 'object URLs por ciclo').toBeLessThanOrEqual(CYCLES - WARMUP + 2)

  // E o painel continua respondendo depois de tudo isso.
  await expect(panelState(page)).toHaveAttribute('data-state', 'preview')
})
