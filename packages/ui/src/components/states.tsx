import type { DublaErrorCode, ErrorPresentation } from '@dubla/shared'
import { ERROR_MESSAGES } from '@dubla/shared'
import type { ReactNode } from 'react'
import { Button } from './button'
import { cn } from '../lib/cn'

export interface ErrorStateProps {
  readonly code: DublaErrorCode
  /** Detalhe adicional específico do contexto, quando houver. */
  readonly detail?: string
  readonly onRetry?: () => void
  readonly secondary?: ReactNode
  readonly className?: string
}

/**
 * Tela de erro.
 *
 * Nunca aceita uma string livre: recebe um código da taxonomia, e o texto vem
 * de `ERROR_MESSAGES`. É assim que "Something went wrong" fica impossível de
 * escrever por acidente (§20).
 *
 * A linha sobre a gravação preservada é o ponto mais importante da tela: a
 * pergunta que o usuário realmente tem é "perdi o que gravei?" (§117).
 */
export function ErrorState({ code, detail, onRetry, secondary, className }: ErrorStateProps) {
  const presentation: ErrorPresentation = ERROR_MESSAGES[code]

  return (
    <div
      role="alert"
      className={cn('border-2 border-current p-6 sm:p-8', className)}
      data-error-code={code}
    >
      <p className="font-body text-[0.6875rem] font-bold uppercase tracking-[0.16em] opacity-60">
        {code}
      </p>
      <h2 className="mt-2 font-display text-title uppercase">{presentation.title}</h2>
      <p className="mt-3 max-w-prose text-base leading-relaxed">{presentation.message}</p>
      {detail ? <p className="mt-2 max-w-prose text-sm opacity-70">{detail}</p> : null}
      {presentation.action ? (
        <p className="mt-3 max-w-prose text-sm opacity-80">{presentation.action}</p>
      ) : null}

      {presentation.recordingPreserved !== null ? (
        <p
          className={cn(
            'mt-4 border-2 px-3 py-2 font-body text-xs font-bold uppercase tracking-widest',
            presentation.recordingPreserved
              ? 'border-ok text-ok'
              : 'border-danger text-danger',
          )}
        >
          {presentation.recordingPreserved
            ? 'Sua gravação foi preservada'
            : 'Esta gravação foi descartada'}
        </p>
      ) : null}

      {onRetry ?? secondary ? (
        <div className="mt-6 flex flex-wrap gap-3">
          {onRetry && presentation.retryable ? (
            <Button onClick={onRetry}>Tentar novamente</Button>
          ) : null}
          {secondary}
        </div>
      ) : null}
    </div>
  )
}

export interface EmptyStateProps {
  readonly title: string
  readonly description?: string
  readonly action?: ReactNode
  readonly className?: string
}

export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('border-2 border-dashed border-current p-10 text-center', className)}>
      <h2 className="font-display text-title uppercase">{title}</h2>
      {description ? (
        <p className="mx-auto mt-3 max-w-prose text-base opacity-75">{description}</p>
      ) : null}
      {action ? <div className="mt-6 flex justify-center">{action}</div> : null}
    </div>
  )
}

export interface LoadingStateProps {
  readonly label: string
  /** 0..1. Ausente quando o progresso não é conhecido. */
  readonly progress?: number
  readonly className?: string
}

/**
 * Estado de carregamento.
 *
 * Mostra progresso sempre que ele for conhecido (§58). Uma barra indeterminada
 * eterna é como o usuário decide que travou.
 */
export function LoadingState({ label, progress, className }: LoadingStateProps) {
  const percent = progress === undefined ? null : Math.round(Math.min(1, Math.max(0, progress)) * 100)

  return (
    <div
      className={cn('flex flex-col gap-3', className)}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <p className="font-display text-sm uppercase tracking-widest">
        {label}
        {percent === null ? '' : ` — ${String(percent)}%`}
      </p>
      <div className="h-2 w-full border-2 border-current">
        <div
          className={cn('h-full bg-accent', percent === null && 'w-1/3 animate-pulse')}
          style={percent === null ? undefined : { width: `${String(percent)}%` }}
        />
      </div>
    </div>
  )
}
