import { CLIPPING_THRESHOLD, DB_FLOOR } from './constants'

export function amplitudeToDb(amplitude: number): number {
  return amplitude <= 0 ? DB_FLOOR : Math.max(DB_FLOOR, 20 * Math.log10(amplitude))
}

export function rms(samples: Float32Array, start: number, length: number): number {
  const end = Math.min(samples.length, start + length)
  if (end <= start) return 0
  let sum = 0
  for (let i = start; i < end; i += 1) {
    const value = samples[i] ?? 0
    sum += value * value
  }
  return Math.sqrt(sum / (end - start))
}

/** Percentil por seleção sobre cópia ordenada. `p` em 0..1. */
export function percentile(values: ArrayLike<number>, p: number): number {
  if (values.length === 0) return 0
  const sorted = Array.from(values).sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))
  return sorted[index] ?? 0
}

export interface SignalStats {
  readonly peakDb: number
  readonly clippedRatio: number
}

/**
 * Medido nas amostras ORIGINAIS, antes de qualquer reamostragem.
 *
 * O passa-baixa da reamostragem atenua justamente os picos que caracterizam o
 * estouro: medir depois esconderia o clipping que queremos detectar.
 */
export function analyzeSignal(samples: Float32Array): SignalStats {
  let peak = 0
  let clipped = 0
  for (const sample of samples) {
    const magnitude = Math.abs(sample)
    if (magnitude > peak) peak = magnitude
    if (magnitude >= CLIPPING_THRESHOLD) clipped += 1
  }
  return {
    peakDb: amplitudeToDb(peak),
    clippedRatio: samples.length === 0 ? 0 : clipped / samples.length,
  }
}
