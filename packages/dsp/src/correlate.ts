import { MAX_GLOBAL_OFFSET_FRAMES } from './constants'

/**
 * Correlação de Pearson sobre as posições em que `mask` é verdadeiro.
 *
 * Retorna `null` — e não 0 — quando não há amostras suficientes ou quando um
 * dos sinais é constante. Zero significaria "sem relação", que é uma afirmação
 * diferente de "não deu para medir" (§12).
 */
export function pearson(
  a: Float32Array,
  b: Float32Array,
  mask?: Uint8Array,
  minSamples = 10,
): number | null {
  const length = Math.min(a.length, b.length)
  let count = 0
  let sumA = 0
  let sumB = 0

  for (let i = 0; i < length; i += 1) {
    if (mask && mask[i] !== 1) continue
    const x = a[i] ?? Number.NaN
    const y = b[i] ?? Number.NaN
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    sumA += x
    sumB += y
    count += 1
  }

  if (count < minSamples) return null

  const meanA = sumA / count
  const meanB = sumB / count
  let covariance = 0
  let varianceA = 0
  let varianceB = 0

  for (let i = 0; i < length; i += 1) {
    if (mask && mask[i] !== 1) continue
    const x = a[i] ?? Number.NaN
    const y = b[i] ?? Number.NaN
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    const dx = x - meanA
    const dy = y - meanB
    covariance += dx * dy
    varianceA += dx * dx
    varianceB += dy * dy
  }

  const denominator = Math.sqrt(varianceA * varianceB)
  if (denominator < 1e-12) return null
  return covariance / denominator
}

export interface OffsetEstimate {
  /** Deslocamento em quadros. Positivo = usuário atrasado. */
  readonly lagFrames: number
  /** Pico da correlação normalizada, 0..1. */
  readonly confidence: number
}

/**
 * Estima o atraso sistemático entre dois envelopes de atividade.
 *
 * Este é o passo que separa "o usuário entrou tarde" de "o fone Bluetooth do
 * usuário atrasa 200 ms". Sem ele, todo mundo com latência de hardware receberia
 * nota baixa de sincronia por um motivo que não tem nada a ver com dublagem
 * (docs/SCORING.md §2.2).
 *
 * A busca é limitada a ±300 ms: uma janela maior encontraria alinhamentos
 * espúrios entre falas diferentes, e passaria a corrigir erro real de entrada
 * do usuário como se fosse latência.
 */
export function estimateGlobalOffset(
  reference: Float32Array,
  user: Float32Array,
  maxLagFrames = MAX_GLOBAL_OFFSET_FRAMES,
): OffsetEstimate {
  let bestLag = 0
  let bestScore = -1

  for (let lag = -maxLagFrames; lag <= maxLagFrames; lag += 1) {
    let dot = 0
    let normReference = 0
    let normUser = 0
    let overlap = 0

    for (let i = 0; i < reference.length; i += 1) {
      const j = i + lag
      if (j < 0 || j >= user.length) continue
      const r = reference[i] ?? 0
      const u = user[j] ?? 0
      dot += r * u
      normReference += r * r
      normUser += u * u
      overlap += 1
    }

    if (overlap < 10) continue
    const denominator = Math.sqrt(normReference * normUser)
    if (denominator < 1e-9) continue

    const score = dot / denominator
    if (score > bestScore) {
      bestScore = score
      bestLag = lag
    }
  }

  return { lagFrames: bestLag, confidence: Math.max(0, bestScore) }
}
