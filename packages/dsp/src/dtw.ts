import { DTW_BAND_FRAMES, FEATURE_DIM } from './constants'

export interface DtwResult {
  /** Custo médio por passo do caminho inteiro, em 0..2 (distância de cosseno). */
  readonly distance: number
  /**
   * Custo médio restrito aos passos em que a referência tem fala.
   *
   * É este o número que a articulação usa. O `distance` global é dominado
   * pelo silêncio: numa cena de 5,6 s com 1,4 s de fala, três quartos dos
   * passos comparam silêncio com silêncio — custo quase zero dos dois lados,
   * independentemente do que a pessoa falou. Usar o global faria `dChance`
   * colapsar sobre `dFloor` e a métrica perderia qualquer poder de separação.
   */
  readonly speechDistance: number
  /** Quadro do usuário representativo para cada quadro de referência. */
  readonly alignment: Int32Array
  /** Inclinação local dj/di em cada quadro de referência. 1 = mesmo andamento. */
  readonly slope: Float32Array
  readonly pathLength: number
}

const STEP_DIAGONAL = 0
const STEP_UP = 1
const STEP_LEFT = 2

/** Norma L2 por quadro, pré-calculada para a distância de cosseno. */
function computeNorms(features: Float32Array, frameCount: number, dim: number): Float64Array {
  const norms = new Float64Array(frameCount)
  for (let frame = 0; frame < frameCount; frame += 1) {
    const offset = frame * dim
    let sum = 0
    for (let d = 0; d < dim; d += 1) {
      const value = features[offset + d] ?? 0
      sum += value * value
    }
    norms[frame] = Math.sqrt(sum)
  }
  return norms
}

function emptyResult(referenceFrames: number): DtwResult {
  const frames = Math.max(0, referenceFrames)
  return {
    distance: 2,
    speechDistance: 2,
    alignment: new Int32Array(frames),
    slope: new Float32Array(frames),
    pathLength: 0,
  }
}

/**
 * DTW com banda de Sakoe-Chiba.
 *
 * A banda serve a dois propósitos. O óbvio é custo: sem ela seriam N×M células
 * (5 milhões para duas cenas de 45 s). O importante é correção — sem restrição,
 * o DTW pode alinhar o começo da referência ao fim da gravação e devolver uma
 * distância baixíssima para duas falas que não têm nada a ver. A banda impõe o
 * limite de variação humana plausível (±1,5 s) e impede esse alinhamento
 * absurdo.
 *
 * Distância local: cosseno sobre os vetores já normalizados por CMVN. Cosseno e
 * não euclidiana porque ele ignora o ganho residual que a CMVN não removeu.
 */
