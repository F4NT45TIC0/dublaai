import type { DublaErrorCode } from './errors'

/**
 * Logging estruturado (§71).
 *
 * O contexto é um tipo FECHADO. Não existe `[key: string]: unknown`, e isso é
 * intencional: sem um índice aberto, não há caminho de código capaz de logar
 * áudio, token ou dado pessoal. Adicionar um campo novo exige editar este
 * arquivo, que é onde a revisão acontece.
 */
export interface LogContext {
  readonly requestId?: string
  readonly sceneId?: string
  readonly sceneSlug?: string
  readonly recordingId?: string
  readonly attemptId?: string
  readonly jobId?: string
  readonly errorCode?: DublaErrorCode
  readonly durationMs?: number
  readonly state?: string
  readonly engineVersion?: string
  /** Contadores numéricos livres para métricas (§72). Só números. */
  readonly metrics?: Readonly<Record<string, number>>
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry extends LogContext {
  readonly level: LogLevel
  readonly event: string
  readonly timestamp: string
}

type Sink = (entry: LogEntry) => void

interface ConsoleLike {
  error(message: string): void
  warn(message: string): void
}

/**
 * `console` é sondado em vez de assumido: este pacote roda no navegador, em
 * Web Worker, em AudioWorklet e no Node, e o escopo global do worklet não tem
 * console. Assumi-lo transformaria um log em exceção no lugar mais difícil de
 * depurar do sistema.
 */
const consoleSink: Sink = (entry) => {
  const host = (globalThis as { console?: ConsoleLike }).console
  if (!host) return

  const payload = JSON.stringify(entry)
  if (entry.level === 'error') host.error(payload)
  else if (entry.level === 'warn') host.warn(payload)
  // debug e info ficam silenciosos por padrão fora de desenvolvimento.
}

let sink: Sink = consoleSink

export function setLogSink(next: Sink): void {
  sink = next
}

function emit(level: LogLevel, event: string, context: LogContext = {}): void {
  sink({ ...context, level, event, timestamp: new Date().toISOString() })
}

export const logger = {
  debug: (event: string, context?: LogContext) => {
    emit('debug', event, context)
  },
  info: (event: string, context?: LogContext) => {
    emit('info', event, context)
  },
  warn: (event: string, context?: LogContext) => {
    emit('warn', event, context)
  },
  error: (event: string, context?: LogContext) => {
    emit('error', event, context)
  },
}

/** Eventos de produto (§73). Nomes fechados para não virar coleta invasiva. */
export type ProductEvent =
  | 'scene_viewed'
  | 'dub_started'
  | 'dub_completed'
  | 'dub_abandoned'
  | 'result_viewed'
  | 'retry_clicked'
  | 'saved'
  | 'mode_changed'
  | 'mic_permission_denied'
  | 'recording_start_success'
  | 'analysis_failed'

export function track(event: ProductEvent, context?: LogContext): void {
  emit('info', event, context)
}
