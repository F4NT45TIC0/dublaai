import { describe, expect, it } from 'vitest'
import { ANALYSIS_SAMPLE_RATE, FEATURE_DIM, HOP_MS } from '../constants'
import { detectSpeech } from '../vad'
import { dtwAlign } from '../dtw'
import { estimateGlobalOffset, pearson } from '../correlate'
import { computeWaveformPeaks, extractFeatures, msToFrame } from '../features'
import { decodeReferenceFeatures, encodeReferenceFeatures } from '../codec'
import {
  addNoise,
  at,
  required,
  delay,
  silence,
  type SynthOptions,
  synthesizeUtterance,
  VOWELS,
  whiteNoise,
} from '../testing/signals'

const SR = ANALYSIS_SAMPLE_RATE

type SpeakOptions = Omit<SynthOptions, 'sampleRate' | 'f0Hz'> & { f0Hz?: number }

function speak(options: SpeakOptions): Float32Array {
  return synthesizeUtterance({ sampleRate: SR, f0Hz: 130, ...options })
}

const PHRASE = [VOWELS.o, VOWELS.a, VOWELS.i, VOWELS.e] as const
const OTHER_PHRASE = [VOWELS.i, VOWELS.u, VOWELS.e, VOWELS.a] as const

describe('detectSpeech', () => {
  it('encontra as regiões de fala nos instantes esperados', () => {
    const signal = speak({
      phonemes: [VOWELS.a],
      leadingSilenceMs: 500,
      trailingSilenceMs: 500,
    })
    const { regions, speechRatio } = detectSpeech(extractFeatures(signal, SR).rmsDb)

    expect(regions.length).toBeGreaterThanOrEqual(1)
    const first = required(regions[0], 'primeira região de fala')
    const onsetMs = first.startFrame * HOP_MS
    expect(Math.abs(onsetMs - 500)).toBeLessThan(80)
    expect(speechRatio).toBeGreaterThan(0.05)
    expect(speechRatio).toBeLessThan(0.5)
  })

  it('não quebra uma frase em cada pausa curta entre sílabas', () => {
    const signal = speak({ phonemes: PHRASE, gapMs: 40, leadingSilenceMs: 300 })
    const { regions } = detectSpeech(extractFeatures(signal, SR).rmsDb)
    // Quatro vogais com 40 ms de intervalo devem virar uma frase, não quatro.
    expect(regions.length).toBeLessThanOrEqual(2)
  })

  it('separa falas com pausa longa entre elas', () => {
    const signal = speak({ phonemes: PHRASE, gapMs: 400, leadingSilenceMs: 300 })
    const { regions } = detectSpeech(extractFeatures(signal, SR).rmsDb)
    expect(regions.length).toBeGreaterThanOrEqual(3)
  })

  it('não detecta fala em silêncio', () => {
    const { regions, speechRatio } = detectSpeech(extractFeatures(silence(2, SR), SR).rmsDb)
    expect(regions).toHaveLength(0)
    expect(speechRatio).toBe(0)
  })
})

describe('dtwAlign', () => {
  it('alinha na diagonal e dá distância zero para sinais idênticos', () => {
    const features = extractFeatures(speak({ phonemes: PHRASE, leadingSilenceMs: 200 }), SR)
    const result = dtwAlign(
      features.features,
      features.frameCount,
      features.features,
      features.frameCount,
    )

    expect(result.distance).toBeLessThan(0.001)
    for (let frame = 0; frame < features.frameCount; frame += 1) {
      expect(Math.abs(at(result.alignment, frame) - frame)).toBeLessThanOrEqual(1)
    }
  })

  it('recupera o deslocamento quando a fala inteira atrasa', () => {
    const base = speak({ phonemes: PHRASE, leadingSilenceMs: 300, trailingSilenceMs: 600 })
    const shifted = delay(base, 200, SR)

    const reference = extractFeatures(base, SR)
    const user = extractFeatures(shifted, SR)
    const result = dtwAlign(
      reference.features,
      reference.frameCount,
      user.features,
      user.frameCount,
    )

    // Durante a fala, o caminho deve estar deslocado ~10 quadros (200 ms).
    const speechFrame = msToFrame(400)
    expect(at(result.alignment, speechFrame) - speechFrame).toBeGreaterThan(5)
    expect(at(result.alignment, speechFrame) - speechFrame).toBeLessThan(16)
  })

  it('detecta que o usuário falou mais rápido pela inclinação do caminho', () => {
    const reference = extractFeatures(
      speak({ phonemes: PHRASE, leadingSilenceMs: 200, trailingSilenceMs: 200 }),
      SR,
    )
    const fast = extractFeatures(
      speak({ phonemes: PHRASE, leadingSilenceMs: 200, trailingSilenceMs: 200, tempo: 0.6 }),
      SR,
    )

    const result = dtwAlign(
      reference.features,
      reference.frameCount,
      fast.features,
      fast.frameCount,
    )

    const middle = Math.floor(reference.frameCount / 2)
    expect(at(result.slope, middle)).toBeLessThan(0.95)
  })

  it('dá distância maior para fala diferente do que para a mesma fala', () => {
    const reference = extractFeatures(speak({ phonemes: PHRASE }), SR)
    const same = extractFeatures(speak({ phonemes: PHRASE, f0Hz: 200 }), SR)
    const different = extractFeatures(speak({ phonemes: OTHER_PHRASE, f0Hz: 200 }), SR)

    const sameDistance = dtwAlign(
      reference.features,
      reference.frameCount,
      same.features,
      same.frameCount,
    ).distance
    const otherDistance = dtwAlign(
      reference.features,
      reference.frameCount,
      different.features,
      different.frameCount,
    ).distance

    expect(sameDistance).toBeLessThan(otherDistance)
  })

  it('devolve distância máxima quando um dos lados está vazio', () => {
    const result = dtwAlign(new Float32Array(0), 0, new Float32Array(FEATURE_DIM), 1)
    expect(result.distance).toBe(2)
    expect(result.pathLength).toBe(0)
  })
})

