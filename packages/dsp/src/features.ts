import {
  ANALYSIS_SAMPLE_RATE,
  DB_FLOOR,
  F0_WINDOW,
  FFT_SIZE,
  FRAME_SIZE,
  HOP_MS,
  HOP_SIZE,
  MEL_BANDS,
  MFCC_COUNT,
  PRE_EMPHASIS,
  SPECTRUM_BINS,
  YIN_MAX_APERIODICITY,
} from './constants'
import { amplitudeToDb, analyzeSignal, percentile, rms } from './energy'
import { Fft } from './fft'
import { applyMelFilterbank, createMelFilterbank } from './mel'
import { applyCmvn, combineFeatures, computeDeltas, dctMfcc } from './mfcc'
import { resample } from './resample'
import { activityEnvelope, detectSpeech, type SpeechRegion } from './vad'
import { hannWindow } from './window'
import { hzToCents, YinDetector } from './yin'

/**
 * Representação completa de uma elocução, no domínio em que a comparação é
 * justa. Idêntica para referência e usuário — a mesma régua dos dois lados.
 */
export interface FeatureSet {
  readonly sampleRate: number
  readonly hopMs: number
  readonly frameCount: number
  /** `frameCount × FEATURE_DIM`, já com CMVN aplicada. */
  readonly features: Float32Array
  /** Cents relativos à mediana do PRÓPRIO falante. `NaN` onde não é sonoro. */
  readonly f0Cents: Float32Array
  /** 0..1 — confiança de sonoridade por quadro. */
  readonly voicing: Float32Array
  readonly rmsDb: Float32Array
  readonly speech: Uint8Array
  readonly regions: readonly SpeechRegion[]
  readonly medianF0Hz: number
  readonly noiseFloorDb: number
  readonly peakDb: number
  readonly clippedRatio: number
  readonly speechRatio: number
  /** Envelope contínuo de atividade, para a estimativa de offset global. */
  readonly activity: Float32Array
}

export function framesForDuration(durationMs: number): number {
  return Math.max(0, Math.floor(durationMs / HOP_MS))
}

export function frameToMs(frame: number): number {
  return frame * HOP_MS
}

export function msToFrame(ms: number): number {
  return Math.round(ms / HOP_MS)
}

/**
 * Extrai o `FeatureSet` de um bloco de amostras mono.
 *
 * Reamostra para 16 kHz internamente — a taxa de análise é fixa para que
 * referência e usuário sejam sempre medidos no mesmo domínio, independente do
 * hardware de captura (que pode entregar 44,1 kHz, 48 kHz ou o que o dispositivo
 * impuser).
 */
export function extractFeatures(samples: Float32Array, sampleRate: number): FeatureSet {
  // Medido antes da reamostragem: o passa-baixa atenuaria os picos de estouro.
  const { peakDb, clippedRatio } = analyzeSignal(samples)

  const signal = resample(samples, sampleRate, ANALYSIS_SAMPLE_RATE)
  const frameCount = Math.max(0, Math.floor((signal.length - FRAME_SIZE) / HOP_SIZE) + 1)

  if (frameCount <= 0) {
    return emptyFeatureSet(peakDb, clippedRatio)
  }

  const emphasized = preEmphasize(signal)
  const window = hannWindow(FRAME_SIZE)
  const fft = new Fft(FFT_SIZE)
  const filterbank = createMelFilterbank(ANALYSIS_SAMPLE_RATE)
  const yin = new YinDetector(ANALYSIS_SAMPLE_RATE, F0_WINDOW)

  const windowed = new Float32Array(FRAME_SIZE)
  const power = new Float64Array(SPECTRUM_BINS)
  const logMel = new Float64Array(MEL_BANDS)
  const coefficients = new Float64Array(MFCC_COUNT)

  const mfcc = new Float32Array(frameCount * MFCC_COUNT)
  const rmsDb = new Float32Array(frameCount)
  const f0Hz = new Float32Array(frameCount)
  const voicing = new Float32Array(frameCount)
  const f0Frame = new Float32Array(F0_WINDOW)

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * HOP_SIZE

    for (let i = 0; i < FRAME_SIZE; i += 1) {
      windowed[i] = (emphasized[start + i] ?? 0) * (window[i] ?? 0)
    }

    fft.powerSpectrum(windowed, power)
    applyMelFilterbank(power, filterbank, logMel)
    dctMfcc(logMel, coefficients)
    for (let c = 0; c < MFCC_COUNT; c += 1) {
      mfcc[frame * MFCC_COUNT + c] = coefficients[c] ?? 0
    }

    // RMS no sinal SEM pré-ênfase: a pré-ênfase é um filtro que altera o nível
    // de forma dependente do conteúdo espectral, e a energia precisa refletir
    // o que a pessoa realmente fez.
    rmsDb[frame] = amplitudeToDb(rms(signal, start, FRAME_SIZE))

    // A janela do F0 é maior que a do MFCC e fica centrada no mesmo instante.
    const f0Start = start + FRAME_SIZE / 2 - F0_WINDOW / 2
    for (let i = 0; i < F0_WINDOW; i += 1) {
      const index = f0Start + i
      f0Frame[i] = index >= 0 && index < signal.length ? (signal[index] ?? 0) : 0
    }
    const pitch = yin.estimate(f0Frame)
    if (pitch.frequency > 0 && pitch.aperiodicity <= YIN_MAX_APERIODICITY) {
      f0Hz[frame] = pitch.frequency
      voicing[frame] = 1 - pitch.aperiodicity
    } else {
      f0Hz[frame] = 0
      voicing[frame] = 0
    }
  }

  const vad = detectSpeech(rmsDb)

  const deltas = computeDeltas(mfcc, frameCount)
  const features = combineFeatures(mfcc, deltas, frameCount)
  applyCmvn(features, frameCount, vad.speech)

  const medianF0Hz = medianOfVoiced(f0Hz, voicing, vad.speech)
  const f0Cents = new Float32Array(frameCount)
  for (let frame = 0; frame < frameCount; frame += 1) {
    const frequency = f0Hz[frame] ?? 0
    f0Cents[frame] = frequency > 0 && medianF0Hz > 0 ? hzToCents(frequency, medianF0Hz) : Number.NaN
  }

  return {
    sampleRate: ANALYSIS_SAMPLE_RATE,
    hopMs: HOP_MS,
    frameCount,
    features,
    f0Cents,
    voicing,
    rmsDb,
    speech: vad.speech,
    regions: vad.regions,
    medianF0Hz,
    noiseFloorDb: vad.noiseFloorDb,
    peakDb,
    clippedRatio,
    speechRatio: vad.speechRatio,
    activity: activityEnvelope(rmsDb, vad.noiseFloorDb),
  }
}

