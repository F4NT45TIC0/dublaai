'use client'

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { formatTimecode } from '@dubla/shared'

export interface VideoPlayerHandle {
  readonly element: HTMLVideoElement | null
  play: () => Promise<void>
  pause: () => void
  restart: () => void
  seekMs: (ms: number) => void
  setMuted: (muted: boolean) => void
  setVolume: (volume: number) => void
  /** `true` quando a janela pedida já está no buffer (§59). */
  isBuffered: (fromMs: number, toMs: number) => boolean
}

export interface VideoPlayerProps {
  readonly src: string
  /** Áudio separado da referência (os vídeos do catálogo são mudos). */
  readonly referenceAudioSrc?: string
  readonly posterSrc?: string
  readonly durationMs: number
  readonly title: string
  /** Esconde os controles enquanto a mídia é comandada pelo fluxo de gravação. */
  readonly controlsHidden?: boolean
  readonly onReadyChange?: (ready: boolean) => void
  readonly onEnded?: () => void
  readonly onError?: () => void
  readonly children?: React.ReactNode
}

/**
 * Player próprio (§14).
 *
 * O `<video>` nativo é usado como motor, mas nunca com `controls`: a barra do
 * navegador traz botão de download, velocidade e picture-in-picture, e ocupa a
 * parte de baixo do quadro justamente onde a legenda precisa estar.
 *
 * As cenas do catálogo usam vídeo mudo + `referenceAudioSrc`; vídeos enviados
 * podem trazer a própria faixa. `controlsHidden` cuida apenas da interface: o
 * fluxo de gravação decide mute e volume explicitamente pelo handle.
 */
