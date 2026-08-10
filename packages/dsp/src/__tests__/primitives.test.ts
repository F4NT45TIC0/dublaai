import { describe, expect, it } from 'vitest'
import { Fft } from '../fft'
import { hannWindow } from '../window'
import { createMelFilterbank, hzToMel, melToHz } from '../mel'
import { resample } from '../resample'
import { YinDetector } from '../yin'
import { ANALYSIS_SAMPLE_RATE, F0_WINDOW, FFT_SIZE, SPECTRUM_BINS } from '../constants'
import { at, sine, silence, whiteNoise } from '../testing/signals'

describe('Fft', () => {
  it('coloca o pico no bin correspondente à frequência do seno', () => {
    const sampleRate = 16_000
    const frequency = 1_000
    const fft = new Fft(FFT_SIZE)
    const window = hannWindow(FFT_SIZE)
    const signal = sine(frequency, 0.1, sampleRate, 1)

    const frame = new Float32Array(FFT_SIZE)
    for (let i = 0; i < FFT_SIZE; i += 1) frame[i] = at(signal, i) * at(window, i)

    const spectrum = new Float64Array(SPECTRUM_BINS)
    fft.powerSpectrum(frame, spectrum)

    let peakBin = 0
    for (let bin = 1; bin < SPECTRUM_BINS; bin += 1) {
      if (at(spectrum, bin) > at(spectrum, peakBin)) peakBin = bin
    }

    const expectedBin = Math.round((frequency / sampleRate) * FFT_SIZE)
    expect(Math.abs(peakBin - expectedBin)).toBeLessThanOrEqual(1)
  })

  it('rejeita tamanhos que não são potência de 2', () => {
    expect(() => new Fft(500)).toThrow(/potência de 2/)
  })

  it('preserva energia entre tempo e frequência (Parseval)', () => {
    const fft = new Fft(64)
    const re = new Float64Array(64)
    const im = new Float64Array(64)
    for (let i = 0; i < 64; i += 1) re[i] = Math.sin((2 * Math.PI * 5 * i) / 64)

    let timeEnergy = 0
    for (let i = 0; i < 64; i += 1) timeEnergy += at(re, i) * at(re, i)

    fft.transform(re, im)

    let frequencyEnergy = 0
    for (let i = 0; i < 64; i += 1) frequencyEnergy += at(re, i) * at(re, i) + at(im, i) * at(im, i)

    expect(frequencyEnergy / 64).toBeCloseTo(timeEnergy, 6)
  })
})

describe('escala mel', () => {
  it('hzToMel e melToHz são inversas', () => {
    for (const hz of [50, 300, 1_000, 4_000, 8_000]) {
      expect(melToHz(hzToMel(hz))).toBeCloseTo(hz, 3)
    }
  })

  it('produz filtros ordenados, com peso positivo e cobrindo a banda de voz', () => {
    const filters = createMelFilterbank(ANALYSIS_SAMPLE_RATE)
    expect(filters).toHaveLength(26)

    let previousStart = -1
    for (const filter of filters) {
      expect(filter.startBin).toBeGreaterThanOrEqual(previousStart)
      previousStart = filter.startBin
      const total = filter.weights.reduce((sum, weight) => sum + weight, 0)
      expect(total).toBeGreaterThan(0)
      for (const weight of filter.weights) {
        expect(weight).toBeGreaterThanOrEqual(0)
        expect(weight).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('resample', () => {
  it('mantém a frequência ao reduzir a taxa', () => {
    const original = sine(200, 0.3, 48_000, 0.8)
    const converted = resample(original, 48_000, ANALYSIS_SAMPLE_RATE)

    expect(converted.length).toBeCloseTo(0.3 * ANALYSIS_SAMPLE_RATE, -2)

    const detector = new YinDetector(ANALYSIS_SAMPLE_RATE, F0_WINDOW)
    const frame = converted.subarray(2_000, 2_000 + F0_WINDOW)
    expect(detector.estimate(frame).frequency).toBeCloseTo(200, 0)
  })

  it('atenua acima do novo Nyquist em vez de dobrar a frequência de volta', () => {
    // 10 kHz a 48 kHz. Sem anti-aliasing, isto reapareceria em 6 kHz depois de
    // ir para 16 kHz — bem no meio da banda de fala.
    const original = sine(10_000, 0.2, 48_000, 0.8)
    const converted = resample(original, 48_000, ANALYSIS_SAMPLE_RATE)

    let energy = 0
    for (let i = 0; i < converted.length; i += 1) energy += at(converted, i) * at(converted, i)
    const rmsValue = Math.sqrt(energy / converted.length)

    // Atenuação de pelo menos 20 dB em relação ao sinal original (RMS ≈ 0.566).
    expect(rmsValue).toBeLessThan(0.056)
  })

  it('devolve cópia quando as taxas são iguais', () => {
    const original = sine(440, 0.05, 16_000)
    const converted = resample(original, 16_000, 16_000)
    expect(converted).not.toBe(original)
    expect(Array.from(converted)).toEqual(Array.from(original))
  })
})

describe('YinDetector', () => {
  const detector = new YinDetector(ANALYSIS_SAMPLE_RATE, F0_WINDOW)

  it('acerta a frequência de senos na faixa de voz', () => {
    for (const frequency of [80, 120, 200, 330]) {
      const signal = sine(frequency, 0.2, ANALYSIS_SAMPLE_RATE, 0.8)
      const estimate = detector.estimate(signal.subarray(1_000, 1_000 + F0_WINDOW))
      expect(Math.abs(estimate.frequency - frequency)).toBeLessThan(2)
      expect(estimate.aperiodicity).toBeLessThan(0.2)
    }
  })

  it('não confunde 100 Hz com a oitava abaixo', () => {
    const signal = sine(100, 0.2, ANALYSIS_SAMPLE_RATE, 0.8)
    const estimate = detector.estimate(signal.subarray(1_000, 1_000 + F0_WINDOW))
    expect(estimate.frequency).toBeGreaterThan(95)
    expect(estimate.frequency).toBeLessThan(105)
  })

  it('reporta alta aperiodicidade para ruído branco', () => {
    const noise = whiteNoise(0.2, ANALYSIS_SAMPLE_RATE, 0.5)
    const estimate = detector.estimate(noise.subarray(1_000, 1_000 + F0_WINDOW))
    expect(estimate.aperiodicity).toBeGreaterThan(0.45)
  })

  it('trata silêncio sem quebrar', () => {
    const quiet = silence(0.2, ANALYSIS_SAMPLE_RATE)
    const estimate = detector.estimate(quiet.subarray(0, F0_WINDOW))
    expect(estimate.aperiodicity).toBeGreaterThan(0.45)
  })

  it('recusa janela curta demais para a frequência mínima', () => {
    expect(() => new YinDetector(ANALYSIS_SAMPLE_RATE, 256)).toThrow(/curta demais/)
  })
})