function preEmphasize(signal: Float32Array): Float32Array {
  const output = new Float32Array(signal.length)
  if (signal.length === 0) return output
  output[0] = signal[0] ?? 0
  for (let i = 1; i < signal.length; i += 1) {
    output[i] = (signal[i] ?? 0) - PRE_EMPHASIS * (signal[i - 1] ?? 0)
  }
  return output
}

/**
 * Mediana do F0 sobre quadros sonoros — a referência de "registro" do falante.
 *
 * Mediana e não média porque erros de oitava residuais do YIN são outliers
 * multiplicativos: um único quadro detectado uma oitava acima desloca a média
 * o suficiente para inclinar todo o contorno em cents.
 */
function medianOfVoiced(f0Hz: Float32Array, voicing: Float32Array, speech: Uint8Array): number {
  const voiced: number[] = []
  for (let frame = 0; frame < f0Hz.length; frame += 1) {
    const frequency = f0Hz[frame] ?? 0
    if (frequency > 0 && (voicing[frame] ?? 0) > 0 && speech[frame] === 1) voiced.push(frequency)
  }
  if (voiced.length === 0) return 0
  return percentile(voiced, 0.5)
}

function emptyFeatureSet(peakDb: number, clippedRatio: number): FeatureSet {
  return {
    sampleRate: ANALYSIS_SAMPLE_RATE,
    hopMs: HOP_MS,
    frameCount: 0,
    features: new Float32Array(0),
    f0Cents: new Float32Array(0),
    voicing: new Float32Array(0),
    rmsDb: new Float32Array(0),
    speech: new Uint8Array(0),
    regions: [],
    medianF0Hz: 0,
    noiseFloorDb: DB_FLOOR,
    peakDb,
    clippedRatio,
    speechRatio: 0,
    activity: new Float32Array(0),
  }
}

/**
 * Picos min/max por balde, para desenhar a waveform.
 *
 * Min e max em vez de RMS porque a waveform precisa mostrar a forma de onda
 * real; RMS produziria um envelope simétrico e sem caráter.
 */
export function computeWaveformPeaks(
  samples: Float32Array,
  sampleRate: number,
  bucketsPerSecond = 400,
): Int8Array {
  const durationSeconds = samples.length / sampleRate
  const bucketCount = Math.max(1, Math.round(durationSeconds * bucketsPerSecond))
  const peaks = new Int8Array(bucketCount * 2)
  const samplesPerBucket = samples.length / bucketCount

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = Math.floor(bucket * samplesPerBucket)
    const end = Math.min(samples.length, Math.floor((bucket + 1) * samplesPerBucket))
    let min = 0
    let max = 0
    for (let i = start; i < end; i += 1) {
      const value = samples[i] ?? 0
      if (value < min) min = value
      if (value > max) max = value
    }
    peaks[bucket * 2] = Math.max(-127, Math.round(min * 127))
    peaks[bucket * 2 + 1] = Math.min(127, Math.round(max * 127))
  }

  return peaks
}