describe('estimateGlobalOffset', () => {
  it('recupera o atraso injetado no envelope de atividade', () => {
    const base = speak({ phonemes: PHRASE, leadingSilenceMs: 400, trailingSilenceMs: 800 })

    for (const delayMs of [-200, -100, 0, 100, 200]) {
      const shifted =
        delayMs >= 0
          ? delay(base, delayMs, SR)
          : base.subarray(Math.round((-delayMs / 1000) * SR))

      const reference = extractFeatures(base, SR)
      const user = extractFeatures(new Float32Array(shifted), SR)
      const estimate = estimateGlobalOffset(reference.activity, user.activity)

      const estimatedMs = estimate.lagFrames * HOP_MS
      expect(Math.abs(estimatedMs - delayMs)).toBeLessThanOrEqual(40)
      expect(estimate.confidence).toBeGreaterThan(0.6)
    }
  })

  it('reporta confiança baixa entre fala e ruído', () => {
    const reference = extractFeatures(speak({ phonemes: PHRASE, leadingSilenceMs: 400 }), SR)
    const noise = extractFeatures(whiteNoise(2, SR, 0.2), SR)
    const estimate = estimateGlobalOffset(reference.activity, noise.activity)
    expect(estimate.confidence).toBeLessThan(0.95)
  })
})

describe('pearson', () => {
  it('devolve 1 para sinais idênticos e -1 para invertidos', () => {
    const a = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    const inverted = a.map((value) => -value)
    expect(pearson(a, a)).toBeCloseTo(1, 6)
    expect(pearson(a, inverted)).toBeCloseTo(-1, 6)
  })

  it('devolve null — e não 0 — quando não há dados suficientes', () => {
    expect(pearson(Float32Array.from([1, 2]), Float32Array.from([1, 2]))).toBeNull()
  })

  it('devolve null para um sinal constante', () => {
    const constant = new Float32Array(20).fill(3)
    const varying = Float32Array.from({ length: 20 }, (_, i) => i)
    expect(pearson(constant, varying)).toBeNull()
  })

  it('ignora posições fora da máscara', () => {
    const a = Float32Array.from({ length: 20 }, (_, i) => (i < 10 ? i : 1_000))
    const b = Float32Array.from({ length: 20 }, (_, i) => (i < 10 ? i : -1_000))
    const mask = new Uint8Array(20)
    mask.fill(1, 0, 10)
    expect(pearson(a, b, mask, 5)).toBeCloseTo(1, 6)
  })
})

