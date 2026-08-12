'use client'

import { useEffect, useId, useRef, type ReactNode } from 'react'

export interface ModalProps {
  readonly open: boolean
  /** Rótulo curto acima do título, no tom do resto da interface. */
  readonly eyebrow?: string
  readonly title: string
  readonly description?: string
  readonly children?: ReactNode
  /** Ações do rodapé. A primária deve ser a última, à direita. */
  readonly footer?: ReactNode
  /** Impede fechar por Esc ou clique fora — para modais que exigem decisão. */
  readonly dismissible?: boolean
  readonly testId?: string
  onClose: () => void
}

/**
 * Janela modal do Dubla Aí.
 *
 * Extraída do diálogo de personagens porque três telas passaram a precisar da
 * mesma coisa: explicar antes de agir. Um modal por tela levaria a três
 * comportamentos de foco e teclado ligeiramente diferentes — e é justamente aí
 * que a acessibilidade quebra sem ninguém notar.
 *
 * O foco fica preso enquanto aberta e volta para quem a abriu ao fechar; Esc
 * fecha; o fundo rola travado. Nada disso é opcional para quem navega por
 * teclado ou leitor de tela (§63).
 */
export function Modal({
  open,
  eyebrow,
  title,
  description,
  children,
  footer,
  dismissible = true,
  testId,
  onClose,
}: ModalProps) {
  const titleId = useId()
  const descriptionId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  const dismissibleRef = useRef(dismissible)

  useEffect(() => {
    onCloseRef.current = onClose
    dismissibleRef.current = dismissible
  }, [dismissible, onClose])

  useEffect(() => {
    if (!open) return

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const focusFrame = window.requestAnimationFrame(() => {
      const alvo = dialogRef.current?.querySelector<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      ;(alvo ?? dialogRef.current)?.focus()
    })

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dismissibleRef.current) {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return

      // Sem a prisão de foco, Tab escapa para a página atrás — que está inerte
      // visualmente mas continua navegável, e a pessoa se perde.
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/85 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      data-testid={testId}
      onMouseDown={(event) => {
        // `mousedown` no fundo, e não `click`: arrastar de dentro para fora
        // não pode fechar a janela no meio de uma seleção de texto.
        if (dismissible && event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...(description === undefined ? {} : { 'aria-describedby': descriptionId })}
        tabIndex={-1}
        className="max-h-[90dvh] w-full overflow-y-auto border-2 border-paper bg-ink p-5 text-paper shadow-hard sm:max-w-xl sm:p-6"
      >
        <div className="flex flex-col gap-5">
          <div>
            {eyebrow ? (
              <p className="font-body text-[0.6875rem] font-bold uppercase tracking-[0.18em] text-accent">
                {eyebrow}
              </p>
            ) : null}
            <h2 id={titleId} className="mt-1 font-display text-3xl uppercase leading-none">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-2 max-w-prose text-sm text-muted">
                {description}
              </p>
            ) : null}
          </div>

          {children}

          {footer ? <div className="flex flex-wrap justify-end gap-2">{footer}</div> : null}
        </div>
      </div>
    </div>
  )
}
