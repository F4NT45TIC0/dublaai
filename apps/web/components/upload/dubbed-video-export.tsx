'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@dubla/ui'
import type { RecorderAttempt } from '@/lib/use-recorder'
import { exportDubbedVideo } from '@/lib/export-dubbed-video'
import { downloadableBaseName } from '@/lib/local-video'

export interface DubbedVideoExportProps {
  readonly attempt: RecorderAttempt
  readonly video: HTMLVideoElement | null
  readonly sourceFileName: string
  readonly onExportingChange?: (exporting: boolean) => void
}

interface ExportResult {
  readonly url: string
  readonly fileName: string
}

export function DubbedVideoExport({
  attempt,
  video,
  sourceFileName,
  onExportingChange,
}: DubbedVideoExportProps) {
  const abortRef = useRef<AbortController | null>(null)
  const [progress, setProgress] = useState(0)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ExportResult | null>(null)

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      onExportingChange?.(false)
    }
  }, [onExportingChange])

  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url)
    }
  }, [result])

  const startExport = async () => {
    if (!video || exporting) return

    if (result) {
      URL.revokeObjectURL(result.url)
      setResult(null)
    }

    const controller = new AbortController()
    abortRef.current = controller
    setError(null)
    setProgress(0)
    setExporting(true)
    onExportingChange?.(true)

    try {
      const exported = await exportDubbedVideo({
        video,
        wavUrl: attempt.wavUrl,
        mediaStartOffsetMs: attempt.clock.mediaStartOffsetMs,
        signal: controller.signal,
        onProgress: setProgress,
      })
      const url = URL.createObjectURL(exported.blob)
      setResult({
        url,
        fileName: `${downloadableBaseName(sourceFileName)}-dublado.${exported.extension}`,
      })
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
        setError(cause instanceof Error ? cause.message : 'Não foi possível gerar o vídeo.')
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setExporting(false)
      onExportingChange?.(false)
    }
  }

  return (
    <section className="flex flex-col gap-3 border-2 border-ink-line p-4" aria-label="Baixar vídeo dublado">
      <div>
        <h3 className="font-display text-xl uppercase">Seu vídeo dublado</h3>
        <p className="mt-1 text-sm text-muted">
          A cena é renderizada no seu navegador com a sua voz e sem o áudio original. Nada é
          enviado para a internet.
        </p>
      </div>

      {exporting ? (
        <div className="flex flex-col gap-2" aria-live="polite">
          <div
            className="h-3 border-2 border-paper"
            role="progressbar"
            aria-label="Progresso da exportação"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
          >
            <div className="h-full bg-accent" style={{ width: `${String(progress * 100)}%` }} />
          </div>
          <p className="text-xs text-muted">
            Gerando… {Math.round(progress * 100)}%. Isso leva aproximadamente a duração da cena.
          </p>
          <Button
            variant="secondary"
            onClick={() => {
              abortRef.current?.abort()
            }}
          >
            Cancelar exportação
          </Button>
        </div>
      ) : result ? (
        <div className="flex flex-wrap gap-3">
          <Button asChild size="lg">
            <a href={result.url} download={result.fileName} data-testid="download-dubbed-video">
              ↓ Baixar vídeo dublado
            </a>
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              void startExport()
            }}
          >
            Gerar novamente
          </Button>
        </div>
      ) : (
        <Button
          size="lg"
          data-testid="export-dubbed-video"
          disabled={!video}
          onClick={() => {
            void startExport()
          }}
        >
          Gerar vídeo dublado
        </Button>
      )}

      {error ? (
        <p className="border-2 border-danger px-3 py-2 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}
