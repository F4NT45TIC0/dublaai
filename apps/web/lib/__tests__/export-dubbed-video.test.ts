import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportDubbedVideo } from '../export-dubbed-video'

class FakeTrack {
  readonly stop = vi.fn()
  readonly kind: 'audio' | 'video'

  constructor(kind: 'audio' | 'video') {
    this.kind = kind
  }
}

class FakeMediaStream {
  private readonly tracks: FakeTrack[]

  constructor(tracks: FakeTrack[] = []) {
    this.tracks = tracks
  }

  getTracks(): FakeTrack[] {
    return [...this.tracks]
  }

  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === 'audio')
  }

  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === 'video')
  }
}

class FakeBufferSource {
  buffer: AudioBuffer | null = null
  readonly connect = vi.fn()
  readonly start = vi.fn()
  readonly stop = vi.fn()
}

class FakeAudioContext {
  static readonly instances: FakeAudioContext[] = []
  static decodedDuration = 12

  readonly currentTime = 10
  readonly source = new FakeBufferSource()
  readonly audioTrack = new FakeTrack('audio')
  readonly resume = vi.fn(() => Promise.resolve())
  readonly close = vi.fn(() => Promise.resolve())

  constructor() {
    FakeAudioContext.instances.push(this)
  }

  createMediaStreamDestination() {
    return { stream: new FakeMediaStream([this.audioTrack]) }
  }

  createBufferSource(): FakeBufferSource {
    return this.source
  }

  decodeAudioData(): Promise<AudioBuffer> {
    return Promise.resolve({ duration: FakeAudioContext.decodedDuration } as AudioBuffer)
  }
}

class FakeMediaRecorder extends EventTarget {
  static readonly instances: FakeMediaRecorder[] = []
  static readonly isTypeSupported = vi.fn((mimeType: string) => mimeType.includes('webm'))

  state: RecordingState = 'inactive'
  readonly stream: FakeMediaStream
  readonly mimeType: string
  readonly start = vi.fn(() => {
    this.state = 'recording'
  })
  readonly stop = vi.fn(() => {
    if (this.state === 'inactive') return
    this.state = 'inactive'
    const dataEvent = new Event('dataavailable') as BlobEvent
    Object.defineProperty(dataEvent, 'data', {
      value: new Blob(['video-exportado'], { type: this.mimeType }),
    })
    this.dispatchEvent(dataEvent)
    this.dispatchEvent(new Event('stop'))
  })

  constructor(stream: FakeMediaStream, options?: MediaRecorderOptions) {
    super()
    this.stream = stream
    this.mimeType = options?.mimeType ?? 'video/webm'
    FakeMediaRecorder.instances.push(this)
  }
}

interface RenderVideoControl {
  readonly video: HTMLVideoElement
  readonly play: ReturnType<typeof vi.fn<() => Promise<void>>>
  readonly pause: ReturnType<typeof vi.fn<() => void>>
  readonly load: ReturnType<typeof vi.fn<() => void>>
  readonly cancelFrame: ReturnType<typeof vi.fn<(id: number) => void>>
  readonly assignedTimes: number[]
}

let renderVideo: RenderVideoControl
let canvasVideoTrack: FakeTrack
let drawImage: ReturnType<typeof vi.fn>
let originalCaptureStream: PropertyDescriptor | undefined

beforeEach(() => {
  FakeAudioContext.instances.length = 0
  FakeAudioContext.decodedDuration = 12
  FakeMediaRecorder.instances.length = 0
  FakeMediaRecorder.isTypeSupported.mockClear()
  canvasVideoTrack = new FakeTrack('video')
  drawImage = vi.fn()

  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('MediaStream', FakeMediaStream)
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(32)),
      }),
    ),
  )

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D)
  originalCaptureStream = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    'captureStream',
  )
  Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {
    configurable: true,
    value: vi.fn(() => new FakeMediaStream([canvasVideoTrack])),
  })

  const createHtmlElement = (tagName: string) =>
    document.createElementNS('http://www.w3.org/1999/xhtml', tagName)
  renderVideo = createRenderVideo(createHtmlElement('video') as HTMLVideoElement)
  vi.spyOn(document, 'createElement').mockImplementation((tagName: string) =>
    tagName === 'video' ? renderVideo.video : createHtmlElement(tagName),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (originalCaptureStream) {
    Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', originalCaptureStream)
  } else {
    Reflect.deleteProperty(HTMLCanvasElement.prototype, 'captureStream')
  }
})

