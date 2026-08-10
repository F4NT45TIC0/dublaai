import { HOP_MS, MFCC_COUNT } from './constants'
import type { FeatureSet } from './features'
import { percentile } from './energy'

/**
 * Estimativa de quantas vozes falam numa cena.
 *
 * ATENÇÃO À INVERSÃO. O pipeline de score remove identidade vocal de propósito:
 * a CMVN tira microfone e sala, o coeficiente C0 é descartado por ser volume, e
 * o F0 vira cents relativos à mediana do PRÓPRIO falante. Tudo isso existe para
 * que a nota meça a dublagem e não as cordas vocais de quem dubla.
 *
 * Diarização precisa exatamente do contrário: preservar timbre e altura
 * absoluta. Por isso os vetores daqui NÃO são os do score — são construídos do
 * zero a partir do mesmo `FeatureSet`, usando o F0 em Hz e a forma espectral
 * sem normalização por falante.
 *
 * Isto é ESTIMATIVA, não verdade. Vozes parecidas, música de fundo e falas
 * sobrepostas quebram o método. Quem chama precisa expor a confiança e deixar
 * a pessoa corrigir (§12).
 */

/** Regiões mais curtas que isto não têm estatística suficiente para agrupar. */
const MIN_REGION_MS = 400
const MAX_SPEAKERS = 4
/** Abaixo desta silhueta, afirmar mais de uma voz seria inventar. */
const MIN_SILHOUETTE = 0.35
const KMEANS_ITERATIONS = 25
/** Um k maior só é aceito se separar sensivelmente melhor que o anterior. */
const SILHOUETTE_IMPROVEMENT = 0.08
/** Menos trechos que isto por voz é ajuste ao ruído, não detecção. */
const MIN_REGIONS_PER_SPEAKER = 3

/**
 * Separação mínima de registro entre duas vozes, em semitons.
 *
 * Três semitons é aproximadamente onde uma pessoa comum ainda distingue dois
 * falantes só pela altura. Abaixo disso, o que o agrupamento encontra é
 * variação da MESMA voz — e inventar um personagem quebraria o multiplayer.
 *
 * Este limiar é físico, não estatístico, de propósito: a padronização por
 * z-score amplifica qualquer variação existente, por menor que seja, e
 * separaria 130 Hz de 138 Hz com a mesma confiança que separa 110 de 240.
 */
const MIN_F0_SEPARATION_SEMITONES = 3

/**
 * Pesos aplicados DEPOIS da padronização.
 *
 * O registro vocal domina porque é o único indício de identidade confiável
 * sem um modelo treinado. Os MFCC entram fraco e apenas nos coeficientes
 * baixos: eles carregam a inclinação espectral (qualidade de voz), enquanto os
 * altos carregam qual vogal foi dita. Dar peso alto a eles faria os
 * agrupamentos seguirem a FRASE em vez do FALANTE — que foi exatamente o que
 * a primeira versão deste arquivo fez.
 */
const F0_MEDIAN_WEIGHT = 3
const F0_SPREAD_WEIGHT = 1
const MFCC_WEIGHT = 0.35
/** Só os coeficientes baixos entram. */
const MFCC_USED = 4

export interface SpeakerRegion {
  readonly startFrame: number
  readonly endFrame: number
  readonly startMs: number
  readonly endMs: number
  /** Índice do agrupamento, 0-based. */
  readonly cluster: number
}

export interface SpeakerEstimate {
  readonly speakerCount: number
  /** 0..1 — o quanto os agrupamentos realmente se separam. */
  readonly confidence: number
  readonly regions: readonly SpeakerRegion[]
  /** Motivo declarado quando a estimativa é fraca. */
  readonly reason?: string
}

/**
 * Congruencial linear semeado.
 *
 * `Math.random` é proibido neste pacote por lint, e com razão: o mesmo vídeo
 * precisa produzir sempre a mesma contagem de personagens. Uma detecção que
 * muda entre execuções tornaria o multiplayer não reproduzível.
 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

/** Hz → semitons acima de 100 Hz, que é a escala em que altura se compara. */
function toSemitones(hz: number): number {
  return 12 * Math.log2(hz / 100)
}

