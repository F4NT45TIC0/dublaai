const EXPORT_FPS = 30
const MAX_EXPORT_EDGE = 1_920

const RECORDING_FORMATS = [
  { mimeType: 'video/mp4;codecs=avc1,mp4a.40.2', extension: 'mp4' },
  { mimeType: 'video/mp4', extension: 'mp4' },
  { mimeType: 'video/webm;codecs=vp9,opus', extension: 'webm' },
  { mimeType: 'video/webm;codecs=vp8,opus', extension: 'webm' },
  { mimeType: 'video/webm', extension: 'webm' },
] as const

export interface ExportDubbedVideoOptions {
  readonly video: HTMLVideoElement
  readonly wavUrl: string
  readonly mediaStartOffsetMs: number
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: number) => void
}

export interface ExportedDubbedVideo {
  readonly blob: Blob
  readonly extension: 'webm' | 'mp4'
}

interface RecordingFormat {
  readonly mimeType: string
  readonly extension: 'webm' | 'mp4'
}

/**
 * Junta o vídeo local e o WAV da tentativa inteiramente no navegador.
 *
 * O canvas é proposital: ele captura apenas a imagem e garante que a faixa de
 * áudio original do arquivo não vaze para a dublagem exportada.
 */
export async function exportDubbedVideo(
  options: ExportDubbedVideoOptions,
): Promise<ExportedDubbedVideo> {
  assertExportSupport()
  throwIfAborted(options.signal)

  const source = options.video.currentSrc || options.video.src
  if (source.length === 0) throw new Error('O vídeo selecionado não está mais disponível.')

  // A exportação usa um player próprio. Assim, pausar ou rever a cena na tela
  // não interfere no arquivo que está sendo renderizado.
  const renderVideo = document.createElement('video')
  renderVideo.preload = 'auto'
  renderVideo.playsInline = true
  renderVideo.muted = true
  renderVideo.src = source

  // Criar e retomar o contexto ainda dentro do clique preserva a autorização
  // de áudio; esperar o `loadeddata` primeiro perderia o gesto do usuário.
  const audioContext = new AudioContext({ latencyHint: 'playback' })
  const audioReady = audioContext.resume()

  try {
    return await renderDubbedVideo({ ...options, video: renderVideo }, audioContext, audioReady)
  } finally {
    renderVideo.pause()
    renderVideo.removeAttribute('src')
    renderVideo.load()
    await audioContext.close().catch(() => undefined)
  }
}

async function renderDubbedVideo(
  { video, wavUrl, mediaStartOffsetMs, signal, onProgress }: ExportDubbedVideoOptions,
  audioContext: AudioContext,
  audioReady: Promise<void>,
): Promise<ExportedDubbedVideo> {
  await prepareVideo(video, signal)

  const canvas = document.createElement('canvas')
  const { width, height } = exportDimensions(video.videoWidth, video.videoHeight)
  canvas.width = width
  canvas.height = height

  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('Não foi possível preparar a imagem para exportação.')
  context.drawImage(video, 0, 0, width, height)

  const canvasStream = canvas.captureStream(EXPORT_FPS)
  const videoTrack = canvasStream.getVideoTracks()[0]
  if (!videoTrack) throw new Error('O navegador não conseguiu capturar o vídeo.')

  const audioDestination = audioContext.createMediaStreamDestination()
  const audioSource = audioContext.createBufferSource()
  const combinedStream = new MediaStream([videoTrack, ...audioDestination.stream.getAudioTracks()])
  const format = selectRecordingFormat()
  const chunks: Blob[] = []
  let recorder: MediaRecorder | null = null
  let frameCallbackId: number | null = null
  let animationFrameId: number | null = null
  let sourceStarted = false

  try {
    const response = await fetch(wavUrl, { signal })
    if (!response.ok) throw new Error('Não foi possível abrir a sua gravação.')
    const wav = await response.arrayBuffer()
    audioSource.buffer = await audioContext.decodeAudioData(wav.slice(0))
    audioSource.connect(audioDestination)

    recorder = createRecorder(combinedStream, format.mimeType)
    const stopped = recorderResult(recorder, chunks, signal)

    const drawFrame = () => {
      if (video.ended || video.paused) return
      context.drawImage(video, 0, 0, width, height)
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1
      onProgress?.(Math.min(1, video.currentTime / duration))

      if (typeof video.requestVideoFrameCallback === 'function') {
        frameCallbackId = video.requestVideoFrameCallback(drawFrame)
      } else {
        animationFrameId = requestAnimationFrame(drawFrame)
      }
    }

    const ended = waitForVideoEnd(video, signal)
    recorder.start(1_000)
    await audioReady
    await video.play()

    if (typeof video.requestVideoFrameCallback === 'function') {
      frameCallbackId = video.requestVideoFrameCallback(drawFrame)
    } else {
      animationFrameId = requestAnimationFrame(drawFrame)
    }

    const audioOffsetSeconds = Math.max(0, -mediaStartOffsetMs / 1_000)
    const audioDelaySeconds = Math.max(0, mediaStartOffsetMs / 1_000)
    if (audioOffsetSeconds < audioSource.buffer.duration) {
      audioSource.start(audioContext.currentTime + audioDelaySeconds, audioOffsetSeconds)
      sourceStarted = true
    }

    await ended
    context.drawImage(video, 0, 0, width, height)
    onProgress?.(1)
    recorder.stop()
    await stopped

    const mimeType = recorder.mimeType || format.mimeType
    const blob = new Blob(chunks, { type: mimeType })
    if (blob.size === 0) throw new Error('O navegador gerou um vídeo vazio.')

    return { blob, extension: extensionForMime(mimeType, format.extension) }
  } finally {
    video.pause()
    video.playbackRate = 1
    if (frameCallbackId !== null && typeof video.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(frameCallbackId)
    }
    if (animationFrameId !== null) cancelAnimationFrame(animationFrameId)
    if (recorder?.state === 'recording') recorder.stop()
    if (sourceStarted) {
      try {
        audioSource.stop()
      } catch {
        // A fonte já terminou junto com o vídeo.
      }
    }
    for (const track of combinedStream.getTracks()) track.stop()
  }
}