describe('extractFeatures', () => {
  it('estima a mediana de F0 próxima da frequência sintetizada', () => {
    const features = extractFeatures(speak({ phonemes: PHRASE, f0Hz: 150 }), SR)
    expect(features.medianF0Hz).toBeGreaterThan(140)
    expect(features.medianF0Hz).toBeLessThan(160)
  })

  it('centra o contorno em cents na mediana do próprio falante', () => {
    // Grave e agudo com o mesmo conteúdo: os contornos normalizados devem ficar
    // parecidos, que é a premissa da métrica de entonação.
    const low = extractFeatures(speak({ phonemes: PHRASE, f0Hz: 100 }), SR)
    const high = extractFeatures(speak({ phonemes: PHRASE, f0Hz: 220 }), SR)

    const voicedMedian = (values: Float32Array) => {
      const finite = Array.from(values).filter((value) => Number.isFinite(value))
      return finite.reduce((sum, value) => sum + value, 0) / Math.max(1, finite.length)
    }

    expect(Math.abs(voicedMedian(low.f0Cents))).toBeLessThan(60)
    expect(Math.abs(voicedMedian(high.f0Cents))).toBeLessThan(60)
  })

  it('detecta estouro nas amostras originais', () => {
    const loud = speak({ phonemes: PHRASE, amplitude: 3 })
    const features = extractFeatures(loud, SR)
    expect(features.clippedRatio).toBeGreaterThan(0)
    expect(features.peakDb).toBeGreaterThan(-1)
  })

  it('reporta pico muito baixo para uma gravação quase inaudível', () => {
    const veryQuiet = speak({ phonemes: PHRASE, amplitude: 0.002 })
    expect(extractFeatures(veryQuiet, SR).peakDb).toBeLessThan(-45)
  })

  it('lida com entrada vazia sem quebrar', () => {
    const features = extractFeatures(new Float32Array(0), SR)
    expect(features.frameCount).toBe(0)
    expect(features.speechRatio).toBe(0)
  })

  it('é determinístico', () => {
    const signal = speak({ phonemes: PHRASE })
    const first = extractFeatures(signal, SR)
    const second = extractFeatures(signal, SR)
    expect(Array.from(first.features)).toEqual(Array.from(second.features))
    expect(first.medianF0Hz).toBe(second.medianF0Hz)
  })
})

describe('codec de features de referência', () => {
  it('sobrevive a uma volta completa dentro do erro de quantização', () => {
    const signal = speak({ phonemes: PHRASE, leadingSilenceMs: 200 })
    const features = extractFeatures(signal, SR)
    const peaks = computeWaveformPeaks(signal, SR, 200)
    const anchors = { dFloor: 0.08, dChance: 0.92 }

    const decoded = decodeReferenceFeatures(
      encodeReferenceFeatures(features, anchors, peaks),
    )

    expect(decoded.frameCount).toBe(features.frameCount)
    expect(decoded.anchors.dFloor).toBeCloseTo(anchors.dFloor, 5)
    expect(decoded.anchors.dChance).toBeCloseTo(anchors.dChance, 5)
    expect(decoded.medianF0Hz).toBeCloseTo(features.medianF0Hz, 2)
    expect(Array.from(decoded.speech)).toEqual(Array.from(features.speech))
    expect(decoded.peaks.length).toBe(peaks.length)

    for (let i = 0; i < features.features.length; i += 1) {
      expect(Math.abs(at(decoded.features, i) - at(features.features, i))).toBeLessThanOrEqual(1 / 32 + 1e-6)
    }
  })

  it('reconstrói as regiões de fala a partir da máscara', () => {
    const signal = speak({ phonemes: PHRASE, gapMs: 400, leadingSilenceMs: 300 })
    const features = extractFeatures(signal, SR)
    const decoded = decodeReferenceFeatures(
      encodeReferenceFeatures(features, { dFloor: 0, dChance: 1 }, new Int8Array(0)),
    )
    expect(decoded.regions.length).toBe(features.regions.length)
  })

  it('recusa assinatura inválida', () => {
    const buffer = new ArrayBuffer(64)
    new DataView(buffer).setUint32(0, 0xdeadbeef, false)
    expect(() => decodeReferenceFeatures(buffer)).toThrow(/assinatura/)
  })

  it('recusa arquivo com tamanho inconsistente com o cabeçalho', () => {
    const features = extractFeatures(speak({ phonemes: [VOWELS.a] }), SR)
    const encoded = encodeReferenceFeatures(features, { dFloor: 0, dChance: 1 }, new Int8Array(0))
    // Corta o final: um `frameCount` que promete mais dados do que existe é
    // exatamente o vetor de leitura fora dos limites que a validação previne.
    expect(() => decodeReferenceFeatures(encoded.slice(0, encoded.byteLength - 10))).toThrow(
      /tamanho inconsistente/,
    )
  })

  it('recusa arquivo menor que o cabeçalho', () => {
    expect(() => decodeReferenceFeatures(new ArrayBuffer(8))).toThrow(/menor que o cabeçalho/)
  })
})

describe('computeWaveformPeaks', () => {
  it('produz pares min/max dentro da faixa de int8', () => {
    const signal = addNoise(speak({ phonemes: PHRASE }), 0.05)
    const peaks = computeWaveformPeaks(signal, SR, 200)
    expect(peaks.length % 2).toBe(0)
    for (let i = 0; i < peaks.length; i += 2) {
      expect(at(peaks, i)).toBeLessThanOrEqual(at(peaks, i + 1))
      expect(at(peaks, i)).toBeGreaterThanOrEqual(-127)
      expect(at(peaks, i + 1)).toBeLessThanOrEqual(127)
    }
  })
})
