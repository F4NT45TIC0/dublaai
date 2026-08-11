import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttemptPlayback } from '../../components/dub/attempt-playback'
import type { RecorderAttempt } from '../use-recorder'

interface ControlledMedia {
  readonly element: HTMLMediaElement
  readonly play: ReturnType<typeof vi.fn<() => Promise<void>>>
  readonly pause: ReturnType<typeof vi.fn<() => void>>
  readonly isPaused: () => boolean
}

const ATTEMPT: RecorderAttempt = {
  id: 'attempt-1',
  attemptNumber: 1,
  wavUrl: 'blob:attempt-1',
  durationMs: 8_000,
  clock: {
    sampleRate: 48_000,
    startFrame: 0,
    videoStartMediaTime: 0,
    mediaStartOffsetMs: -3_000,
    estimatedInputLatencyMs: 10,
    clockConfidence: 0.99,
    sampleContinuityOk: true,
  },
  result: null,
}

let root: Root | null = null
let container: HTMLDivElement | null = null
let rafCallbacks: Map<number, FrameRequestCallback>
let nextRafId: number

beforeEach(() => {
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  rafCallbacks = new Map()
  nextRafId = 1
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      const id = nextRafId
      nextRafId += 1
      rafCallbacks.set(id, callback)
      return id
    }),
  )
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number) => {
      rafCallbacks.delete(id)
    }),
  )
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
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function controlMedia<T extends HTMLMediaElement>(element: T): ControlledMedia & { element: T } {
  let paused = true
  const play = vi.fn(() => {
    paused = false
    return Promise.resolve()
  })
  const pause = vi.fn(() => {
    paused = true
  })
  Object.defineProperty(element, 'paused', {
    configurable: true,
    get: () => paused,
  })
  Object.defineProperty(element, 'play', { configurable: true, value: play })
  Object.defineProperty(element, 'pause', { configurable: true, value: pause })
  return { element, play, pause, isPaused: () => paused }
}

function mountPlayback(attempt = ATTEMPT, playUntilMs?: number) {
  const video = controlMedia(document.createElement('video'))
  video.element.muted = false
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)

  act(() => {
    root?.render(
      createElement(AttemptPlayback, {
        attempt,
        video: video.element,
        ...(playUntilMs === undefined ? {} : { playUntilMs }),
      }),
    )
  })

  const audioElement = container.querySelector('audio')
  const button = container.querySelector('button')
  if (!(audioElement instanceof HTMLAudioElement) || !(button instanceof HTMLButtonElement)) {
    throw new Error('Controles de playback não renderizados')
  }
  const audio = controlMedia(audioElement)
  return { audio, video, button }
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click()
    await Promise.resolve()
  })
}

function runNextFrame(perfMs = 0): void {
  const pending = [...rafCallbacks.values()]
  rafCallbacks.clear()
  for (const callback of pending) callback(perfMs)
}

