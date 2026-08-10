import { MAX_VIDEO_BYTES } from './local-video'

export interface DownloadRemoteVideoOptions {
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: number | null) => void
}

const REMOTE_TIMEOUT_MS = 30_000
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const PAGE_HOSTS = ['youtube.com', 'youtu.be', 'tiktok.com', 'instagram.com']

export function validateRemoteVideoUrl(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return 'Cole uma URL direta de vídeo.'
  if (trimmed.length > 4_096) return 'A URL é longa demais.'

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return 'Digite uma URL completa, começando com https://.'
  }

  if (url.username.length > 0 || url.password.length > 0) {
    return 'URLs com usuário ou senha embutidos não são aceitas.'
  }

  const localHttp = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !localHttp) {
    return 'Use uma URL HTTPS direta. HTTP só é aceito para localhost.'
  }

  const hostname = url.hostname.toLowerCase()
  if (PAGE_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
    return 'Links de páginas como YouTube, TikTok ou Instagram não são arquivos de vídeo diretos.'
  }

  const path = url.pathname.toLowerCase()
  if (path.endsWith('.m3u8') || path.endsWith('.mpd')) {
    return 'Playlists HLS/DASH não são suportadas. Use uma URL direta para MP4, WebM ou MOV.'
  }

  return null
}

/** Baixa a URL indicada sem cookies e impõe o limite durante o streaming. */
export async function downloadRemoteVideo(
  value: string,
  options: DownloadRemoteVideoOptions = {},
): Promise<File> {
  const validationError = validateRemoteVideoUrl(value)
  if (validationError) throw new Error(validationError)

  const url = new URL(value.trim())
  const controller = new AbortController()
  const timeoutReason = new DOMException('Tempo esgotado.', 'TimeoutError')
  const timeoutId = setTimeout(() => {
    controller.abort(timeoutReason)
  }, REMOTE_TIMEOUT_MS)
  const onAbort = () => {
    controller.abort()
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const response = await fetch(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`A URL respondeu com HTTP ${String(response.status)}.`)
    }

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    if (
      contentType.includes('text/html') ||
      contentType.includes('application/json') ||
      contentType.includes('mpegurl') ||
      contentType.includes('dash+xml')
    ) {
      throw new Error('Essa URL aponta para uma página ou playlist. Use o link direto do arquivo de vídeo.')
    }
    if (
      contentType.length > 0 &&
      !contentType.startsWith('video/') &&
      contentType !== 'application/octet-stream'
    ) {
      throw new Error('A resposta da URL não contém um arquivo de vídeo reconhecido.')
    }

    const declaredLength = Number(response.headers.get('content-length') ?? 0)
    if (Number.isFinite(declaredLength) && declaredLength > MAX_VIDEO_BYTES) {
      throw new Error('O vídeo da URL ultrapassa o limite de 1 GB.')
    }

    const chunks: ArrayBuffer[] = []
    let received = 0
    if (!response.body) {
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength > MAX_VIDEO_BYTES) {
        throw new Error('O vídeo da URL ultrapassa o limite de 1 GB.')
      }
      chunks.push(buffer)
      received = buffer.byteLength
    } else {
      const reader = response.body.getReader()
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        received += part.value.byteLength
        if (received > MAX_VIDEO_BYTES) {
          await reader.cancel()
          throw new Error('O vídeo da URL ultrapassa o limite de 1 GB.')
        }
        chunks.push(
          part.value.buffer.slice(
            part.value.byteOffset,
            part.value.byteOffset + part.value.byteLength,
          ),
        )
        options.onProgress?.(declaredLength > 0 ? Math.min(1, received / declaredLength) : null)
      }
    }

    if (received === 0) throw new Error('A URL devolveu um arquivo vazio.')
    options.onProgress?.(1)

    const finalType = contentType.startsWith('video/') ? contentType : inferMimeType(url.pathname)
    return new File(chunks, fileNameFromUrl(url, finalType), {
      type: finalType,
      lastModified: 0,
    })
  } catch (cause) {
    if (cause instanceof DOMException) {
      if (options.signal?.aborted === true) throw cause
      if (cause.name === 'TimeoutError' || controller.signal.reason === timeoutReason) {
        throw new Error('A URL demorou mais de 30 segundos para responder.', { cause })
      }
    }
    if (cause instanceof TypeError) {
      throw new Error(
        'Não foi possível baixar essa URL. Ela precisa ser direta e permitir acesso CORS pelo navegador.',
        { cause },
      )
    }
    throw cause
  } finally {
    clearTimeout(timeoutId)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

function fileNameFromUrl(url: URL, mimeType: string): string {
  const raw = url.pathname.split('/').filter(Boolean).pop() ?? ''
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    // Mantém o trecho original se o percent-encoding estiver incompleto.
  }
  const safe = decoded.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120)
  if (/\.(mp4|webm|mov|m4v)$/i.test(safe)) return safe
  return `video-remoto.${extensionForMime(mimeType)}`
}

function inferMimeType(path: string): string {
  if (/\.webm$/i.test(path)) return 'video/webm'
  if (/\.(mov|m4v)$/i.test(path)) return 'video/quicktime'
  return 'video/mp4'
}

function extensionForMime(mimeType: string): string {
  if (mimeType.includes('webm')) return 'webm'
  if (mimeType.includes('quicktime')) return 'mov'
  return 'mp4'
}
