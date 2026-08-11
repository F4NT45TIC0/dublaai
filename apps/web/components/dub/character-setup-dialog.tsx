'use client'

import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react'
import { Button } from '@dubla/ui'

const MIN_CHARACTERS = 1
const MAX_CHARACTERS = 4
const DEFAULT_CHARACTER_COUNT = 2

export interface CharacterSetupDialogProps {
  readonly open: boolean
  readonly busy?: boolean
  /** Trava a quantidade (por exemplo, duas pessoas em uma partida online). */
  readonly fixedCount?: number
  readonly initialNames?: readonly string[]
  readonly onCancel: () => void
  readonly onConfirm: (names: readonly string[]) => void
}

function namesForDialog(initialNames: readonly string[], fixedCount?: number): string[] {
  const count = Math.min(
    MAX_CHARACTERS,
    Math.max(
      MIN_CHARACTERS,
      fixedCount === undefined
        ? initialNames.length || DEFAULT_CHARACTER_COUNT
        : Math.round(fixedCount),
    ),
  )

  return Array.from({ length: count }, (_, index) => initialNames[index] ?? '')
}

/**
 * Coleta quem fala na cena antes de iniciar o reconhecimento.
 *
 * O diálogo deixa a decisão curta e explícita: primeiro a quantidade, depois
 * os nomes. Assim a lista reconhecida já pode nascer com rótulos que façam
 * sentido para quem vai revisar e gravar.
 */
export function CharacterSetupDialog({
  open,
  busy = false,
  fixedCount,
  initialNames = [],
  onCancel,
  onConfirm,
}: CharacterSetupDialogProps) {
  const titleId = useId()
  const descriptionId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const firstInputRef = useRef<HTMLInputElement>(null)
  const wasOpenRef = useRef(false)
  const busyRef = useRef(busy)
  const onCancelRef = useRef(onCancel)
  const [names, setNames] = useState<string[]>(() => namesForDialog(initialNames, fixedCount))
  const [validationMessage, setValidationMessage] = useState<string | null>(null)

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setNames(namesForDialog(initialNames, fixedCount))
      setValidationMessage(null)
    }
    wasOpenRef.current = open
  }, [fixedCount, initialNames, open])

  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  useEffect(() => {
    onCancelRef.current = onCancel
  }, [onCancel])

  useEffect(() => {
    if (!open) return

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const focusFrame = window.requestAnimationFrame(() => {
      firstInputRef.current?.focus()
    })

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault()
        onCancelRef.current()
        return
      }

      if (event.key !== 'Tab') return

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )
      if (!focusable || focusable.length === 0) return

      const first = focusable.item(0)
      const last = focusable.item(focusable.length - 1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      previouslyFocused?.focus()
    }
  }, [open])

  if (!open) return null

  const setCharacterCount = (count: number) => {
    setNames((current) => Array.from({ length: count }, (_, index) => current[index] ?? ''))
    setValidationMessage(null)
  }

  const submit = (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    event.preventDefault()
    const normalized = names.map((name) => name.trim())
    const firstMissing = normalized.findIndex((name) => name === '')
    if (firstMissing >= 0) {
      setValidationMessage('Dê um nome para cada pessoa da cena.')
      dialogRef.current
        ?.querySelectorAll<HTMLInputElement>('input[type="text"]')
        [firstMissing]?.focus()
      return
    }

    setValidationMessage(null)
    onConfirm(normalized)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/85 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        data-testid="character-setup-dialog"
        className="max-h-[90dvh] w-full overflow-y-auto border-2 border-paper bg-ink p-5 text-paper shadow-hard sm:max-w-xl sm:p-6"
      >
        <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
          <header>
            <p className="font-body text-[0.6875rem] font-bold uppercase tracking-[0.18em] text-accent">
              Preparar fala a fala
            </p>
            <h2 id={titleId} className="mt-1 font-display text-3xl uppercase leading-none">
              Quem está nesta cena?
            </h2>
            <p id={descriptionId} className="mt-2 max-w-prose text-sm text-muted">
              Informe quantas pessoas falam e o nome de cada uma. Vamos usar esses nomes para
              organizar a revisão das falas.
            </p>
          </header>

          {fixedCount === undefined ? (
            <fieldset className="flex flex-col gap-2" disabled={busy}>
              <legend className="font-body text-[0.6875rem] font-bold uppercase tracking-[0.16em] text-muted">
                Quantas pessoas participam?
              </legend>
              <div className="grid grid-cols-4 gap-2">
                {[1, 2, 3, 4].map((count) => (
                  <button
                    key={count}
                    type="button"
                    aria-pressed={names.length === count}
                    data-testid={`vozes-${String(count)}`}
                    onClick={() => {
                      setCharacterCount(count)
                    }}
                    className={`min-h-12 border-2 font-display text-lg uppercase disabled:opacity-40 ${
                      names.length === count
                        ? 'border-accent bg-accent text-paper'
                        : 'border-ink-line text-muted hover:border-paper hover:text-paper'
                    }`}
                  >
                    {count}
                  </button>
                ))}
              </div>
            </fieldset>
          ) : (
            <p className="border-2 border-ink-line px-3 py-2 text-sm text-muted">
              Esta partida terá <strong className="text-paper">{names.length} pessoas</strong> na
              cena.
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            {names.map((name, index) => (
              <label key={index} className="flex flex-col gap-1">
                <span className="font-body text-[0.6875rem] font-bold uppercase tracking-[0.16em] text-muted">
                  Pessoa {index + 1}
                </span>
                <input
                  ref={index === 0 ? firstInputRef : undefined}
                  type="text"
                  required
                  maxLength={40}
                  autoComplete="off"
                  value={name}
                  placeholder={index === 0 ? 'Ex.: Burro' : index === 1 ? 'Ex.: Shrek' : 'Nome'}
                  data-testid={`character-name-${String(index)}`}
                  disabled={busy}
                  onChange={(event) => {
                    const value = event.target.value
                    setNames((current) =>
                      current.map((entry, entryIndex) => (entryIndex === index ? value : entry)),
                    )
                    setValidationMessage(null)
                  }}
                  className="min-h-12 border-2 border-ink-line bg-ink-soft px-3 font-body text-sm text-paper placeholder:text-muted disabled:opacity-40"
                />
              </label>
            ))}
          </div>

          {validationMessage ? (
            <p className="border-2 border-warn px-3 py-2 text-sm text-warn" role="alert">
              {validationMessage}
            </p>
          ) : null}

          <footer className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              data-testid="character-setup-cancel"
              onClick={onCancel}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={busy} data-testid="character-setup-confirm">
              {busy ? 'Reconhecendo…' : 'Reconhecer falas'}
            </Button>
          </footer>
        </form>
      </div>
    </div>
  )
}
