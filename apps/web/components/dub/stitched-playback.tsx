'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { decodeWav, encodeWav } from '@dubla/dsp'
import type { SpeakerSegment } from '@dubla/shared'
import { Button } from '@dubla/ui'
import { stitchTakes, type Take } from '@/lib/stitch-takes'
import { bestTakePerSegment, STITCH_PAD_MS } from '@/lib/take-modes'
import type { RecorderAttempt } from '@/lib/use-recorder'
import { AttemptPlayback } from './attempt-playback'

export interface StitchedPlaybackProps {
  readonly attempts: readonly RecorderAttempt[]
  readonly segments: readonly SpeakerSegment[]
  readonly durationMs: number
  readonly video: HTMLVideoElement | null
}

/**
 * A cena inteira, montada com a melhor tomada de cada fala.
 *
 * Sem isto, o modo fala-a-fala termina numa frustração: cada tomada só toca o
 * próprio trecho, e não existe jeito de ouvir o resultado do trabalho todo. A
 * costura junta as tomadas na timeline do vídeo (crossfade nas emendas) e
 * entrega ao mesmo player sincronizado das tentativas normais — com offset
 * zero, porque a trilha costurada já vive na grade do vídeo.
 *
 * A montagem acontece sob clique, não automaticamente: decodificar todos os
 * WAVs custa memória e a pessoa pode só querer regravar uma fala.
 */
export function StitchedPlayback({
  attempts,
  segments,
  durationMs,
  video,
}: StitchedPlaybackProps) {
  const [building, setBuilding] = useState(false)
  const [stitched, setStitched] = useState<RecorderAttempt | null>(null)
  const [error, setError] = useState<string | null>(null)
  const urlRef = useRef<string | null>(null)
  /** Invalida uma montagem em andamento quando as tomadas mudam. */
  const buildIdRef = useRef(0)

  const best = bestTakePerSegment(attempts)
  const takeCount = best.size

  // Tomada nova ou regravada invalida a costura anterior (§67 para o URL).
  const takesSignature = [...best.values()].map((attempt) => attempt.id).join('|')
  useEffect(() => {
    buildIdRef.current += 1
    setStitched(null)
    setError(null)
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }, [takesSignature])

  useEffect(() => {
    return () => {
      buildIdRef.current += 1
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    }
  }, [])

  const build = useCallback(async () => {
    const buildId = buildIdRef.current + 1
    buildIdRef.current = buildId
    setBuilding(true)
    setError(null)

    try {
      const bySegment = new Map(segments.map((segment) => [segment.id, segment]))
      const takes: Take[] = []
      let sampleRate = 0

      for (const [segmentId, attempt] of best) {
        const segment = bySegment.get(segmentId)
        if (!segment) continue

        const response = await fetch(attempt.wavUrl)
        const decoded = decodeWav(await response.arrayBuffer())
        if (buildIdRef.current !== buildId) return
        if (sampleRate === 0) sampleRate = decoded.sampleRate

        takes.push({
          samples: decoded.samples,
          sampleRate: decoded.sampleRate,
          mediaStartOffsetMs: attempt.clock.mediaStartOffsetMs,
          // Margem menor que a folga de gravação: o embalo não entra na cena.
          windowStartMs: Math.max(0, segment.startMs - STITCH_PAD_MS),
          windowEndMs: Math.min(durationMs, segment.endMs + STITCH_PAD_MS),
        })
      }

      if (takes.length === 0 || sampleRate === 0) {
        throw new Error('nenhuma tomada aproveitável')
      }

      const result = stitchTakes(takes, durationMs, sampleRate)
      const url = URL.createObjectURL(
        new Blob([encodeWav(result.samples, sampleRate)], { type: 'audio/wav' }),
      )
      if (buildIdRef.current !== buildId) {
        URL.revokeObjectURL(url)
        return
      }
      urlRef.current = url

      setStitched({
        id: 'stitched',
        attemptNumber: 0,
        wavUrl: url,
        durationMs,
        // A trilha costurada já vive na grade do vídeo: offset zero por
        // construção, e a confiança é a das tomadas que a compõem.
        clock: {
          sampleRate,
          startFrame: 0,
          videoStartMediaTime: 0,
          mediaStartOffsetMs: 0,
          estimatedInputLatencyMs: 0,
          clockConfidence: 1,
          sampleContinuityOk: true,
        },
        result: null,
      })
    } catch {
      setError('Não conseguimos montar a cena completa. As tomadas continuam disponíveis uma a uma.')
    } finally {
      if (buildIdRef.current === buildId) setBuilding(false)
    }
  }, [best, segments, durationMs])

  if (takeCount === 0) return null

  return (
    <section
      className="flex flex-col gap-3 border-2 border-ink-line p-4"
      data-testid="stitched-playback"
      aria-label="Cena completa com suas tomadas"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-lg uppercase">Cena completa</h3>
        <span className="font-body text-[0.6875rem] font-bold uppercase tracking-[0.16em] text-muted">
          {takeCount === 1 ? '1 fala montada' : `${String(takeCount)} falas montadas`}
        </span>
      </div>

      {stitched ? (
        <AttemptPlayback attempt={stitched} video={video} />
      ) : (
        <Button
          size="lg"
          variant="secondary"
          disabled={building}
          data-testid="stitched-build"
          onClick={() => {
            void build()
          }}
        >
          {building ? 'Montando…' : '▶ Ouvir a cena inteira'}
        </Button>
      )}

      {error ? <p className="text-xs text-warn">{error}</p> : null}
    </section>
  )
}
