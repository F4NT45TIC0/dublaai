import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AudioCaptureService } from '../capture/audio-capture-service'

class FakeTrack extends EventTarget {
  readonly stop = vi.fn()
  readonly label = 'Microfone de teste'

  getSettings(): MediaTrackSettings {
    return {}
  }
}

function streamWith(track: FakeTrack): MediaStream {
  return {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream
}

class FakeAudioContext {
  static readonly instances: FakeAudioContext[] = []
  static failWorklet = false

  state: AudioContextState = 'running'
  readonly sampleRate = 48_000
  readonly baseLatency = 0.01
  readonly close = vi.fn(() => {
    this.state = 'closed'
    return Promise.resolve()
  })
  readonly resume = vi.fn(() => Promise.resolve())
  readonly audioWorklet = {
    addModule: vi.fn(() => {
      if (FakeAudioContext.failWorklet) {
        return Promise.reject(new Error('worklet indisponível'))
      }
      return Promise.resolve()
    }),
  }
  readonly source = {
    connect: vi.fn(),
    disconnect: vi.fn(),
  }

  constructor() {
    FakeAudioContext.instances.push(this)
  }

  createMediaStreamSource(): MediaStreamAudioSourceNode {
    return this.source as unknown as MediaStreamAudioSourceNode
  }
}

class FakeAudioWorkletNode {
  readonly port = {
    onmessage: null,
    postMessage: vi.fn(),
  }
  readonly disconnect = vi.fn()
}

let originalMediaDevices: PropertyDescriptor | undefined

beforeEach(() => {
  FakeAudioContext.instances.length = 0
  FakeAudioContext.failWorklet = false
  originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode)
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (originalMediaDevices) {
    Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices)
  } else {
    Reflect.deleteProperty(navigator, 'mediaDevices')
  }
})

function setGetUserMedia(implementation: () => Promise<MediaStream>): void {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(implementation),
      enumerateDevices: vi.fn(() => Promise.resolve([])),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  })
}

describe('AudioCaptureService — ciclo de vida', () => {
  it('não ressuscita uma stream cuja permissão resolveu depois do fechamento', async () => {
    const track = new FakeTrack()
    let resolveStream: ((stream: MediaStream) => void) | undefined
    setGetUserMedia(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveStream = resolve
        }),
    )

    const service = new AudioCaptureService()
    const starting = service.start(undefined, {})
    await service.close()
    resolveStream?.(streamWith(track))

    await expect(starting).rejects.toMatchObject({ name: 'AbortError' })
    expect(track.stop).toHaveBeenCalled()
    expect(FakeAudioContext.instances).toHaveLength(0)
  })

  it('libera a stream quando a inicialização falha depois do getUserMedia', async () => {
    const track = new FakeTrack()
    setGetUserMedia(() => Promise.resolve(streamWith(track)))
    FakeAudioContext.failWorklet = true

    const service = new AudioCaptureService()
    await expect(service.start(undefined, {})).rejects.toMatchObject({ code: 'BROWSER_UNSUPPORTED' })

    expect(track.stop).toHaveBeenCalled()
    await service.close()
  })

  it('fecha o AudioContext e para a track ao encerrar a sessão', async () => {
    const track = new FakeTrack()
    setGetUserMedia(() => Promise.resolve(streamWith(track)))

    const service = new AudioCaptureService()
    await service.start(undefined, {})
    const context = FakeAudioContext.instances[0]
    expect(context).toBeDefined()

    await service.close()

    expect(track.stop).toHaveBeenCalled()
    expect(context?.close).toHaveBeenCalledOnce()
  })
})
