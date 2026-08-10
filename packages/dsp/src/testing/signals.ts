/**
 * Geradores de sinal para os testes.
 *
 * Tudo aqui é determinístico — inclusive o ruído, que usa um LCG semeado.
 * `Math.random` está proibido por lint neste pacote, e com razão: um teste de
 * DSP que falha uma vez a cada cem execuções é pior que nenhum teste.
 */

/**
 * Leitura com verificação de limites, para uso nos testes.
 *
 * Nos testes o acesso fora dos limites deve falhar alto: um `?? 0` silencioso
 * aqui transformaria um erro de índice do próprio teste em uma asserção que
 * passa por acidente.
 */
export function at(array: ArrayLike<number>, index: number): number {
  const value = array[index]
  if (value === undefined) {
    throw new Error(
      `índice ${String(index)} fora dos limites (tamanho ${String(array.length)})`,
    )
  }
  return value
}

export function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} não existe`)
  return value
}

export function sine(
  frequency: number,
  durationSec: number,
  sampleRate: number,
  amplitude = 0.5,
): Float32Array {
  const samples = new Float32Array(Math.round(durationSec * sampleRate))
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate)
  }
  return samples
}

export function silence(durationSec: number, sampleRate: number): Float32Array {
  return new Float32Array(Math.round(durationSec * sampleRate))
}

/** Congruencial linear — mesma sequência em toda execução. */
export function createRandom(seed = 12_345): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

export function whiteNoise(
  durationSec: number,
  sampleRate: number,
  amplitude = 0.5,
  seed = 12_345,
): Float32Array {
  const random = createRandom(seed)
  const samples = new Float32Array(Math.round(durationSec * sampleRate))
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = (random() * 2 - 1) * amplitude
  }
  return samples
}

export interface Phoneme {
  /** Primeiro formante, Hz. */
  readonly f1: number
  /** Segundo formante, Hz. */
  readonly f2: number
  readonly durationMs: number
}

/** Vogais aproximadas do português, por posição de formantes. */
export const VOWELS = {
  a: { f1: 750, f2: 1300, durationMs: 140 },
  e: { f1: 500, f2: 1900, durationMs: 130 },
  i: { f1: 300, f2: 2300, durationMs: 120 },
  o: { f1: 500, f2: 900, durationMs: 140 },
  u: { f1: 320, f2: 800, durationMs: 130 },
} as const satisfies Record<string, Phoneme>

/**
 * Síntese fonte-filtro simplificada: pulso glotal harmônico moldado por dois
 * ressonadores.
 *
 * Não pretende soar como voz — precisa apenas produzir vetores MFCC que
 * *diferem entre fonemas* e *se repetem para o mesmo fonema*. É o suficiente
 * para que os testes de articulação signifiquem alguma coisa.
 */
export interface SynthOptions {
  phonemes: readonly Phoneme[]
  f0Hz: number
  sampleRate: number
  /** Silêncio antes da primeira fala. */
  leadingSilenceMs?: number
  /** Silêncio entre fonemas. */
  gapMs?: number
  /** Silêncio ao final. */
  trailingSilenceMs?: number
  amplitude?: number
  /** Multiplica todas as durações — usado para testar ritmo. */
  tempo?: number
  /** Semitons somados ao F0 — usado para testar entonação entre registros. */
  transposeSemitones?: number
}

export function synthesizeUtterance(options: SynthOptions): Float32Array {
  const {
    phonemes,
    f0Hz,
    sampleRate,
    leadingSilenceMs = 0,
    gapMs = 40,
    trailingSilenceMs = 0,
    amplitude = 0.4,
    tempo = 1,
    transposeSemitones = 0,
  } = options

  const baseF0 = f0Hz * 2 ** (transposeSemitones / 12)
  const chunks: Float32Array[] = [silence(leadingSilenceMs / 1000, sampleRate)]

  phonemes.forEach((phoneme: Phoneme, index: number) => {
    const durationSec = (phoneme.durationMs * tempo) / 1000
    const length = Math.round(durationSec * sampleRate)
    const chunk = new Float32Array(length)
    const harmonics = Math.floor(sampleRate / 2 / baseF0)

    for (let i = 0; i < length; i += 1) {
      const t = i / sampleRate
      let value = 0
      for (let h = 1; h <= harmonics; h += 1) {
        const frequency = baseF0 * h
        const weight =
          resonance(frequency, phoneme.f1, 90) + 0.7 * resonance(frequency, phoneme.f2, 110)
        value += (weight / h) * Math.sin(2 * Math.PI * frequency * t)
      }
      // Envelope suave nas bordas evita cliques, que virariam transientes de
      // banda larga e sujariam os MFCC das extremidades.
      chunk[i] = value * amplitude * edgeEnvelope(i, length, sampleRate)
    }

    chunks.push(chunk)
    if (index < phonemes.length - 1) chunks.push(silence((gapMs * tempo) / 1000, sampleRate))
  })

  chunks.push(silence(trailingSilenceMs / 1000, sampleRate))
  return concat(chunks)
}

function resonance(frequency: number, center: number, bandwidth: number): number {
  const delta = (frequency - center) / bandwidth
  return 1 / (1 + delta * delta)
}

function edgeEnvelope(index: number, length: number, sampleRate: number): number {
  const rampSamples = Math.min(Math.round(0.008 * sampleRate), Math.floor(length / 2))
  if (rampSamples <= 0) return 1
  if (index < rampSamples) return index / rampSamples
  if (index > length - rampSamples) return (length - index) / rampSamples
  return 1
}

export function concat(chunks: readonly Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const output = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

/** Insere `delayMs` de silêncio antes do sinal. */
export function delay(samples: Float32Array, delayMs: number, sampleRate: number): Float32Array {
  const padding = Math.round((delayMs / 1000) * sampleRate)
  const output = new Float32Array(samples.length + padding)
  output.set(samples, padding)
  return output
}

export function addNoise(
  samples: Float32Array,
  amplitude: number,
  seed = 999,
): Float32Array {
  const random = createRandom(seed)
  const output = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) {
    output[i] = at(samples, i) + (random() * 2 - 1) * amplitude
  }
  return output
}