function assertExportSupport(): void {
  if (typeof MediaRecorder !== 'function' || typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
    throw new Error('Este navegador não consegue gerar o vídeo final. Tente usar Chrome ou Edge.')
  }
}

async function prepareVideo(video: HTMLVideoElement, signal?: AbortSignal): Promise<void> {
  video.pause()
  video.muted = true
  video.playbackRate = 1

  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    await waitForMediaEvent(video, 'loadeddata', signal)
  }

  if (video.currentTime > 0.01 || video.ended) {
    const seeked = waitForMediaEvent(video, 'seeked', signal)
    video.currentTime = 0
    await seeked
  } else {
    video.currentTime = 0
  }
}

function waitForMediaEvent(
  video: HTMLVideoElement,
  eventName: 'loadeddata' | 'seeked',
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener(eventName, onReady)
      video.removeEventListener('error', onError)
      signal?.removeEventListener('abort', onAbort)
    }
    const onReady = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error('O vídeo não pôde ser lido durante a exportação.'))
    }
    const onAbort = () => {
      cleanup()
      reject(abortError())
    }

    video.addEventListener(eventName, onReady, { once: true })
    video.addEventListener('error', onError, { once: true })
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function waitForVideoEnd(video: HTMLVideoElement, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('ended', onEnded)
      video.removeEventListener('error', onError)
      signal?.removeEventListener('abort', onAbort)
    }
    const onEnded = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error('O vídeo falhou durante a exportação.'))
    }
    const onAbort = () => {
      cleanup()
      reject(abortError())
    }

    video.addEventListener('ended', onEnded, { once: true })
    video.addEventListener('error', onError, { once: true })
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function recorderResult(
  recorder: MediaRecorder,
  chunks: Blob[],
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    })
    recorder.addEventListener(
      'stop',
      () => {
        resolve()
      },
      { once: true },
    )
    recorder.addEventListener(
      'error',
      () => {
        reject(new Error('O navegador falhou ao codificar o vídeo.'))
      },
      { once: true },
    )
    signal?.addEventListener(
      'abort',
      () => {
        if (recorder.state === 'recording') recorder.stop()
      },
      { once: true },
    )
  })
}

function createRecorder(stream: MediaStream, mimeType: string): MediaRecorder {
  try {
    return new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 8_000_000,
      audioBitsPerSecond: 192_000,
    })
  } catch {
    return new MediaRecorder(stream, { mimeType })
  }
}

function selectRecordingFormat(): RecordingFormat {
  const supported = RECORDING_FORMATS.find(({ mimeType }) => MediaRecorder.isTypeSupported(mimeType))
  if (!supported) throw new Error('Este navegador não oferece um formato de vídeo exportável.')
  return supported
}

function extensionForMime(mimeType: string, fallback: 'webm' | 'mp4'): 'webm' | 'mp4' {
  if (mimeType.toLowerCase().includes('mp4')) return 'mp4'
  if (mimeType.toLowerCase().includes('webm')) return 'webm'
  return fallback
}

function exportDimensions(sourceWidth: number, sourceHeight: number) {
  const scale = Math.min(1, MAX_EXPORT_EDGE / Math.max(sourceWidth, sourceHeight))
  const even = (value: number) => Math.max(2, Math.round((value * scale) / 2) * 2)
  return { width: even(sourceWidth), height: even(sourceHeight) }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw abortError()
}

function abortError(): DOMException {
  return new DOMException('Exportação cancelada.', 'AbortError')
}
