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

/**
 * Evita baixar o Whisper (~90 MB) em cada caso E2E, sem interferir nos workers
 * reais de áudio/análise usados pelo restante do fluxo.
 */
export async function mockLocalTranscription(page: Page): Promise<void> {
  await page.evaluate(() => {
    const NativeWorker = window.Worker

    class FakeTranscriptionWorker extends EventTarget {
      postMessage(message: { readonly requestId?: unknown }) {
        const requestId = typeof message.requestId === 'string' ? message.requestId : ''
        queueMicrotask(() => {
          this.dispatchEvent(
            new MessageEvent('message', {
              data: {
                requestId,
                kind: 'done',
                ok: true,
                chunks: Array.from({ length: 8 }, (_, index) => ({
                  startMs: index * 1_000,
                  endMs: index * 1_000 + 600,
                  text: `Fala ${String(index + 1)}.`,
                })),
              },
            }),
          )
        })
      }

      terminate() {
        this.dispatchEvent(new Event('close'))
      }
    }

    window.Worker = new Proxy(NativeWorker, {
      construct() {
        // Instalado somente depois que o vídeo terminou de ser preparado: o
        // próximo worker é o Whisper. Restaurar imediatamente preserva o
        // worker real da análise da gravação que acontece depois.
        window.Worker = NativeWorker
        return new FakeTranscriptionWorker()
      },
    })
  })
}

/** Confirma o modal novo e espera a lista fala-a-fala ficar pronta. */
export async function confirmCharacterSetup(
  page: Page,
  names: readonly string[] = ['Burro', 'Shrek'],
): Promise<void> {
  await expect(page.getByTestId('character-setup-dialog')).toBeVisible()
  if (await page.getByTestId(`vozes-${String(names.length)}`).isVisible()) {
    await page.getByTestId(`vozes-${String(names.length)}`).click()
  }
  for (const [index, name] of names.entries()) {
    await page.getByTestId(`character-name-${String(index)}`).fill(name)
  }
  await page.getByTestId('character-setup-confirm').click()
  await expect(page.getByTestId('scene-review-panel')).toContainText(
    'Faça uma conferência rápida',
    {
      timeout: 20_000,
    },
  )
}
