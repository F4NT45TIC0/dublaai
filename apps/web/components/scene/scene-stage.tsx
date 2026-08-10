'use client'

import { useCallback, useRef, useState } from 'react'
import type { SceneDetail } from '@dubla/shared'
import { formatTimecode } from '@dubla/shared'
import { useMediaClock } from '@dubla/audio'
import { CharacterBadge, ErrorState } from '@dubla/ui'
import { VideoPlayer, type VideoPlayerHandle } from './video-player'
import { SubtitleRenderer } from './subtitle-renderer'
import { Waveform } from './waveform'
import { DubPanel } from '@/components/dub/dub-panel'
import { useReferenceFeatures } from '@/lib/use-reference-features'

export interface SceneStageProps {
  readonly scene: SceneDetail
  readonly videoUrl: string
  readonly referenceAudioUrl: string
  readonly posterUrl?: string
  readonly featuresUrl: string
}

/**
 * Palco da cena: vídeo, legenda e waveform sobre a mesma timeline.
 *
 * Tudo aqui acompanha `video.currentTime` através do `MediaClock` — nenhum
 * componente mantém o próprio cronômetro (§17). O tempo circula por um ref lido
 * dentro de rAF, e não por estado do React, para que 60 quadros por segundo não
 * signifiquem 60 renders por segundo.
 */
export function SceneStage({
  scene,
  videoUrl,
  referenceAudioUrl,
  posterUrl,
  featuresUrl,
}: SceneStageProps) {
  const playerRef = useRef<VideoPlayerHandle | null>(null)
  const [videoFailed, setVideoFailed] = useState(false)

  // Estado, e não ref: o player é um filho e monta depois do palco. Guardar o
  // elemento num ref não acordaria o efeito do relógio, que ficaria parado
  // para sempre com o vídeo tocando.
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null)

  const attachVideo = useCallback((handle: VideoPlayerHandle | null) => {
    playerRef.current = handle
    setVideoElement(handle?.element ?? null)
  }, [])

  const { clockRef, mediaTimeRef } = useMediaClock(videoElement)
  const features = useReferenceFeatures(featuresUrl)

  const handleSeek = useCallback((ms: number) => {
    playerRef.current?.seekMs(ms)
  }, [])

  /** Leva o vídeo ao início e toca. É o t=0 oficial da tentativa. */
  const startVideo = useCallback(async (fromMs: number) => {
    const player = playerRef.current
    if (!player) return false
    // No modo fala-a-fala a tomada não começa no zero da cena.
    if (fromMs > 0) player.seekMs(fromMs)
    else player.restart()
    player.setMuted(true)
    try {
      await player.play()
      return true
    } catch {
      player.setMuted(false)
      return false
    }
  }, [])

  const stopVideo = useCallback(() => {
    playerRef.current?.pause()
    playerRef.current?.setMuted(false)
  }, [])

  const isVideoBuffered = useCallback(
    () => playerRef.current?.isBuffered(0, Math.min(scene.durationMs, 10_000)) ?? false,
    [scene.durationMs],
  )

  if (videoFailed) {
    return (
      <ErrorState
        code="VIDEO_LOAD_FAILED"
        className="text-paper"
        onRetry={() => {
          setVideoFailed(false)
        }}
      />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <VideoPlayer
        ref={attachVideo}
        src={videoUrl}
        referenceAudioSrc={referenceAudioUrl}
        posterSrc={posterUrl}
        durationMs={scene.durationMs}
        title={`${scene.work.title} — ${scene.title}`}
        onError={() => {
          setVideoFailed(true)
        }}
      />

      <SubtitleRenderer
        subtitles={scene.subtitleSegments}
        speakerSegments={scene.speakerSegments}
        characters={scene.characters}
        mediaTimeRef={mediaTimeRef}
      />

      <section aria-labelledby="referencia-titulo" className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <h2
            id="referencia-titulo"
            className="font-body text-[0.6875rem] font-bold uppercase tracking-[0.16em] text-muted"
          >
            Referência vocal
          </h2>
          <span className="font-display text-xs uppercase tracking-widest text-muted">
            {formatTimecode(scene.durationMs)}
          </span>
        </div>

        <div className="h-24 border-2 border-ink-line bg-ink-soft">
          <Waveform
            peaks={features.status === 'ready' ? features.features.peaks : null}
            durationMs={scene.durationMs}
            mediaTimeRef={mediaTimeRef}
            onSeek={handleSeek}
          />
        </div>

        <p className="text-xs text-muted">
          {features.status === 'error'
            ? 'Não conseguimos carregar a referência desta cena — você ainda pode assistir e dublar.'
            : 'A onda mostra onde estão as falas. Clique para pular para um trecho.'}
        </p>
      </section>

      <section className="flex flex-col gap-3 border-t-2 border-ink-line pt-6">
        <h2 className="font-body text-[0.6875rem] font-bold uppercase tracking-[0.16em] text-muted">
          Personagens
        </h2>
        <ul className="flex flex-wrap gap-4">
          {scene.characters.map((character) => (
            <li key={character.id}>
              <CharacterBadge
                name={character.name}
                colorToken={character.colorToken}
                patternToken={character.patternToken}
                active
              />
            </li>
          ))}
        </ul>
      </section>

      <div className="flex flex-col gap-4 border-t-2 border-ink-line pt-6">
        <p className="font-display text-title uppercase">Agora é você.</p>
        <DubPanel
          scene={scene}
          featuresUrl={featuresUrl}
          video={videoElement}
          clockRef={clockRef}
          onStartVideo={startVideo}
          onStopVideo={stopVideo}
          isVideoBuffered={isVideoBuffered}
        />
      </div>
    </div>
  )
}