/**
 * Estatísticas de identidade de uma região.
 *
 * Composto por:
 *  - mediana do F0 em semitons absolutos (o registro da voz)
 *  - dispersão do F0 (o quanto a pessoa varia a altura)
 *  - média dos MFCC baixos, crus (inclinação espectral, que a CMVN removeria)
 */
function buildIdentityStats(
  features: FeatureSet,
  startFrame: number,
  endFrame: number,
  medianF0Hz: number,
): { raw: Float64Array; medianSemitones: number } | null {
  const raw = new Float64Array(MFCC_USED + 2)
  const voicedF0: number[] = []
  let frames = 0

  for (let frame = startFrame; frame < endFrame; frame += 1) {
    const offset = frame * (MFCC_COUNT * 2)
    for (let coefficient = 0; coefficient < MFCC_USED; coefficient += 1) {
      raw[coefficient + 2] =
        (raw[coefficient + 2] ?? 0) + (features.features[offset + coefficient] ?? 0)
    }
    frames += 1

    // `f0Cents` está em cents relativos à mediana global do arquivo; desfazemos
    // a normalização para recuperar o Hz absoluto, que é o que distingue vozes.
    const cents = features.f0Cents[frame] ?? Number.NaN
    if (Number.isFinite(cents) && medianF0Hz > 0) {
      voicedF0.push(medianF0Hz * 2 ** (cents / 1200))
    }
  }

  if (frames === 0) return null
  for (let coefficient = 0; coefficient < MFCC_USED; coefficient += 1) {
    raw[coefficient + 2] = (raw[coefficient + 2] ?? 0) / frames
  }

  // Sem trecho sonoro não há registro vocal para comparar — e MFCC sozinho
  // separa mal duas pessoas gravadas no mesmo microfone.
  if (voicedF0.length < 5) return null

  const medianSemitones = toSemitones(percentile(voicedF0, 0.5))
  raw[0] = medianSemitones
  raw[1] = toSemitones(percentile(voicedF0, 0.9)) - toSemitones(percentile(voicedF0, 0.1))

  return { raw, medianSemitones }
}

/** Aplica os pesos depois da padronização, para que eles não sejam anulados. */
function applyWeights(vectors: readonly Float64Array[]): Float64Array[] {
  return vectors.map((vector) => {
    const weighted = Float64Array.from(vector)
    weighted[0] = (weighted[0] ?? 0) * F0_MEDIAN_WEIGHT
    weighted[1] = (weighted[1] ?? 0) * F0_SPREAD_WEIGHT
    for (let d = 2; d < weighted.length; d += 1) {
      weighted[d] = (weighted[d] ?? 0) * MFCC_WEIGHT
    }
    return weighted
  })
}

/** Normaliza cada dimensão pelo desvio global, para nenhuma dominar a distância. */
function standardize(vectors: readonly Float64Array[]): Float64Array[] {
  const first = vectors[0]
  if (!first) return []
  const dimension = first.length

  const mean = new Float64Array(dimension)
  for (const vector of vectors) {
    for (let d = 0; d < dimension; d += 1) mean[d] = (mean[d] ?? 0) + (vector[d] ?? 0)
  }
  for (let d = 0; d < dimension; d += 1) mean[d] = (mean[d] ?? 0) / vectors.length

  const deviation = new Float64Array(dimension)
  for (const vector of vectors) {
    for (let d = 0; d < dimension; d += 1) {
      const centered = (vector[d] ?? 0) - (mean[d] ?? 0)
      deviation[d] = (deviation[d] ?? 0) + centered * centered
    }
  }
  for (let d = 0; d < dimension; d += 1) {
    deviation[d] = Math.sqrt((deviation[d] ?? 0) / vectors.length) || 1
  }

  return vectors.map((vector) => {
    const scaled = new Float64Array(dimension)
    for (let d = 0; d < dimension; d += 1) {
      scaled[d] = ((vector[d] ?? 0) - (mean[d] ?? 0)) / (deviation[d] ?? 1)
    }
    return scaled
  })
}

function distance(a: Float64Array, b: Float64Array): number {
  let sum = 0
  for (let d = 0; d < a.length; d += 1) {
    const delta = (a[d] ?? 0) - (b[d] ?? 0)
    sum += delta * delta
  }
  return Math.sqrt(sum)
}

