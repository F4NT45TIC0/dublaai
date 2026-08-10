import { DELTA_WINDOW, FEATURE_DIM, MFCC_COUNT } from './constants'

/**
 * DCT-II ortonormal das log-energias mel.
 *
 * O coeficiente 0 é deliberadamente descartado: ele é a média das log-energias,
 * ou seja, o volume. Mantê-lo faria a articulação medir o quão alto a pessoa
 * falou (docs/SCORING.md §0).
 */
export function dctMfcc(logMel: Float64Array, out: Float64Array, count = MFCC_COUNT): void {
  const bands = logMel.length
  if (out.length !== count) {
    throw new Error('dctMfcc: saída precisa ter `count` posições')
  }
  const scale = Math.sqrt(2 / bands)

  for (let k = 1; k <= count; k += 1) {
    let sum = 0
    for (let n = 0; n < bands; n += 1) {
      sum += (logMel[n] ?? 0) * Math.cos((Math.PI * k * (n + 0.5)) / bands)
    }
    out[k - 1] = sum * scale
  }
}

/**
 * Deltas por regressão sobre ±`DELTA_WINDOW` quadros.
 *
 * Capturam transições de articulação — a diferença entre uma vogal sustentada e
 * a mesma vogal chegando de uma plosiva. É o que impede que alguém segurando
 * um "aaaa" pontue como quem articulou a frase inteira.
 */
export function computeDeltas(
  mfcc: Float32Array,
  frameCount: number,
  coefficients = MFCC_COUNT,
): Float32Array {
  const deltas = new Float32Array(frameCount * coefficients)
  let denominator = 0
  for (let n = 1; n <= DELTA_WINDOW; n += 1) denominator += 2 * n * n

  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let c = 0; c < coefficients; c += 1) {
      let sum = 0
      for (let n = 1; n <= DELTA_WINDOW; n += 1) {
        const ahead = Math.min(frameCount - 1, frame + n)
        const behind = Math.max(0, frame - n)
        sum +=
          n * ((mfcc[ahead * coefficients + c] ?? 0) - (mfcc[behind * coefficients + c] ?? 0))
      }
      deltas[frame * coefficients + c] = sum / denominator
    }
  }

  return deltas
}

/** Intercala MFCC e deltas em um vetor de `FEATURE_DIM` por quadro. */
export function combineFeatures(
  mfcc: Float32Array,
  deltas: Float32Array,
  frameCount: number,
  coefficients = MFCC_COUNT,
): Float32Array {
  const combined = new Float32Array(frameCount * FEATURE_DIM)
  for (let frame = 0; frame < frameCount; frame += 1) {
    const target = frame * FEATURE_DIM
    const source = frame * coefficients
    for (let c = 0; c < coefficients; c += 1) {
      combined[target + c] = mfcc[source + c] ?? 0
      combined[target + coefficients + c] = deltas[source + c] ?? 0
    }
  }
  return combined
}

/**
 * CMVN — Cepstral Mean and Variance Normalization.
 *
 * Esta é a peça que torna a comparação justa entre duas pessoas em dois
 * equipamentos diferentes. A média cepstral aproxima a resposta de frequência
 * do canal (microfone + sala): subtraí-la remove o equipamento. Dividir pelo
 * desvio remove o resto da diferença de nível.
 *
 * Calculada SOMENTE sobre quadros de fala. Incluir silêncio enviesaria a média
 * na direção do ruído de fundo, e o resultado passaria a depender de quanto
 * silêncio cada gravação tem — que não é nada que devesse afetar o score.
 *
 * Modifica `features` no lugar.
 */
export function applyCmvn(
  features: Float32Array,
  frameCount: number,
  speech: Uint8Array,
  dimension = FEATURE_DIM,
): void {
  if (speech.length !== frameCount) {
    throw new Error('applyCmvn: máscara de fala precisa ter um valor por quadro')
  }

  let speechFrames = 0
  for (let frame = 0; frame < frameCount; frame += 1) if (speech[frame] === 1) speechFrames += 1

  // Sem fala suficiente para estimar estatísticas, normalizar seria inventar
  // uma referência. Deixamos os coeficientes crus; as métricas que dependem
  // deles ficarão marcadas como indisponíveis mais adiante.
  if (speechFrames < 5) return

  const mean = new Float64Array(dimension)
  for (let frame = 0; frame < frameCount; frame += 1) {
    if (speech[frame] !== 1) continue
    const offset = frame * dimension
    for (let d = 0; d < dimension; d += 1) mean[d] = (mean[d] ?? 0) + (features[offset + d] ?? 0)
  }
  for (let d = 0; d < dimension; d += 1) mean[d] = (mean[d] ?? 0) / speechFrames

  const variance = new Float64Array(dimension)
  for (let frame = 0; frame < frameCount; frame += 1) {
    if (speech[frame] !== 1) continue
    const offset = frame * dimension
    for (let d = 0; d < dimension; d += 1) {
      const centered = (features[offset + d] ?? 0) - (mean[d] ?? 0)
      variance[d] = (variance[d] ?? 0) + centered * centered
    }
  }

  const inverseStd = new Float64Array(dimension)
  for (let d = 0; d < dimension; d += 1) {
    inverseStd[d] = 1 / Math.max(Math.sqrt((variance[d] ?? 0) / speechFrames), 1e-6)
  }

  for (let frame = 0; frame < frameCount; frame += 1) {
    const offset = frame * dimension
    for (let d = 0; d < dimension; d += 1) {
      features[offset + d] = ((features[offset + d] ?? 0) - (mean[d] ?? 0)) * (inverseStd[d] ?? 1)
    }
  }
}
