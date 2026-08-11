import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredAttempt } from '../recording-store'

const storeMocks = vi.hoisted(() => ({
  deleteAttemptsForScene: vi.fn(),
  listAttempts: vi.fn(),
  loadAudioUrl: vi.fn(),
  saveAttempt: vi.fn(),
  updateAttemptResult: vi.fn(),
}))

vi.mock('../recording-store', () => storeMocks)

import { useRecorder } from '../use-recorder'

const STORED_ATTEMPT: StoredAttempt = {
  id: 'attempt-1',
  sceneId: 'scene-current',
  attemptNumber: 1,
  mode: 'original',
  storageKey: 'attempt-1.wav',
  durationMs: 1_000,
  sampleRate: 48_000,
  clock: {
    sampleRate: 48_000,
    startFrame: 0,
    videoStartMediaTime: 0,
    mediaStartOffsetMs: 0,
    estimatedInputLatencyMs: 0,
    clockConfidence: 1,
    sampleContinuityOk: true,
  },
  result: null,
  createdAt: '2026-08-11T00:00:00.000Z',
}

let root: Root | null = null
let container: HTMLDivElement | null = null
let recorder: ReturnType<typeof useRecorder> | null = null
let stopVideo: ReturnType<typeof vi.fn<() => void>>
let revokeObjectUrl: ReturnType<typeof vi.fn<(url: string) => void>>

function Harness() {
  recorder = useRecorder({
    sceneId: 'scene-current',
    segments: [],
    clockRef: { current: null },
    onStartVideo: vi.fn(() => Promise.resolve(true)),
    onStopVideo: stopVideo,
    isVideoBuffered: () => true,
  })
  return null
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  recorder = null
  stopVideo = vi.fn()
  revokeObjectUrl = vi.fn()
  storeMocks.deleteAttemptsForScene.mockResolvedValue(undefined)
  storeMocks.saveAttempt.mockResolvedValue(undefined)
  storeMocks.updateAttemptResult.mockResolvedValue(undefined)
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:generated'),
    revokeObjectURL: revokeObjectUrl,
  })
})

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount()
    })
  }
  container?.remove()
  root = null
  container = null
  recorder = null
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('useRecorder.clearAttempts', () => {
  it('invalida uma restauração atrasada e apaga somente a cena atual', async () => {
    let finishRestore: ((attempts: StoredAttempt[]) => void) | undefined
    storeMocks.listAttempts.mockReturnValue(
      new Promise<StoredAttempt[]>((resolve) => {
        finishRestore = resolve
      }),
    )

    act(() => {
      root?.render(createElement(Harness))
    })

    expect(recorder).not.toBeNull()
    await act(async () => {
      await recorder?.clearAttempts()
    })
    finishRestore?.([STORED_ATTEMPT])
    await flush()

    expect(storeMocks.deleteAttemptsForScene).toHaveBeenCalledExactlyOnceWith('scene-current')
    expect(storeMocks.loadAudioUrl).not.toHaveBeenCalled()
    expect(recorder?.attempts).toEqual([])
    expect(stopVideo).toHaveBeenCalledOnce()
  })

  it('revoga URLs restauradas antes de limpar o estado', async () => {
    storeMocks.listAttempts.mockResolvedValue([STORED_ATTEMPT])
    storeMocks.loadAudioUrl.mockResolvedValue('blob:restored')

    act(() => {
      root?.render(createElement(Harness))
    })
    await flush()
    expect(recorder?.attempts).toHaveLength(1)

    await act(async () => {
      await recorder?.clearAttempts()
    })

    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:restored')
    expect(recorder?.attempts).toEqual([])
  })
})