function createRenderVideo(video: HTMLVideoElement): RenderVideoControl {
  let currentTime = 4
  let paused = true
  let ended = true
  const assignedTimes: number[] = []
  const pause = vi.fn(() => {
    paused = true
  })
  const play = vi.fn(() => {
    paused = false
    setTimeout(() => {
      currentTime = 6
      paused = true
      ended = true
      video.dispatchEvent(new Event('ended'))
    }, 0)
    return Promise.resolve()
  })
  const load = vi.fn()
  const cancelFrame = vi.fn<(id: number) => void>()

  Object.defineProperties(video, {
    readyState: { configurable: true, get: () => HTMLMediaElement.HAVE_ENOUGH_DATA },
    videoWidth: { configurable: true, get: () => 640 },
    videoHeight: { configurable: true, get: () => 360 },
    duration: { configurable: true, get: () => 6 },
    currentTime: {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => {
        currentTime = value
        assignedTimes.push(value)
        queueMicrotask(() => video.dispatchEvent(new Event('seeked')))
      },
    },
    paused: { configurable: true, get: () => paused },
    ended: { configurable: true, get: () => ended },
    play: { configurable: true, value: play },
    pause: { configurable: true, value: pause },
    load: { configurable: true, value: load },
    requestVideoFrameCallback: {
      configurable: true,
      value: vi.fn(() => 1),
    },
    cancelVideoFrameCallback: { configurable: true, value: cancelFrame },
  })

  return { video, play, pause, load, cancelFrame, assignedTimes }
}

function sourceVideo(): HTMLVideoElement {
  return { currentSrc: 'blob:cena-original', src: '' } as HTMLVideoElement
}

describe('exportDubbedVideo — alinhamento de áudio e vídeo', () => {
  it('remove o pré-roll negativo antes de iniciar áudio e vídeo juntos', async () => {
    const progress = vi.fn()
    const result = await exportDubbedVideo({
      video: sourceVideo(),
      wavUrl: 'blob:voz',
      mediaStartOffsetMs: -3_000,
      onProgress: progress,
    })

    const context = FakeAudioContext.instances[0]
    expect(context).toBeDefined()
    expect(context?.source.start).toHaveBeenCalledWith(10, 3)
    expect(renderVideo.assignedTimes[0]).toBe(0)
    expect(renderVideo.play).toHaveBeenCalledOnce()
    expect(progress).toHaveBeenLastCalledWith(1)
    expect(result.extension).toBe('webm')
    expect(result.blob.size).toBeGreaterThan(0)
    expect(context?.close).toHaveBeenCalledOnce()
    expect(context?.audioTrack.stop).toHaveBeenCalled()
    expect(canvasVideoTrack.stop).toHaveBeenCalled()
  })

  it('atrasa o áudio quando a captura começou depois do tempo zero do vídeo', async () => {
    await exportDubbedVideo({
      video: sourceVideo(),
      wavUrl: 'blob:voz',
      mediaStartOffsetMs: 750,
    })

    expect(FakeAudioContext.instances[0]?.source.start).toHaveBeenCalledWith(10.75, 0)
  })

  it('não inicia uma fonte cujo pré-roll consome todo o WAV', async () => {
    FakeAudioContext.decodedDuration = 2

    await exportDubbedVideo({
      video: sourceVideo(),
      wavUrl: 'blob:voz-curta',
      mediaStartOffsetMs: -3_000,
    })

    const source = FakeAudioContext.instances[0]?.source
    expect(source?.start).not.toHaveBeenCalled()
    expect(source?.stop).not.toHaveBeenCalled()
  })

  it('abortar antes de começar não cria contexto nem toca mídia', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      exportDubbedVideo({
        video: sourceVideo(),
        wavUrl: 'blob:voz',
        mediaStartOffsetMs: -3_000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(FakeAudioContext.instances).toHaveLength(0)
    expect(renderVideo.play).not.toHaveBeenCalled()
  })
})
