import { expect, type Page } from '@playwright/test'

export const SCENE_SLUG = 'dragao-domestico-fogo-na-cozinha'

/** Metadados que o app persiste em IndexedDB, lidos pelos testes. */
export interface StoredAttemptSnapshot {
  readonly id: string
  readonly attemptNumber: number
  /** Fala coberta, no modo fala-a-fala. Ausente = cena inteira. */
  readonly segmentId?: string
  readonly durationMs: number
  readonly clock: {
    readonly mediaStartOffsetMs: number
    readonly clockConfidence: number
    readonly sampleContinuityOk: boolean
    readonly sampleRate: number
  }
  readonly result: {
    readonly overall: { value: number | null; status: string }
    readonly metrics: Record<string, { value: number | null; status: string }>
    readonly globalOffsetMs: number
    readonly segments: readonly { readonly segmentId: string; readonly zone: string }[]
  } | null
}

export async function openScene(page: Page, slug = SCENE_SLUG): Promise<void> {
  await page.goto(`/cena/${slug}`)
  await expect(page.getByTestId('dub-panel')).toBeVisible()
}

export function panelState(page: Page) {
  return page.getByTestId('dub-panel')
}

/** Espera a máquina chegar a um estado. O atributo vem de `dub-panel`. */
export async function waitForState(page: Page, state: string, timeout = 60_000): Promise<void> {
  await expect(panelState(page)).toHaveAttribute('data-state', state, { timeout })
}

/**
 * Percorre o fluxo até o resultado.
 *
 * `stopAfterMs` existe porque as cenas duram mais que o necessário para o
 * teste: parar cedo exercita o caminho do botão PARAR, que é o mais usado.
 */
export async function recordOnce(page: Page, stopAfterMs = 4_000): Promise<void> {
  await page.getByTestId('start-dub').click()
  await waitForState(page, 'recording')
  await page.waitForTimeout(stopAfterMs)
  await page.getByTestId('stop-dub').click()
  await waitForState(page, 'preview')
}

/** Lê o que o app realmente gravou no IndexedDB (nada de estado só da UI). */
export async function readStoredAttempts(page: Page): Promise<StoredAttemptSnapshot[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('dublaai')
      request.onsuccess = () => {
        resolve(request.result)
      }
      request.onerror = () => {
        reject(request.error ?? new Error('IndexedDB falhou'))
      }
    })

    const rows = await new Promise<unknown[]>((resolve, reject) => {
      const transaction = db.transaction('attempts', 'readonly')
      const request = transaction.objectStore('attempts').getAll()
      request.onsuccess = () => {
        resolve(request.result)
      }
      request.onerror = () => {
        reject(request.error ?? new Error('IndexedDB falhou'))
      }
    })

    db.close()
    return rows as never
  })
}

/** Quantas tracks de mídia ainda estão vivas. Base do §111.14. */
export async function countLiveTracks(page: Page): Promise<number> {
  return page.evaluate(() => {
    const registry = (window as { __dublaTracks?: MediaStreamTrack[] }).__dublaTracks
    if (!registry) return -1
    return registry.filter((track) => track.readyState === 'live').length
  })
}

/**
 * Instrumenta `getUserMedia` para registrar toda track criada.
 *
 * Precisa rodar ANTES de qualquer script da página — daí o `addInitScript`.
 * Sem isso não há como afirmar que nenhum microfone continua ativo depois de
 * sair da página, que é um critério de aceitação explícito.
 */
export async function instrumentTracks(page: Page): Promise<void> {
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
}