export const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(function VideoPlayer(
  {
    src,
    referenceAudioSrc,
    posterSrc,
    durationMs,
    title,
    controlsHidden = false,
    onReadyChange,
    onEnded,
    onError,
  },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const referenceAudioRef = useRef<HTMLAudioElement | null>(null)
  const referencePlaybackRef = useRef(false)
  const explicitlyMutedRef = useRef(false)
  const volumeRef = useRef(1)
  const [playing, setPlaying] = useState(false)
  const [buffering, setBuffering] = useState(true)
  const [progress, setProgress] = useState(0)
  /**
   * Proporção real do arquivo.
   *
   * A caixa era 16:9 fixa, então um vídeo em pé — que é o formato de quase todo
   * clipe salvo do celular — aparecia como uma tira no meio de duas tarjas
   * pretas enormes. Medir o arquivo e usar a proporção dele faz a moldura
   * abraçar o vídeo em vez de sobrar de lado.
   */
  const [aspect, setAspect] = useState<number | null>(null)

  const isBuffered = useCallback((fromMs: number, toMs: number) => {
    const video = videoRef.current
    if (!video) return false
    const ranges = video.buffered
    for (let index = 0; index < ranges.length; index += 1) {
      if (ranges.start(index) <= fromMs / 1000 + 0.01 && ranges.end(index) >= toMs / 1000 - 0.01) {
        return true
      }
    }
    return false
  }, [])

  const syncReferenceAudio = useCallback(() => {
    const video = videoRef.current
    const audio = referenceAudioRef.current
    if (!video || !audio) return
    if (Math.abs(audio.currentTime - video.currentTime) > 0.08) {
      audio.currentTime = video.currentTime
    }
  }, [])

  const seekReferenceAudio = useCallback(() => {
    const video = videoRef.current
    const audio = referenceAudioRef.current
    if (!video || !audio) return
    audio.currentTime = video.currentTime
  }, [])

  const playMedia = useCallback(async () => {
    const video = videoRef.current
    if (!video) return

    const audio = referenceAudioRef.current
    referencePlaybackRef.current = Boolean(audio) && !explicitlyMutedRef.current

    if (!referencePlaybackRef.current || !audio) {
      await video.play()
      return
    }

    seekReferenceAudio()

    // As duas chamadas precisam acontecer no mesmo gesto. Esperar o vídeo
    // antes de chamar `audio.play()` perde a ativação transitória do clique em
    // alguns navegadores e faz o TTS falhar pela política de autoplay.
    const videoPlayback = video.play()
    const audioPlayback = audio.play().then(
      () => true,
      () => false,
    )

    try {
      await videoPlayback
    } catch (cause) {
      referencePlaybackRef.current = false
      audio.pause()
      throw cause
    }

    if (!(await audioPlayback)) {
      // O vídeo continua disponível se o navegador não decodificar o TTS.
      referencePlaybackRef.current = false
      audio.pause()
    }
  }, [seekReferenceAudio])

  const pauseMedia = useCallback(() => {
    referencePlaybackRef.current = false
    videoRef.current?.pause()
    referenceAudioRef.current?.pause()
  }, [])

  const restartMedia = useCallback(() => {
    const video = videoRef.current
    if (video) video.currentTime = 0
    const audio = referenceAudioRef.current
    if (!audio) return
    audio.currentTime = 0
    if (!video || video.paused) {
      referencePlaybackRef.current = false
      audio.pause()
    }
  }, [])

  const seekMedia = useCallback((ms: number) => {
    const seconds = Math.max(0, ms / 1000)
    const video = videoRef.current
    if (video) video.currentTime = seconds
    const audio = referenceAudioRef.current
    if (!audio) return
    audio.currentTime = seconds
    if (!video || video.paused) {
      referencePlaybackRef.current = false
      audio.pause()
    }
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      get element() {
        return videoRef.current
      },
      play: playMedia,
      pause: pauseMedia,
      restart: restartMedia,
      seekMs: seekMedia,
      setMuted: (muted: boolean) => {
        explicitlyMutedRef.current = muted
        const video = videoRef.current
        if (video) video.muted = muted || Boolean(referenceAudioSrc)
        if (muted) {
          referencePlaybackRef.current = false
          referenceAudioRef.current?.pause()
          return
        }

        const audio = referenceAudioRef.current
        if (video && audio && !video.paused) {
          referencePlaybackRef.current = true
          seekReferenceAudio()
          void audio.play().catch(() => {
            referencePlaybackRef.current = false
            audio.pause()
          })
        }
      },
      setVolume: (volume: number) => {
        const normalized = Math.min(1, Math.max(0, volume))
        volumeRef.current = normalized
        const video = videoRef.current
        if (video) video.volume = normalized
        const audio = referenceAudioRef.current
        if (audio) audio.volume = normalized
      },
      isBuffered,
    }),
    [
      isBuffered,
      pauseMedia,
      playMedia,
      referenceAudioSrc,
      restartMedia,
      seekReferenceAudio,
      seekMedia,
    ],
  )

  useEffect(() => {
    const video = videoRef.current
    if (video) {
      video.muted = explicitlyMutedRef.current || Boolean(referenceAudioSrc)
      video.volume = volumeRef.current
    }
    const audio = referenceAudioRef.current
    if (audio) audio.volume = volumeRef.current
  }, [referenceAudioSrc])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const handlePlay = () => {
      setPlaying(true)
    }
    const handlePlaying = () => {
      const audio = referenceAudioRef.current
      if (!referencePlaybackRef.current || !audio) return
      syncReferenceAudio()
      void audio.play().catch(() => {
        referencePlaybackRef.current = false
      })
    }
    const handlePause = () => {
      setPlaying(false)
      referencePlaybackRef.current = false
      referenceAudioRef.current?.pause()
    }
    const handleWaiting = () => {
      setBuffering(true)
      referenceAudioRef.current?.pause()
      onReadyChange?.(false)
    }
    const handleSeeking = () => {
      // Nunca deixe o TTS avançar enquanto a imagem procura outro quadro.
      referenceAudioRef.current?.pause()
    }
    const handleSeeked = () => {
      const audio = referenceAudioRef.current
      if (!audio) return
      seekReferenceAudio()
      if (referencePlaybackRef.current && !video.paused && !explicitlyMutedRef.current) {
        void audio.play().catch(() => {
          referencePlaybackRef.current = false
          audio.pause()
        })
      }
    }
    const handleReady = () => {
      setBuffering(false)
      onReadyChange?.(true)
    }
    const handleTimeUpdate = () => {
      setProgress(durationMs <= 0 ? 0 : (video.currentTime * 1000) / durationMs)
      if (referencePlaybackRef.current) syncReferenceAudio()
    }
    const handleEnded = () => {
      setPlaying(false)
      referencePlaybackRef.current = false
      referenceAudioRef.current?.pause()
      onEnded?.()
    }
    const handleError = () => {
      referencePlaybackRef.current = false
      referenceAudioRef.current?.pause()
      onError?.()
    }

    video.addEventListener('play', handlePlay)
    video.addEventListener('playing', handlePlaying)
    video.addEventListener('pause', handlePause)
    video.addEventListener('waiting', handleWaiting)
    video.addEventListener('seeking', handleSeeking)
    video.addEventListener('seeked', handleSeeked)
    video.addEventListener('canplaythrough', handleReady)
    video.addEventListener('timeupdate', handleTimeUpdate)
    video.addEventListener('ended', handleEnded)
    video.addEventListener('error', handleError)

    return () => {
      video.removeEventListener('play', handlePlay)
      video.removeEventListener('playing', handlePlaying)
      video.removeEventListener('pause', handlePause)
      video.removeEventListener('waiting', handleWaiting)
      video.removeEventListener('seeking', handleSeeking)
      video.removeEventListener('seeked', handleSeeked)
      video.removeEventListener('canplaythrough', handleReady)
      video.removeEventListener('timeupdate', handleTimeUpdate)
      video.removeEventListener('ended', handleEnded)
      video.removeEventListener('error', handleError)
    }
  }, [durationMs, onEnded, onError, onReadyChange, seekReferenceAudio, syncReferenceAudio])

  useEffect(() => {
    const audio = referenceAudioRef.current
    return () => {
      referencePlaybackRef.current = false
      audio?.pause()
    }
  }, [referenceAudioSrc])

  const toggle = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      void playMedia().catch(() => {
        pauseMedia()
      })
    } else {
      pauseMedia()
    }
  }

  return (
    <div className="relative w-full">
      {/*
        Teto de altura, não de largura: vídeo em pé dentro de uma caixa 16:9
        larga vira uma faixa preta gigante que empurra tudo para fora da tela.
        O `max-w` derivado de 62vh mantém a proporção e limita a altura sem
        precisar saber o formato do arquivo antes de carregá-lo.
      */}
      {/*
        Teto de altura, não de largura: sem ele um vídeo em pé ocuparia a tela
        inteira e empurraria os comandos para fora. `max-w` derivado de 62vh
        limita a altura mantendo a proporção do arquivo.
      */}
      <div
        className="relative mx-auto w-full border-2 border-ink-line bg-black"
        style={{
          aspectRatio: aspect ?? 16 / 9,
          maxWidth: `calc(62vh * ${String(aspect ?? 16 / 9)})`,
        }}
      >
        <video
          ref={videoRef}
          src={src}
          poster={posterSrc}
          preload="auto"
          playsInline
          onLoadedMetadata={(event) => {
            const { videoWidth, videoHeight } = event.currentTarget
            if (videoWidth > 0 && videoHeight > 0) setAspect(videoWidth / videoHeight)
          }}
          {...(referenceAudioSrc ? { muted: true } : {})}
          className="h-full w-full object-contain"
          aria-label={title}
        />
        {referenceAudioSrc ? (
          <audio
            ref={referenceAudioRef}
            src={referenceAudioSrc}
            preload="auto"
            className="hidden"
            aria-hidden="true"
          />
        ) : null}

        {buffering ? (
          <div className="pointer-events-none absolute inset-0 flex items-end justify-start p-4">
            <span className="border-2 border-paper bg-ink px-2 py-1 font-display text-xs uppercase tracking-widest text-paper">
              Carregando…
            </span>
          </div>
        ) : null}
      </div>

      {controlsHidden ? null : (
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={toggle}
            className="flex h-11 min-w-11 items-center justify-center border-2 border-current px-4 font-display text-sm uppercase tracking-widest hover:bg-paper hover:text-ink"
            aria-label={playing ? 'Pausar' : 'Reproduzir'}
          >
            {playing ? '❚❚' : '▶'}
          </button>

          <button
            type="button"
            onClick={() => {
              restartMedia()
            }}
            className="flex h-11 min-w-11 items-center justify-center border-2 border-current px-4 font-display text-sm uppercase tracking-widest hover:bg-paper hover:text-ink"
            aria-label="Recomeçar"
          >
            ↺
          </button>

          <div
            className="relative h-2 flex-1 border-2 border-current"
            role="progressbar"
            aria-label="Progresso da cena"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
          >
            <div
              className="h-full bg-accent"
              style={{ width: `${String(Math.min(100, progress * 100))}%` }}
            />
          </div>

          <span className="font-display text-sm tabular-nums">
            {formatTimecode(progress * durationMs)} / {formatTimecode(durationMs)}
          </span>
        </div>
      )}
    </div>
  )
})
