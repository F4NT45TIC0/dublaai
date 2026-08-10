import { blackmanWindow } from './window'

/**
 * Reamostragem com filtro anti-aliasing.
 *
 * Descartar amostras direto (a "reamostragem" que parece funcionar) dobra as
 * frequências acima do novo Nyquist de volta para dentro da banda. A 48→16 kHz
 * isso jogaria tudo entre 8 e 24 kHz por cima da fala, envenenando os MFCC de
 * forma dependente do conteúdo — ou seja, um erro que só aparece em algumas
 * gravações. Por isso o FIR passa-baixa vem antes.
 */

const FIR_TAPS = 63

function designLowPass(normalizedCutoff: number): Float64Array {
  const taps = new Float64Array(FIR_TAPS)
  const window = blackmanWindow(FIR_TAPS)
  const center = (FIR_TAPS - 1) / 2
  let sum = 0

  for (let i = 0; i < FIR_TAPS; i += 1) {
    const x = i - center
    const sinc =
      x === 0 ? 2 * normalizedCutoff : Math.sin(2 * Math.PI * normalizedCutoff * x) / (Math.PI * x)
    const value = sinc * (window[i] ?? 0)
    taps[i] = value
    sum += value
  }

  // Ganho unitário em DC.
  if (sum !== 0) {
    for (let i = 0; i < FIR_TAPS; i += 1) taps[i] = (taps[i] ?? 0) / sum
  }
  return taps
}

function convolve(input: Float32Array, taps: Float64Array): Float32Array {
  const output = new Float32Array(input.length)
  const center = (taps.length - 1) / 2

  for (let i = 0; i < input.length; i += 1) {
    let acc = 0
    for (let k = 0; k < taps.length; k += 1) {
      const index = i + k - center
      // Bordas por extensão de zero: a cauda do FIR é curta o bastante para
      // que o transiente fique abaixo de um quadro de análise.
      if (index >= 0 && index < input.length) acc += (input[index] ?? 0) * (taps[k] ?? 0)
    }
    output[i] = acc
  }
  return output
}

/**
 * Converte para `targetRate`. Interpolação linear após o passa-baixa, o que é
 * suficiente porque o sinal já está com banda limitada bem abaixo do Nyquist
 * de saída.
 */
export function resample(input: Float32Array, inputRate: number, targetRate: number): Float32Array {
  if (inputRate <= 0 || targetRate <= 0) {
    throw new Error('resample: taxas precisam ser positivas')
  }
  if (inputRate === targetRate) return new Float32Array(input)
  if (input.length === 0) return new Float32Array(0)

  const source =
    targetRate < inputRate
      ? convolve(input, designLowPass((0.45 * targetRate) / inputRate))
      : input

  const ratio = inputRate / targetRate
  const outputLength = Math.max(1, Math.floor(input.length / ratio))
  const output = new Float32Array(outputLength)

  for (let i = 0; i < outputLength; i += 1) {
    const position = i * ratio
    const index = Math.floor(position)
    const fraction = position - index
    const a = source[index] ?? 0
    const b = index + 1 < source.length ? (source[index + 1] ?? a) : a
    output[i] = a + (b - a) * fraction
  }

  return output
}

/** Mixa canais intercalados para mono somando e dividindo pela contagem. */
export function toMono(interleaved: Float32Array, channels: number): Float32Array {
  if (channels <= 1) return new Float32Array(interleaved)
  const frames = Math.floor(interleaved.length / channels)
  const output = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) {
    let sum = 0
    for (let c = 0; c < channels; c += 1) sum += interleaved[i * channels + c] ?? 0
    output[i] = sum / channels
  }
  return output
}
