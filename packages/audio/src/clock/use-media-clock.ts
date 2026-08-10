'use client'

import { useEffect, useRef, useState } from 'react'
import { MediaClock } from './media-clock'

export interface UseMediaClockResult {
  readonly clockRef: React.RefObject<MediaClock | null>
  /** Tempo de mídia em segundos, atualizado por quadro. Leia dentro de rAF. */
  readonly mediaTimeRef: React.RefObject<number>
  readonly ready: boolean
}

/**
 * Liga um `MediaClock` a um elemento de vídeo e entrega o tempo de mídia por
 * quadro de animação.
 *
 * Recebe o ELEMENTO, não um ref para ele. A diferença importa: um `RefObject`
 * é estável, então um efeito que depende dele roda uma única vez — e se o
 * elemento ainda não existir naquele instante (o player é um filho, montado
 * depois), o efeito desiste em silêncio e nunca mais tenta. Com o elemento em
 * estado, montá-lo dispara o efeito naturalmente.
 *
 * O tempo NÃO vira estado do React: `setState` a 60 fps causaria uma re-render
 * por quadro em toda a árvore. Os consumidores leem de um ref dentro do próprio
 * rAF — legenda e waveform se atualizam sem que o React participe (§61, §69).
 */
export function useMediaClock(video: HTMLVideoElement | null): UseMediaClockResult {
  const clockRef = useRef<MediaClock | null>(null)
  const mediaTimeRef = useRef(0)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!video) return

    const clock = new MediaClock(video)
    clockRef.current = clock
    clock.start()
    setReady(true)

    let rafId = requestAnimationFrame(function tick() {
      mediaTimeRef.current = clock.now().mediaTimeSec
      rafId = requestAnimationFrame(tick)
    })

    const handleSeek = () => {
      clock.reset()
      mediaTimeRef.current = video.currentTime
    }
    video.addEventListener('seeking', handleSeek)

    return () => {
      // §67 — cleanup obrigatório: sem isto, cada montagem deixa um rAF vivo.
      cancelAnimationFrame(rafId)
      video.removeEventListener('seeking', handleSeek)
      clock.stop()
      clockRef.current = null
      setReady(false)
    }
  }, [video])

  return { clockRef, mediaTimeRef, ready }
}
