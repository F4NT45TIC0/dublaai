import {
  ANALYSIS_SAMPLE_RATE,
  FFT_SIZE,
  FRAME_SIZE,
  HOP_SIZE,
  MEL_BANDS,
  SPECTRUM_BINS,
} from './constants'
import { Fft } from './fft'
import { applyMelFilterbank, createMelFilterbank } from './mel'
import { resample } from './resample'
import { hannWindow } from './window'

/** Matriz frame-major: `columns × bands`, normalizada em 0..255. */
export interface MelSpectrogram {
  readonly columns: number
  readonly bands: number
  readonly values: Uint8Array
}

/** Aproximadamente 52 dB de faixa visual em energia logarítmica. */
const LOG_DYNAMIC_RANGE = 12

/**
 * Espectrograma mel compacto para visualização.
 *
 * Usa a mesma reamostragem, janela, FFT e hop da extração de features. Ele não
 * tenta desenhar MFCC como espectro: preserva a energia logarítmica das bandas
 * mel antes da DCT.
 */
export function computeMelSpectrogram(
  samples: Float32Array,
  sampleRate: number,
  bands = MEL_BANDS,
): MelSpectrogram {
  const signal = resample(samples, sampleRate, ANALYSIS_SAMPLE_RATE)
  const columns = Math.max(0, Math.floor((signal.length - FRAME_SIZE) / HOP_SIZE) + 1)
  if (columns === 0 || bands <= 0) {
    return { columns: 0, bands: Math.max(0, bands), values: new Uint8Array(0) }
  }

  const window = hannWindow(FRAME_SIZE)
  const fft = new Fft(FFT_SIZE)
  const filters = createMelFilterbank(ANALYSIS_SAMPLE_RATE, bands)
  const frame = new Float32Array(FRAME_SIZE)
  const power = new Float64Array(SPECTRUM_BINS)
  const logMel = new Float64Array(bands)
  const raw = new Float32Array(columns * bands)

  let minimum = Number.POSITIVE_INFINITY
  let maximum = Number.NEGATIVE_INFINITY

  for (let column = 0; column < columns; column += 1) {
    const start = column * HOP_SIZE
    for (let index = 0; index < FRAME_SIZE; index += 1) {
      frame[index] = (signal[start + index] ?? 0) * (window[index] ?? 0)
    }

    fft.powerSpectrum(frame, power)
    applyMelFilterbank(power, filters, logMel)

    for (let band = 0; band < bands; band += 1) {
      const value = logMel[band] ?? 0
      raw[column * bands + band] = value
      if (value < minimum) minimum = value
      if (value > maximum) maximum = value
    }
  }

  const values = new Uint8Array(raw.length)
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum - minimum < 1e-6) {
    return { columns, bands, values }
  }

  const floor = Math.max(minimum, maximum - LOG_DYNAMIC_RANGE)
  const range = Math.max(1e-6, maximum - floor)
  for (let index = 0; index < raw.length; index += 1) {
    const normalized = ((raw[index] ?? floor) - floor) / range
    values[index] = Math.round(Math.min(1, Math.max(0, normalized)) * 255)
  }

  return { columns, bands, values }
}
