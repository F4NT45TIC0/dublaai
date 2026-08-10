import { describe, expect, it } from 'vitest'
import { computeMelSpectrogram } from '../spectrogram'

const SAMPLE_RATE = 16_000

function sine(frequency: number, seconds: number): Float32Array {
  const samples = new Float32Array(Math.round(SAMPLE_RATE * seconds))
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin((2 * Math.PI * frequency * index) / SAMPLE_RATE) * 0.7
  }
  return samples
}

function strongestBand(values: Uint8Array, columns: number, bands: number): number {
  const totals = new Float64Array(bands)
  for (let column = 0; column < columns; column += 1) {
    for (let band = 0; band < bands; band += 1) {
      totals[band] = (totals[band] ?? 0) + (values[column * bands + band] ?? 0)
    }
  }

  let strongest = 0
  for (let band = 1; band < bands; band += 1) {
    if ((totals[band] ?? 0) > (totals[strongest] ?? 0)) strongest = band
  }
  return strongest
}

describe('computeMelSpectrogram', () => {
  it('produz uma matriz compacta, determinística e normalizada', () => {
    const first = computeMelSpectrogram(sine(440, 1), SAMPLE_RATE)
    const second = computeMelSpectrogram(sine(440, 1), SAMPLE_RATE)

    expect(first.columns).toBeGreaterThan(40)
    expect(first.bands).toBe(26)
    expect(first.values).toHaveLength(first.columns * first.bands)
    expect(first.values).toEqual(second.values)
    expect(Math.max(...first.values)).toBeLessThanOrEqual(255)
  })

  it('posiciona um tom agudo acima de um tom grave', () => {
    const low = computeMelSpectrogram(sine(300, 1), SAMPLE_RATE)
    const high = computeMelSpectrogram(sine(3_000, 1), SAMPLE_RATE)

    expect(strongestBand(high.values, high.columns, high.bands)).toBeGreaterThan(
      strongestBand(low.values, low.columns, low.bands),
    )
  })

  it('mantém silêncio no piso visual', () => {
    const spectrogram = computeMelSpectrogram(new Float32Array(SAMPLE_RATE), SAMPLE_RATE)
    expect(spectrogram.values.every((value) => value === 0)).toBe(true)
  })
})
