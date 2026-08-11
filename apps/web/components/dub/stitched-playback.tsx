'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { decodeWav, encodeWav } from '@dubla/dsp'
import type { SpeakerSegment } from '@dubla/shared'
import { Button } from '@dubla/ui'
import { stitchTakes, type Take } from '@/lib/stitch-takes'
import { originalTakesFor, type SegmentSource } from '@/lib/segment-sources'
import { STITCH_PAD_MS } from '@/lib/take-modes'
import { planStitchedPlayback, type RemoteStitchedTake } from '@/lib/stitched-playback-plan'
import type { RecorderAttempt } from '@/lib/use-recorder'
import { DubbedVideoExport } from '@/components/upload/dubbed-video-export'
import { AttemptPlayback } from './attempt-playback'

export interface StitchedPlaybackProps {
  readonly attempts: readonly RecorderAttempt[]
  readonly segments: readonly SpeakerSegment[]
  readonly durationMs: number
  readonly video: HTMLVideoElement | null
  /** Trechos deixados com a voz original do vídeo. */
  readonly sources?: Readonly<Record<string, SegmentSource | undefined>>
  /**
   * Decodifica o áudio original sob demanda.
   *
   * É função, e não o áudio pronto, porque em vídeo de 5 minutos são dezenas de
   * MB que só fazem falta se algum trecho realmente usar a voz original.
   */
  readonly loadOriginalAudio?: () => Promise<{
    readonly samples: Float32Array
    readonly sampleRate: number
  }>
  /** Nome do arquivo de origem, usado para nomear o vídeo exportado. */
  readonly sourceFileName?: string
  /**
   * Tomadas que vieram da partida online — inclusive as do outro aparelho.
   *
   * Sem elas o modo online não fecharia: cada pessoa ouviria só a própria voz,
   * e a graça é justamente responder à fala do outro.
   */
  readonly remoteTakes?: readonly RemoteStitchedTake[]
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
 * A montagem acontece assim que as tomadas mudam. Desse modo o clique da pessoa
 * já é o play, em vez de um primeiro clique invisível para preparar o áudio e
 * um segundo para finalmente ouvi-lo.
 */
export function StitchedPlayback({
  attempts,
  segments,
  durationMs,
  video,
  sources,
  loadOriginalAudio,
  sourceFileName,
  remoteTakes,
}: StitchedPlaybackProps) {
  const [building, setBuilding] = useState(false)
  const [stitched, setStitched] = useState<RecorderAttempt | null>(null)
  const [error, setError] = useState<string | null>(null)
  const urlRef = useRef<string | null>(null)
  /** Invalida uma montagem em andamento quando as tomadas mudam. */
  const buildIdRef = useRef(0)
  /** Evita remontar a mesma trilha a cada heartbeat da partida. */
  const autoBuiltSignatureRef = useRef('')

  const plan = useMemo(
    () => planStitchedPlayback(attempts, segments, sources, remoteTakes),
    [attempts, remoteTakes, segments, sources],
  )
  // Trecho no original também é uma fala montada: ignorá-lo faria a contagem
  // mentir justamente para quem escolheu não dublar tudo.
  const takeCount = plan.readySegmentIds.size

  // Tomada nova ou regravada invalida a costura anterior (§67 para o URL).
  const takesSignature = plan.signature
  useEffect(() => {
    buildIdRef.current += 1
    autoBuiltSignatureRef.current = ''
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

      for (const [segmentId, attempt] of plan.localTakes) {
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

      for (const remote of plan.remoteTakes) {
        const segment = bySegment.get(remote.segmentId)
        if (!segment) continue

        const response = await fetch(remote.url)
        const decoded = decodeWav(await response.arrayBuffer())
        if (buildIdRef.current !== buildId) return
        if (sampleRate === 0) sampleRate = decoded.sampleRate

        takes.push({
          samples: decoded.samples,
          sampleRate: decoded.sampleRate,
          mediaStartOffsetMs: remote.mediaStartOffsetMs,
          windowStartMs: Math.max(0, segment.startMs - STITCH_PAD_MS),
          windowEndMs: Math.min(durationMs, segment.endMs + STITCH_PAD_MS),
        })
      }

      // Trechos com a voz original entram como tomadas comuns, de offset zero.
      const usesOriginal = plan.originalSegmentIds.size > 0
      if (usesOriginal && loadOriginalAudio) {
        const original = await loadOriginalAudio()
        if (buildIdRef.current !== buildId) return
        if (sampleRate === 0) sampleRate = original.sampleRate
        takes.push(...originalTakesFor(segments, sources ?? {}, original, durationMs))
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
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
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
      setError(
        'Não conseguimos montar a cena completa. As tomadas continuam disponíveis uma a uma.',
      )
    } finally {
      if (buildIdRef.current === buildId) setBuilding(false)
    }
  }, [durationMs, loadOriginalAudio, plan, segments, sources])

  // A pessoa não precisa clicar para montar e depois clicar de novo para
  // ouvir. Assim que uma tomada muda, a costura é preparada em segundo plano e
  // a única ação final que aparece é "Ouvir vídeo".
  useEffect(() => {
    if (takeCount === 0) return
    if (autoBuiltSignatureRef.current === takesSignature) return
    autoBuiltSignatureRef.current = takesSignature
    void build()
  }, [build, takeCount, takesSignature])

  const faltam = segments.length - takeCount
  const pronta = segments.length > 0 && faltam <= 0
  const playUntilMs = pronta ? durationMs : plan.lastReadyEndMs

  return (
    <section
      className={`flex flex-col gap-4 border-2 p-4 ${pronta ? 'border-accent' : 'border-ink-line'}`}
      data-testid="stitched-playback"
      aria-label="Sua cena"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-display text-xl uppercase">Sua cena</h3>
        <p
          className="font-body text-xs font-bold uppercase tracking-[0.16em] text-muted"
          role="status"
        >
          {takeCount} de {segments.length} falas prontas
        </p>
      </div>

      {/*
        A pergunta que a tela precisa responder é "posso ouvir agora?". Antes
        ela ficava sem resposta: o botão aparecia do nada quando havia tomada e
        sumia quando não havia, sem nunca dizer o que faltava. Agora cada estado
        diz em uma frase onde a pessoa está e qual é o próximo passo.
      */}
      {takeCount === 0 ? (
        <p className="text-sm text-muted">
          Nenhuma fala gravada ainda. Grave a primeira e ela aparece aqui para você ouvir o vídeo.
        </p>
      ) : (
        <p className="text-sm text-muted">
          {pronta
            ? 'Todas as falas estão prontas. Ouça a cena inteira com a sua voz e baixe o vídeo.'
            : `O vídeo toca até a última fala pronta. As ${String(faltam)} falas que faltam ficam em silêncio até você gravá-las.`}
        </p>
      )}

      {takeCount > 0 ? (
        stitched ? (
          <div className="flex flex-col gap-4">
            <AttemptPlayback attempt={stitched} video={video} playUntilMs={playUntilMs} />
            {sourceFileName ? (
              <DubbedVideoExport attempt={stitched} video={video} sourceFileName={sourceFileName} />
            ) : null}
          </div>
        ) : (
          <Button
            size="hero"
            disabled={building || error === null}
            data-testid="stitched-build"
            onClick={() => {
              void build()
            }}
          >
            {building ? 'Montando vídeo…' : error ? 'Tentar montar novamente' : 'Preparando vídeo…'}
          </Button>
        )
      ) : null}

      {error ? <p className="border-2 border-warn px-3 py-2 text-sm text-warn">{error}</p> : null}
    </section>
  )
}