/** k-means com inicialização k-means++ determinística. */
function kmeans(vectors: readonly Float64Array[], k: number, seed: number): number[] {
  const random = createRandom(seed)
  const first = vectors[0]
  if (!first) return []

  const centroids: Float64Array[] = []
  const firstIndex = Math.floor(random() * vectors.length)
  centroids.push(Float64Array.from(vectors[firstIndex] ?? first))

  while (centroids.length < k) {
    const distances = vectors.map((vector) =>
      Math.min(...centroids.map((centroid) => distance(vector, centroid))) ** 2,
    )
    const total = distances.reduce((sum, value) => sum + value, 0)
    if (total <= 0) break

    let target = random() * total
    let chosen = vectors.length - 1
    for (let index = 0; index < distances.length; index += 1) {
      target -= distances[index] ?? 0
      if (target <= 0) {
        chosen = index
        break
      }
    }
    centroids.push(Float64Array.from(vectors[chosen] ?? first))
  }

  const assignments = new Array<number>(vectors.length).fill(0)

  for (let iteration = 0; iteration < KMEANS_ITERATIONS; iteration += 1) {
    // Objeto e não `let`: a atribuição acontece dentro de um closure, e o
    // compilador estreitaria a variável como sempre falsa.
    const state = { changed: false }

    vectors.forEach((vector, index) => {
      let best = 0
      let bestDistance = Number.POSITIVE_INFINITY
      centroids.forEach((centroid, cluster) => {
        const value = distance(vector, centroid)
        if (value < bestDistance) {
          bestDistance = value
          best = cluster
        }
      })
      if (assignments[index] !== best) {
        assignments[index] = best
        state.changed = true
      }
    })

    for (let cluster = 0; cluster < centroids.length; cluster += 1) {
      const members = vectors.filter((_, index) => assignments[index] === cluster)
      if (members.length === 0) continue
      const centroid = new Float64Array(first.length)
      for (const member of members) {
        for (let d = 0; d < centroid.length; d += 1) {
          centroid[d] = (centroid[d] ?? 0) + (member[d] ?? 0)
        }
      }
      for (let d = 0; d < centroid.length; d += 1) {
        centroid[d] = (centroid[d] ?? 0) / members.length
      }
      centroids[cluster] = centroid
    }

    if (!state.changed) break
  }

  return assignments
}

/**
 * Silhueta média: o quanto cada ponto está mais perto do próprio grupo do que
 * do grupo vizinho. É o critério que decide se vale afirmar k > 1.
 */
function silhouette(vectors: readonly Float64Array[], assignments: readonly number[]): number {
  const clusters = new Set(assignments)
  if (clusters.size < 2) return 0

  let total = 0
  let counted = 0

  vectors.forEach((vector, index) => {
    const own = assignments[index] ?? 0
    const byCluster = new Map<number, number[]>()

    vectors.forEach((other, otherIndex) => {
      if (otherIndex === index) return
      const cluster = assignments[otherIndex] ?? 0
      const list = byCluster.get(cluster) ?? []
      list.push(distance(vector, other))
      byCluster.set(cluster, list)
    })

    const mean = (values: number[] | undefined) =>
      values && values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : null

    const cohesion = mean(byCluster.get(own))
    let separation = Number.POSITIVE_INFINITY
    for (const [cluster, values] of byCluster) {
      if (cluster === own) continue
      const value = mean(values)
      if (value !== null && value < separation) separation = value
    }

    if (cohesion === null || !Number.isFinite(separation)) return
    const score = (separation - cohesion) / Math.max(cohesion, separation)
    if (Number.isFinite(score)) {
      total += score
      counted += 1
    }
  })

  return counted === 0 ? 0 : total / counted
}