describe('AttemptPlayback — alinhamento determinístico', () => {
  it('oferece uma única ação direta para ouvir o vídeo', () => {
    const { button } = mountPlayback()

    expect(button.textContent).toBe('Ouvir vídeo')
  })

  it('remove o pré-roll e corrige drift pequeno ou grande contra o áudio mestre', async () => {
    const { audio, video, button } = mountPlayback()

    await click(button)

    expect(audio.element.currentTime).toBe(3)
    expect(video.element.currentTime).toBe(0)
    expect(audio.play).toHaveBeenCalledOnce()
    expect(video.play).toHaveBeenCalledOnce()
    expect(video.element.muted).toBe(true)

    audio.element.currentTime = 3.1
    video.element.currentTime = 0.05
    act(() => {
      runNextFrame()
    })
    expect(video.element.playbackRate).toBeCloseTo(1.02, 6)

    audio.element.currentTime = 3.8
    video.element.currentTime = 0.1
    act(() => {
      runNextFrame()
    })
    expect(video.element.currentTime).toBeCloseTo(0.8, 6)
    expect(video.element.playbackRate).toBe(1)
  })

  it('respeita o atraso quando a primeira amostra foi capturada depois do vídeo', async () => {
    const delayedAttempt: RecorderAttempt = {
      ...ATTEMPT,
      clock: { ...ATTEMPT.clock, mediaStartOffsetMs: 2_000 },
    }
    const { audio, video, button } = mountPlayback(delayedAttempt)

    await click(button)

    expect(audio.element.currentTime).toBe(0)
    expect(audio.element.muted).toBe(true)
    expect(audio.element.loop).toBe(true)
    expect(video.element.currentTime).toBe(0)

    audio.element.currentTime = 0.25
    video.element.currentTime = 1
    act(() => {
      runNextFrame()
    })
    expect(audio.element.currentTime).toBe(0.25)
    expect(audio.element.muted).toBe(true)
    expect(audio.element.loop).toBe(true)
    expect(video.element.playbackRate).toBe(1)

    audio.element.currentTime = 0.1
    video.element.currentTime = 2
    act(() => {
      runNextFrame()
    })
    expect(audio.element.currentTime).toBe(0)
    expect(audio.element.muted).toBe(false)
    expect(audio.element.loop).toBe(false)

    audio.element.currentTime = 0.5
    video.element.currentTime = 2.4
    act(() => {
      runNextFrame()
    })
    expect(video.element.playbackRate).toBeCloseTo(1.02, 6)

    await click(button)
    expect(audio.element.muted).toBe(false)
    expect(audio.element.loop).toBe(false)
  })

  it('ignora o evento de pause atrasado da referência anterior', async () => {
    const { audio, video, button } = mountPlayback()
    await video.play()

    await click(button)
    expect(audio.isPaused()).toBe(false)
    expect(video.isPaused()).toBe(false)

    act(() => {
      video.element.dispatchEvent(new Event('pause'))
    })

    expect(audio.isPaused()).toBe(false)
    expect(video.isPaused()).toBe(false)
    expect(video.element.muted).toBe(true)
  })

  it('parar restaura o vídeo e reiniciar volta exatamente ao mesmo ponto', async () => {
    const { audio, video, button } = mountPlayback()
    await click(button)

    audio.element.currentTime = 5
    video.element.currentTime = 2
    video.element.playbackRate = 1.02
    await click(button)

    expect(audio.pause).toHaveBeenCalled()
    expect(video.pause).toHaveBeenCalled()
    expect(video.element.playbackRate).toBe(1)
    expect(video.element.muted).toBe(false)
    expect(rafCallbacks.size).toBe(0)

    await click(button)
    expect(audio.element.currentTime).toBe(3)
    expect(video.element.currentTime).toBe(0)
    expect(audio.play).toHaveBeenCalledTimes(2)
    expect(video.play).toHaveBeenCalledTimes(2)

    act(() => {
      audio.element.dispatchEvent(new Event('ended'))
    })
    expect(audio.isPaused()).toBe(true)
    expect(video.isPaused()).toBe(true)
    expect(video.element.muted).toBe(false)
  })

  it('encerra áudio e vídeo no limite opcional da prévia parcial', async () => {
    const { audio, video, button } = mountPlayback(ATTEMPT, 1_500)
    await click(button)

    audio.element.currentTime = 4.49
    video.element.currentTime = 1.49
    act(() => {
      runNextFrame()
    })
    expect(audio.isPaused()).toBe(false)
    expect(video.isPaused()).toBe(false)

    audio.element.currentTime = 4.5
    video.element.currentTime = 1.5
    act(() => {
      runNextFrame()
    })

    expect(audio.isPaused()).toBe(true)
    expect(video.isPaused()).toBe(true)
    expect(video.element.playbackRate).toBe(1)
    expect(video.element.muted).toBe(false)
  })

  it('falha de play limpa os dois players e restaura o mute anterior', async () => {
    const { audio, video, button } = mountPlayback()
    video.element.muted = true
    video.play.mockRejectedValueOnce(new Error('autoplay bloqueado'))

    await click(button)

    expect(audio.pause).toHaveBeenCalled()
    expect(video.pause).toHaveBeenCalled()
    expect(video.element.playbackRate).toBe(1)
    expect(video.element.muted).toBe(true)
    expect(rafCallbacks.size).toBe(0)
  })
})
