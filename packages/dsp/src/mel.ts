import { MEL_BANDS, MEL_MAX_HZ, MEL_MIN_HZ, SPECTRUM_BINS } from './constants'

/** Escala HTK — a convenção mais comum em reconhecimento de fala. */
export function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700)
}

export function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1)
}

export interface MelFilter {
  readonly startBin: number
  readonly weights: Float64Array
}

/**
 * Banco de filtros triangulares, armazenado esparso.
 *
 * Denso seriam 26 × 257 multiplicações por quadro, das quais ~90% por zero.
 * Esparso é a mesma matemática com um décimo do trabalho — e a 50 quadros/s
 * em um worker isso importa.
 */
export function createMelFilterbank(
  sampleRate: number,
  bands = MEL_BANDS,
  minHz = MEL_MIN_HZ,
  maxHz = MEL_MAX_HZ,
  bins = SPECTRUM_BINS,
): MelFilter[] {
  const fftSize = (bins - 1) * 2
  const melMin = hzToMel(minHz)
  const melMax = hzToMel(Math.min(maxHz, sampleRate / 2))

  const points = new Float64Array(bands + 2)
  for (let i = 0; i < points.length; i += 1) {
    const mel = melMin + ((melMax - melMin) * i) / (bands + 1)
    points[i] = Math.floor(((fftSize + 1) * melToHz(mel)) / sampleRate)
  }

  const filters: MelFilter[] = []
  for (let band = 0; band < bands; band += 1) {
    const left = points[band] ?? 0
    const center = points[band + 1] ?? 0
    const right = points[band + 2] ?? 0
    const startBin = Math.max(0, left)
    const endBin = Math.min(bins - 1, right)
    const width = Math.max(1, endBin - startBin + 1)
    const weights = new Float64Array(width)

    for (let bin = startBin; bin <= endBin; bin += 1) {
      let weight = 0
      if (bin >= left && bin <= center && center > left) {
        weight = (bin - left) / (center - left)
      } else if (bin > center && bin <= right && right > center) {
        weight = (right - bin) / (right - center)
      } else if (bin === center) {
        weight = 1
      }
      weights[bin - startBin] = weight
    }

    filters.push({ startBin, weights })
  }

  return filters
}

/** Energia log por banda mel. `out` precisa ter `filters.length`. */
export function applyMelFilterbank(
  power: Float64Array,
  filters: readonly MelFilter[],
  out: Float64Array,
): void {
  if (out.length !== filters.length) {
    throw new Error('applyMelFilterbank: saída precisa ter uma posição por banda')
  }

  for (let band = 0; band < filters.length; band += 1) {
    const filter = filters[band]
    if (!filter) continue

    const { startBin, weights } = filter
    let sum = 0
    for (let i = 0; i < weights.length; i += 1) {
      sum += (power[startBin + i] ?? 0) * (weights[i] ?? 0)
    }
    // O piso evita −Infinity em bandas silenciosas, que contaminaria a DCT
    // inteira do quadro.
    out[band] = Math.log(Math.max(sum, 1e-10))
  }
}