export function estimateSpeakerCount(
  features: FeatureSet,
  options: { readonly seed?: number } = {},
): SpeakerEstimate {
  const seed = options.seed ?? 20_260_809
  const minFrames = Math.round(MIN_REGION_MS / HOP_MS)

  const usable = features.regions.filter((region) => region.endFrame - region.startFrame >= minFrames)

  const vectors: Float64Array[] = []
  const semitones: number[] = []
  const kept: typeof usable = []

  for (const region of usable) {
    const stats = buildIdentityStats(
      features,
      region.startFrame,
      region.endFrame,
      features.medianF0Hz,
    )
    if (!stats) continue
    vectors.push(stats.raw)
    semitones.push(stats.medianSemitones)
    kept.push(region)
  }

  const toRegions = (assignments: readonly number[]): SpeakerRegion[] =>
    kept.map((region, index) => ({
      startFrame: region.startFrame,
      endFrame: region.endFrame,
      startMs: region.startFrame * HOP_MS,
      endMs: region.endFrame * HOP_MS,
      cluster: assignments[index] ?? 0,
    }))

  // Menos de quatro trechos aproveitáveis não sustentam nenhuma afirmação
  // sobre número de vozes.
  if (vectors.length < 4) {
    return {
      speakerCount: 1,
      confidence: 0.2,
      regions: toRegions(new Array<number>(vectors.length).fill(0)),
      reason: 'poucos trechos de fala para distinguir vozes',
    }
  }

  const weighted = applyWeights(standardize(vectors))

  // Nunca mais grupos do que trechos sustentam. Com 6 falas, tentar 4 vozes é
  // ajustar ao ruído.
  const maxK = Math.min(MAX_SPEAKERS, Math.floor(vectors.length / MIN_REGIONS_PER_SPEAKER))

  let bestK = 1
  let bestScore = 0
  let bestAssignments = new Array<number>(vectors.length).fill(0)

  // k crescente e com exigência de melhora: em caso de empate técnico, a
  // explicação mais simples (menos vozes) vence.
  for (let k = 2; k <= maxK; k += 1) {
    const assignments = kmeans(weighted, k, seed + k)
    if (new Set(assignments).size < k) continue
    const score = silhouette(weighted, assignments)
    if (score > bestScore + (bestK > 1 ? SILHOUETTE_IMPROVEMENT : 0)) {
      bestScore = score
      bestK = k
      bestAssignments = assignments
    }
  }

  const weakSeparation = bestScore < MIN_SILHOUETTE
  const closestSemitones =
    bestK > 1 ? minimumCentroidSeparation(semitones, bestAssignments, bestK) : Number.POSITIVE_INFINITY
  const tooClose = closestSemitones < MIN_F0_SEPARATION_SEMITONES

  if (bestK === 1 || weakSeparation || tooClose) {
    return {
      speakerCount: 1,
      confidence: Math.max(0.2, Math.min(0.6, 1 - bestScore)),
      regions: toRegions(new Array<number>(vectors.length).fill(0)),
      reason: tooClose
        ? 'as vozes desta cena têm registros parecidos demais para separar com segurança'
        : bestK > 1
          ? 'os trechos de fala não se separam o bastante para afirmar mais de uma voz'
          : 'não encontramos vozes distintas',
    }
  }

  return {
    speakerCount: bestK,
    // A silhueta vai de 0 a 1; mapeamos a faixa útil para uma confiança que
    // não chega a 1 — nenhuma estimativa dessas merece certeza total.
    confidence: Math.min(0.9, bestScore),
    regions: toRegions(bestAssignments),
  }
}

/**
 * Menor distância, em semitons, entre os registros médios de dois grupos.
 *
 * É o guarda que impede a padronização de transformar 130 Hz e 138 Hz em duas
 * pessoas: estatisticamente elas se separam, fisicamente são a mesma voz.
 */
function minimumCentroidSeparation(
  semitones: readonly number[],
  assignments: readonly number[],
  clusterCount: number,
): number {
  const means: number[] = []

  for (let cluster = 0; cluster < clusterCount; cluster += 1) {
    let sum = 0
    let count = 0
    assignments.forEach((assignment, index) => {
      if (assignment !== cluster) return
      sum += semitones[index] ?? 0
      count += 1
    })
    means.push(count > 0 ? sum / count : 0)
  }

  let minimum = Number.POSITIVE_INFINITY
  for (let a = 0; a < means.length; a += 1) {
    for (let b = a + 1; b < means.length; b += 1) {
      minimum = Math.min(minimum, Math.abs((means[a] ?? 0) - (means[b] ?? 0)))
    }
  }
  return minimum
}
