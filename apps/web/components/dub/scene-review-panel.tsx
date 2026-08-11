'use client'

import { useEffect, useId, useState } from 'react'
import { formatTimecode, type SpeakerSegment } from '@dubla/shared'
import { Button } from '@dubla/ui'
import { isOriginal, type SegmentSource } from '@/lib/segment-sources'

export type SceneReviewTranscription =
  | { readonly phase: 'idle' }
  | { readonly phase: 'running'; readonly loadedRatio: number }
  | {
      readonly phase: 'done'
      readonly filled: number
      readonly missing: number
    }
  | { readonly phase: 'failed'; readonly message: string }

export interface SceneReviewPanelProps {
  readonly segments: readonly SpeakerSegment[]
  readonly texts: Readonly<Record<string, string>>
  readonly characterNames: readonly string[]
  readonly voiceCount: number
  readonly sources: Readonly<Record<string, SegmentSource>>
  readonly transcription: SceneReviewTranscription
  readonly activeIndex?: number
  readonly disabled?: boolean
  readonly onTextChange: (segmentId: string, text: string) => void
  readonly onCycleVoice: (segmentId: string) => void
  readonly onToggleSource: (segmentId: string) => void
  readonly onSelect: (index: number) => void
  readonly onRecognizeAgain: () => void
}

const LINES_PER_PAGE = 2

function nameForSegment(segment: SpeakerSegment, characterNames: readonly string[]): string {
  const voiceNumber = /^voz-(\d+)$/.exec(segment.characterId)?.[1]
  const index = voiceNumber ? Number(voiceNumber) - 1 : -1
  return characterNames[index] ?? (index >= 0 ? `Voz ${String(index + 1)}` : segment.characterId)
}