export function dtwAlign(
  reference: Float32Array,
  referenceFrames: number,
  user: Float32Array,
  userFrames: number,
  options: {
    /** Quadros de referência que contam para `speechDistance`. */
    readonly referenceMask?: Uint8Array
    readonly dimension?: number
    readonly band?: number
  } = {},
): DtwResult {
  const dimension = options.dimension ?? FEATURE_DIM
  const band = options.band ?? DTW_BAND_FRAMES
  const referenceMask = options.referenceMask
  if (referenceFrames <= 0 || userFrames <= 0) return emptyResult(referenceFrames)
  if (reference.length < referenceFrames * dimension || user.length < userFrames * dimension) {
    throw new Error('dtwAlign: buffers menores que a contagem de quadros informada')
  }

  // A banda precisa acomodar a diferença de comprimento, senão o canto final
  // fica fora dela e o caminho não existe.
  const lengthDelta = Math.abs(referenceFrames - userFrames)
  const effectiveBand = Math.min(Math.max(referenceFrames, userFrames), band + lengthDelta)
  const bandWidth = 2 * effectiveBand + 1

  const referenceNorms = computeNorms(reference, referenceFrames, dimension)
  const userNorms = computeNorms(user, userFrames, dimension)

  const cost = new Float64Array(referenceFrames * bandWidth).fill(Number.POSITIVE_INFINITY)
  const steps = new Uint8Array(referenceFrames * bandWidth)

  const localDistance = (i: number, j: number): number => {
    const a = i * dimension
    const b = j * dimension
    let dot = 0
    for (let d = 0; d < dimension; d += 1) {
      dot += (reference[a + d] ?? 0) * (user[b + d] ?? 0)
    }
    const denominator = (referenceNorms[i] ?? 0) * (userNorms[j] ?? 0)
    // Quadro sem energia em nenhuma dimensão: trata como distância neutra em
    // vez de dividir por zero.
    if (denominator < 1e-9) return 1

    // O `max(0, …)` não é paranoia defensiva: para vetores idênticos,
    // `dot/denominator` sai levemente acima de 1 por arredondamento, e a
    // distância vira um número negativo da ordem de 1e-17. Com custo de passo
    // negativo, CADA passo extra barateia o caminho — o DTW passa a preferir
    // caminhos longos e tortos em vez da diagonal, seguindo ruído de ponto
    // flutuante. O sintoma aparecia como andamento errado em uma gravação
    // idêntica à referência.
    return Math.max(0, 1 - dot / denominator)
  }

  for (let i = 0; i < referenceFrames; i += 1) {
    const jLow = Math.max(0, i - effectiveBand)
    const jHigh = Math.min(userFrames - 1, i + effectiveBand)
    const rowOffset = i * bandWidth
    const previousRowOffset = (i - 1) * bandWidth

    for (let j = jLow; j <= jHigh; j += 1) {
      const k = j - i + effectiveBand
      const distance = localDistance(i, j)

      if (i === 0 && j === 0) {
        cost[rowOffset + k] = distance
        steps[rowOffset + k] = STEP_DIAGONAL
        continue
      }

      // A diagonal é avaliada primeiro e os concorrentes usam `<` estrito:
      // em empate — comum quando os dois lados são muito parecidos — o passo
      // diagonal vence, que é a interpretação correta de "mesmo andamento".
      let best = Number.POSITIVE_INFINITY
      let bestStep = STEP_DIAGONAL

      if (i > 0 && j > 0) {
        const candidate = cost[previousRowOffset + k] ?? Number.POSITIVE_INFINITY
        if (candidate < best) {
          best = candidate
          bestStep = STEP_DIAGONAL
        }
      }
      if (i > 0 && k + 1 < bandWidth) {
        const candidate = cost[previousRowOffset + k + 1] ?? Number.POSITIVE_INFINITY
        if (candidate < best) {
          best = candidate
          bestStep = STEP_UP
        }
      }
      if (j > 0 && k - 1 >= 0) {
        const candidate = cost[rowOffset + k - 1] ?? Number.POSITIVE_INFINITY
        if (candidate < best) {
          best = candidate
          bestStep = STEP_LEFT
        }
      }

      cost[rowOffset + k] = best + distance
      steps[rowOffset + k] = bestStep
    }
  }

  const endK = userFrames - 1 - (referenceFrames - 1) + effectiveBand
  const totalCost =
    endK >= 0 && endK < bandWidth
      ? (cost[(referenceFrames - 1) * bandWidth + endK] ?? Number.POSITIVE_INFINITY)
      : Number.POSITIVE_INFINITY

  // Nenhum caminho dentro da banda: as durações são incompatíveis demais.
  if (!Number.isFinite(totalCost)) return emptyResult(referenceFrames)

  // Backtracking, acumulando a soma dos j por i para tirar a média depois.
  const jSum = new Float64Array(referenceFrames)
  const jCount = new Int32Array(referenceFrames)
  let i = referenceFrames - 1
  let j = userFrames - 1
  let pathLength = 0
  let speechCost = 0
  let speechSteps = 0

  while (i >= 0 && j >= 0) {
    jSum[i] = (jSum[i] ?? 0) + j
    jCount[i] = (jCount[i] ?? 0) + 1
    pathLength += 1

    if (!referenceMask || referenceMask[i] === 1) {
      speechCost += localDistance(i, j)
      speechSteps += 1
    }

    if (i === 0 && j === 0) break

    const k = j - i + effectiveBand
    const step = steps[i * bandWidth + k] ?? STEP_DIAGONAL
    if (step === STEP_DIAGONAL) {
      i -= 1
      j -= 1
    } else if (step === STEP_UP) {
      i -= 1
    } else {
      j -= 1
    }
  }

  const alignment = new Int32Array(referenceFrames)
  for (let frame = 0; frame < referenceFrames; frame += 1) {
    const count = jCount[frame] ?? 0
    alignment[frame] = count > 0 ? Math.round((jSum[frame] ?? 0) / count) : -1
  }
  // Quadros fora do caminho (impossível com este padrão de passos, mas o
  // preenchimento evita -1 propagando para o cálculo de ritmo).
  let lastKnown = 0
  for (let frame = 0; frame < referenceFrames; frame += 1) {
    const value = alignment[frame] ?? -1
    if (value < 0) alignment[frame] = lastKnown
    else lastKnown = value
  }

  const distance = totalCost / pathLength

  return {
    distance,
    speechDistance: speechSteps === 0 ? distance : speechCost / speechSteps,
    alignment,
    slope: computeSlope(alignment),
    pathLength,
  }
}

/**
 * Janela da inclinação: ±240 ms.
 *
 * Havia 25 quadros (±500 ms) aqui, e era largo demais. Falas de cena duram
 * cerca de 900 ms; uma janela de meio segundo para cada lado atravessa a fala
 * inteira e entra no silêncio vizinho, onde o caminho é diagonal. O resultado
 * era uma inclinação puxada de volta para 1 — alguém falando 40% mais rápido
 * aparecia como andamento quase correto.
 *
 * Abaixo de ~10 quadros o efeito inverso aparece: o caminho anda em passos
 * inteiros e a inclinação vira ruído de quantização.
 */
const SLOPE_WINDOW = 12

/**
 * Inclinação local do caminho: quantos quadros do usuário passam por quadro de
 * referência. `> 1` = arrastou, `< 1` = correu.
 *
 * Janela de 500 ms porque abaixo disso a inclinação vira ruído de quantização —
 * o caminho anda em passos inteiros, então em janelas curtas ele oscila entre
 * 0 e 2 sem que o usuário tenha mudado de andamento.
 */
function computeSlope(alignment: Int32Array): Float32Array {
  const frames = alignment.length
  const slope = new Float32Array(frames)
  if (frames === 0) return slope

  for (let frame = 0; frame < frames; frame += 1) {
    const low = Math.max(0, frame - SLOPE_WINDOW)
    const high = Math.min(frames - 1, frame + SLOPE_WINDOW)
    const spanReference = high - low
    if (spanReference <= 0) {
      slope[frame] = 1
      continue
    }
    const spanUser = (alignment[high] ?? 0) - (alignment[low] ?? 0)
    slope[frame] = spanUser <= 0 ? 0 : spanUser / spanReference
  }

  return slope
}
