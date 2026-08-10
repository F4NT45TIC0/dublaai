'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@dubla/ui'
import type { RecorderAttempt } from '@/lib/use-recorder'

export interface AttemptPlaybackProps {
  readonly attempt: RecorderAttempt
  readonly video: HTMLVideoElement | null
}

/**
 * Reproduz a voz do usuário por cima do vídeo — o momento em que o produto se
 * prova (§111.11).
 *
 * Aqui o ÁUDIO é o mestre, invertendo o papel da gravação. O agendamento do
 * elemento de áudio é estável; o vídeo é que deriva, e é ele que corrigimos
 * (docs/AUDIO_PIPELINE.md §6).
 *
 * A correção usa `playbackRate`, não `seek`: ±2% é imperceptível, enquanto um
 * seek trava a imagem e chama mais atenção que o próprio desvio.
 */
export function AttemptPlayback({ attempt, video }: AttemptPlaybackProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const previousVideoMutedRef = useRef<boolean | null>(null)
  const playbackActiveRef = useRef(false)
  const [playing, setPlaying] = useState(false)

  /**
   * Instante do áudio que corresponde ao tempo 0 do vídeo.
   *
   * `mediaStartOffsetMs` é o tempo de vídeo da primeira amostra gravada, e é
   * normalmente NEGATIVO — o gravador foi armado antes do countdown, então a
   * gravação começa alguns segundos antes do vídeo.
   */
  const audioTimeAtVideoZero = Math.max(0, -attempt.clock.mediaStartOffsetMs / 1000)
  const videoTimeAtAudioZero = Math.max(0, attempt.clock.mediaStartOffsetMs / 1000)

  const stop = useCallback(() => {
    playbackActiveRef.current = false
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    const audio = audioRef.current
    if (audio) {
      audio.pause()
      audio.muted = false
      audio.loop = false
    }
    if (video) {
      video.pause()
      video.playbackRate = 1
      if (previousVideoMutedRef.current !== null) {
        video.muted = previousVideoMutedRef.current
        previousVideoMutedRef.current = null
      }
    }
    setPlaying(false)
  }, [video])

  // §67 — nada de rAF ou mídia tocando depois que o componente sai.
  useEffect(() => stop, [stop])

  useEffect(() => {
    if (!video) return

    const handleVideoStopped = (event: Event) => {
      if (!playbackActiveRef.current) return

      // `pause()` used to stop the reference track queues a pause event. If
      // the attempt has already restarted the video by the time it arrives,
      // it belongs to the previous playback and must not stop the new one.
      if (event.type === 'pause' && !video.paused) return
      stop()
    }

    video.addEventListener('pause', handleVideoStopped)
    video.addEventListener('ended', handleVideoStopped)
    video.addEventListener('error', handleVideoStopped)
    return () => {
      video.removeEventListener('pause', handleVideoStopped)
      video.removeEventListener('ended', handleVideoStopped)
      video.removeEventListener('error', handleVideoStopped)
    }
  }, [stop, video])

  const play = useCallback(async () => {
    const audio = audioRef.current
    if (!audio || !video || playbackActiveRef.current) return

    // Se a pessoa estava ouvindo a referência, o `pause` também encerra o
    // TTS separado do VideoPlayer antes de começar a própria dublagem.
    video.pause()
    audio.currentTime = audioTimeAtVideoZero
    audio.muted = videoTimeAtAudioZero > 0
    audio.loop = videoTimeAtAudioZero > 0
    video.currentTime = 0
    video.playbackRate = 1
    previousVideoMutedRef.current ??= video.muted
    video.muted = true
    playbackActiveRef.current = true

    try {
      await Promise.all([audio.play(), video.play()])
    } catch (cause) {
      stop()
      throw cause
    }
    setPlaying(true)
    let delayedAudioStarted = videoTimeAtAudioZero <= 0

    const tick = () => {
      if (
        !playbackActiveRef.current ||
        video.paused ||
        video.ended ||
        (delayedAudioStarted && (audio.paused || audio.ended))
      ) {
        stop()
        return
      }

      if (!delayedAudioStarted) {
        if (video.currentTime < videoTimeAtAudioZero) {
          // The recording started after the video. Keep the audio element
          // playing silently and looping (preserving the user gesture) until
          // the video reaches the first captured sample.
          video.playbackRate = 1
          rafRef.current = requestAnimationFrame(tick)
          return
        }

        audio.loop = false
        audio.currentTime = 0
        audio.muted = false
        delayedAudioStarted = true
      }

      const expectedVideoTime =
        videoTimeAtAudioZero + audio.currentTime - audioTimeAtVideoZero
      const errorSec = expectedVideoTime - video.currentTime

      if (Math.abs(errorSec) > 0.25) {
        // Desvio grande demais para corrigir suavemente: seek único.
        video.currentTime = Math.max(0, expectedVideoTime)
        video.playbackRate = 1
      } else if (Math.abs(errorSec) > 0.015) {
        video.playbackRate = 1 + Math.max(-0.02, Math.min(0.02, errorSec))
      } else {
        video.playbackRate = 1
      }

      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [audioTimeAtVideoZero, stop, video, videoTimeAtAudioZero])

  return (
    <div className="flex flex-col gap-3">
      <audio
        ref={audioRef}
        src={attempt.wavUrl}
        preload="auto"
        onEnded={stop}
        className="hidden"
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="lg"
          onClick={() => {
            if (playing) stop()
            else void play().catch(() => undefined)
          }}
        >
          {playing ? '■ Parar' : '▶ Ouvir com o vídeo'}
        </Button>

        <a
          href={attempt.wavUrl}
          download={`dublagem-tentativa-${String(attempt.attemptNumber)}.wav`}
          className="inline-flex min-h-11 items-center border-2 border-current px-4 font-display text-sm uppercase tracking-widest hover:bg-paper hover:text-ink"
        >
          Baixar áudio
        </a>
      </div>

      {attempt.clock.clockConfidence < 0.8 ? (
        <p className="border-2 border-warn px-3 py-2 text-xs text-warn">
          O encaixe com o vídeo pode estar um pouco fora nesta tentativa — o navegador não
          conseguiu medir o tempo dos quadros com precisão.
        </p>
      ) : null}
    </div>
  )
}