/** Lista compacta para conferir texto, personagem e fonte de cada fala. */
export function SceneReviewPanel({
  segments,
  texts,
  characterNames,
  voiceCount,
  sources,
  transcription,
  activeIndex = 0,
  disabled = false,
  onTextChange,
  onCycleVoice,
  onToggleSource,
  onSelect,
  onRecognizeAgain,
}: SceneReviewPanelProps) {
  const titleId = useId()
  const [pageIndex, setPageIndex] = useState(() =>
    Math.floor(Math.max(0, activeIndex) / LINES_PER_PAGE),
  )
  const running = transcription.phase === 'running'
  const progress = running
    ? Math.min(100, Math.max(0, Math.round(transcription.loadedRatio * 100)))
    : 0
  const pageCount = Math.max(1, Math.ceil(segments.length / LINES_PER_PAGE))
  const currentPage = Math.min(pageIndex, pageCount - 1)
  const firstVisibleIndex = currentPage * LINES_PER_PAGE
  const lastVisibleIndex = Math.min(firstVisibleIndex + LINES_PER_PAGE, segments.length)
  const visibleSegments = segments
    .slice(firstVisibleIndex, lastVisibleIndex)
    .map((segment, offset) => ({ segment, index: firstVisibleIndex + offset }))

  useEffect(() => {
    const lastSegmentIndex = Math.max(0, segments.length - 1)
    const nextPage = Math.floor(
      Math.min(Math.max(0, activeIndex), lastSegmentIndex) / LINES_PER_PAGE,
    )
    setPageIndex((current) => (current === nextPage ? current : nextPage))
  }, [activeIndex, segments.length])

  const goToPage = (nextPage: number) => {
    const safePage = Math.min(Math.max(0, nextPage), pageCount - 1)
    const nextSegmentIndex = safePage * LINES_PER_PAGE
    setPageIndex(safePage)
    if (nextSegmentIndex < segments.length) onSelect(nextSegmentIndex)
  }

  return (
    <aside
      aria-labelledby={titleId}
      data-testid="scene-review-panel"
      className={`flex min-h-0 flex-col border-2 border-ink-line bg-ink ${
        segments.length > 0 ? 'h-[46rem] sm:h-[40rem]' : ''
      }`}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-ink-line p-4">
        <div>
          <p className="font-body text-[0.6875rem] font-bold uppercase tracking-[0.18em] text-accent">
            Fala a fala
          </p>
          <h2 id={titleId} className="font-display text-xl uppercase">
            Confira a cena
          </h2>
          <p className="mt-1 text-xs text-muted">
            {segments.length} {segments.length === 1 ? 'fala encontrada' : 'falas encontradas'}
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled || running}
          data-testid="local-transcrever"
          onClick={onRecognizeAgain}
        >
          {running
            ? 'Reconhecendo…'
            : transcription.phase === 'idle'
              ? 'Reconhecer falas'
              : 'Reconhecer de novo'}
        </Button>
      </header>

      {running ? (
        <div className="border-b-2 border-ink-line p-4" role="status" aria-live="polite">
          <div className="flex items-center justify-between gap-3 text-xs text-muted">
            <span>
              {progress > 0 && progress < 100
                ? 'Preparando o reconhecimento…'
                : 'Ouvindo o vídeo. Isso pode levar alguns minutos.'}
            </span>
            {progress > 0 && progress < 100 ? <span>{progress}%</span> : null}
          </div>
          <div className="mt-2 h-2 border border-ink-line bg-ink-soft" aria-hidden="true">
            <div className="h-full bg-accent" style={{ width: `${String(progress)}%` }} />
          </div>
        </div>
      ) : null}

      {transcription.phase === 'failed' ? (
        <p className="m-4 border-2 border-warn px-3 py-2 text-xs text-warn" role="alert">
          {transcription.message} Você pode tentar de novo ou ajustar as falas manualmente.
        </p>
      ) : null}

      {transcription.phase === 'done' ? (
        <div className="m-4 border-2 border-warn bg-warn/10 p-3" role="status">
          <p className="font-display text-sm uppercase text-warn">Faça uma conferência rápida</p>
          <p className="mt-1 text-xs text-paper/80">
            Texto, cortes e personagem podem conter erros. Confira cada fala antes de gravar; todos
            os campos abaixo podem ser corrigidos.
          </p>
          <p className="mt-2 text-[0.6875rem] text-muted">
            {transcription.filled} reconhecida
            {transcription.filled === 1 ? '' : 's'}
            {transcription.missing > 0
              ? ` · ${String(transcription.missing)} sem texto`
              : ' · nenhuma ficou sem texto'}
          </p>
        </div>
      ) : null}

      {segments.length > 0 ? (
        <>
          <ol
            className="grid min-h-0 flex-1 grid-rows-2 gap-2 overflow-hidden p-3"
            aria-label="Falas reconhecidas para revisar"
          >
            {visibleSegments.map(({ segment, index }) => {
              const usaOriginal = isOriginal(sources, segment.id)
              const active = index === activeIndex
              return (
                <li
                  key={segment.id}
                  className={`flex min-h-0 flex-col gap-2 border-2 p-2 ${
                    active ? 'border-accent bg-accent/5' : 'border-ink-line'
                  }`}
                  data-active={active ? 'true' : undefined}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      aria-current={active ? 'step' : undefined}
                      disabled={disabled}
                      onClick={() => {
                        onSelect(index)
                      }}
                      className="min-h-11 flex-1 text-left font-body text-[0.6875rem] font-bold uppercase tracking-[0.12em] tabular-nums text-muted hover:text-paper disabled:opacity-40"
                    >
                      {index + 1}. {formatTimecode(segment.startMs)} –{' '}
                      {formatTimecode(segment.endMs)}
                    </button>
                    <button
                      type="button"
                      data-testid={`fala-voz-${String(index)}`}
                      title={
                        voiceCount > 1 ? 'Trocar o personagem desta fala' : 'Única pessoa da cena'
                      }
                      disabled={disabled || voiceCount <= 1}
                      onClick={() => {
                        onCycleVoice(segment.id)
                      }}
                      className="min-h-11 border-2 border-ink-line px-2 font-display text-[0.625rem] uppercase tracking-widest text-paper hover:border-paper disabled:cursor-default disabled:opacity-70"
                    >
                      {nameForSegment(segment, characterNames)}
                    </button>
                  </div>

                  <label className="sr-only" htmlFor={`review-fala-${segment.id}`}>
                    Texto da fala {index + 1}
                  </label>
                  <input
                    id={`review-fala-${segment.id}`}
                    type="text"
                    maxLength={300}
                    value={texts[segment.id] ?? ''}
                    placeholder="O que é dito nesta fala?"
                    data-testid={`local-fala-${String(index)}`}
                    disabled={disabled}
                    onFocus={() => {
                      onSelect(index)
                    }}
                    onChange={(event) => {
                      onTextChange(segment.id, event.target.value)
                    }}
                    className="min-h-11 w-full border-2 border-ink-line bg-ink-soft px-3 font-body text-sm text-paper placeholder:text-muted disabled:opacity-40"
                  />

                  <button
                    type="button"
                    aria-pressed={usaOriginal}
                    data-testid={`local-fonte-${String(index)}`}
                    disabled={disabled}
                    onClick={() => {
                      onToggleSource(segment.id)
                    }}
                    className={`min-h-10 w-full border-2 px-3 font-display text-[0.625rem] uppercase tracking-widest disabled:opacity-40 ${
                      usaOriginal
                        ? 'border-accent bg-accent text-paper'
                        : 'border-ink-line text-muted hover:border-paper hover:text-paper'
                    }`}
                  >
                    {usaOriginal ? 'Manter voz original' : 'Eu vou dublar'}
                  </button>
                </li>
              )
            })}
          </ol>

          <nav
            aria-label="Páginas de falas"
            data-testid="scene-review-pagination"
            className="grid grid-cols-[auto_1fr_auto] items-center gap-2 border-t-2 border-ink-line p-3"
          >
            <Button
              type="button"
              size="sm"
              variant="secondary"
              aria-label="Página anterior de falas"
              data-testid="scene-review-previous"
              disabled={disabled || currentPage === 0}
              onClick={() => {
                goToPage(currentPage - 1)
              }}
            >
              ← Anterior
            </Button>
            <p
              className="text-center font-body text-[0.6875rem] font-bold uppercase tracking-[0.1em] text-muted"
              aria-live="polite"
              data-testid="scene-review-page"
            >
              <span className="block text-paper">
                Página {currentPage + 1} de {pageCount}
              </span>
              <span className="mt-1 block">
                Falas {firstVisibleIndex + 1}–{lastVisibleIndex} de {segments.length}
              </span>
            </p>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              aria-label="Próxima página de falas"
              data-testid="scene-review-next"
              disabled={disabled || currentPage >= pageCount - 1}
              onClick={() => {
                goToPage(currentPage + 1)
              }}
            >
              Próxima →
            </Button>
          </nav>
        </>
      ) : running ? null : (
        <p className="p-4 text-sm text-muted">
          Reconheça o áudio para criar a lista de falas e revisar quem diz cada uma.
        </p>
      )}
    </aside>
  )
}
