import { type DublaErrorCode, DublaError } from './errors'

/**
 * Resultado explícito para operações que falham de forma esperada.
 *
 * Usado onde a falha é parte do fluxo normal (permissão negada, gravação
 * baixa demais, quota estourada) e o chamador precisa tratá-la. Exceções
 * continuam existindo para o que é realmente excepcional.
 */
export type Result<T, E = DublaError> = { ok: true; value: T } | { ok: false; error: E }

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}

export function fail(code: DublaErrorCode, detail?: string): Result<never> {
  return { ok: false, error: new DublaError(code, detail ? { detail } : undefined) }
}

export function unwrapOr<T>(result: Result<T, unknown>, fallback: T): T {
  return result.ok ? result.value : fallback
}
