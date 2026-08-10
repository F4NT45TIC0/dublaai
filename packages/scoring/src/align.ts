import { FEATURE_DIM, HOP_MS, type FeatureSet } from '@dubla/dsp'

/**
 * Reposiciona o `FeatureSet` do usuário na grade de tempo do vídeo.
 *
 * A gravação começa em algum ponto da timeline do vídeo — `mediaStartOffsetMs`,
 * medido pelo MediaClock. Sem esta transformação, o quadro 0 do usuário seria
 * comparado ao quadro 0 da referência, e todo o score mediria um desalinhamento
 * que a arquitetura já sabe compensar.
 *
 * Depois desta função, índice de quadro significa a MESMA coisa dos dois lados:
 * tempo do vídeo. Todo o resto do motor trabalha nesse sistema.
 */
export function shiftToVideoGrid(
  user: FeatureSet,
  startOffsetMs: number,
  targetFrames: number,
): FeatureSet {
  const shift = Math.round(startOffsetMs / HOP_MS)
  return shiftFrames(user, shift, targetFrames)
}

/**
 * Desloca por `shift` quadros, recortando ou preenchendo para `targetFrames`.
 *
 * O preenchimento usa zeros nas features e o piso de ruído no RMS, porque
 * "não gravado" precisa se comportar como silêncio — e não como um valor
 * arbitrário que o VAD interpretaria como fala.
 */
export function shiftFrames(
  source: FeatureSet,
  shift: number,
  targetFrames: number,
): FeatureSet {
  const features = new Float32Array(targetFrames * FEATURE_DIM)
  const f0Cents = new Float32Array(targetFrames).fill(Number.NaN)
  const voicing = new Float32Array(targetFrames)
  const rmsDb = new Float32Array(targetFrames).fill(source.noiseFloorDb)
  const speech = new Uint8Array(targetFrames)
  const activity = new Float32Array(targetFrames)

  let speechFrames = 0

  for (let target = 0; target < targetFrames; target += 1) {
    const origin = target - shift
    if (origin < 0 || origin >= source.frameCount) continue

    features.set(
      source.features.subarray(origin * FEATURE_DIM, (origin + 1) * FEATURE_DIM),
      target * FEATURE_DIM,
    )
    f0Cents[target] = source.f0Cents[origin] ?? Number.NaN
    voicing[target] = source.voicing[origin] ?? 0
    rmsDb[target] = source.rmsDb[origin] ?? source.noiseFloorDb
    activity[target] = source.activity[origin] ?? 0
    const isSpeech = source.speech[origin] === 1 ? 1 : 0
    speech[target] = isSpeech
    speechFrames += isSpeech
  }

  return {
    ...source,
    frameCount: targetFrames,
    features,
    f0Cents,
    voicing,
    rmsDb,
    speech,
    activity,
    regions: regionsFrom(speech),
    speechRatio: targetFrames === 0 ? 0 : speechFrames / targetFrames,
  }
}

/**
 * Recorta o `FeatureSet` para a janela `[startFrame, endFrame)`.
 *
 * Existe por causa do modo fala-a-fala. Ao gravar um segmento só, o resto da
 * timeline do usuário é silêncio — e o DTW, que roda sobre a referência
 * inteira, passaria a alinhar fala contra silêncio. A distância de articulação
 * viraria lixo e `estimateGlobalOffset` calcularia o atraso sobre um envelope
 * quase vazio. O resultado seriam números plausíveis e errados, que é
 * exatamente o que o §12 proíbe.
 *
 * Recortando os DOIS lados para a mesma janela, todo o pipeline existente
 * continua valendo sem nenhuma outra mudança.
 */
export function cropFeatureSet(
  source: FeatureSet,
  startFrame: number,
  endFrame: number,
): FeatureSet {
  const from = Math.max(0, Math.min(startFrame, source.frameCount))
  const to = Math.max(from, Math.min(endFrame, source.frameCount))
  const frameCount = to - from

  const features = source.features.slice(from * FEATURE_DIM, to * FEATURE_DIM)
  const f0Cents = source.f0Cents.slice(from, to)
  const voicing = source.voicing.slice(from, to)
  const rmsDb = source.rmsDb.slice(from, to)
  const speech = source.speech.slice(from, to)
  const activity = source.activity.slice(from, to)

  let speechFrames = 0
  for (const flag of speech) {
    if (flag === 1) speechFrames += 1
  }

  return {
    ...source,
    frameCount,
    features,
    f0Cents,
    voicing,
    rmsDb,
    speech,
    activity,
    regions: regionsFrom(speech),
    speechRatio: frameCount === 0 ? 0 : speechFrames / frameCount,
  }
}

/** Quantos quadros de fala a referência tem dentro da janela já recortada. */
export function countSpeechFrames(features: FeatureSet): number {
  let total = 0
  for (let frame = 0; frame < features.frameCount; frame += 1) {
    if (features.speech[frame] === 1) total += 1
  }
  return total
}

function regionsFrom(speech: Uint8Array): { startFrame: number; endFrame: number }[] {
  const regions: { startFrame: number; endFrame: number }[] = []
  let start = -1
  for (let frame = 0; frame < speech.length; frame += 1) {
    if (speech[frame] === 1 && start === -1) start = frame
    else if (speech[frame] !== 1 && start !== -1) {
      regions.push({ startFrame: start, endFrame: frame })
      start = -1
    }
  }
  if (start !== -1) regions.push({ startFrame: start, endFrame: speech.length })
  return regions
}

/**
 * Projeta uma série do usuário sobre a grade da referência usando o caminho DTW.
 *
 * É isto que permite comparar entonação e energia mesmo quando o usuário falou
 * mais rápido ou mais devagar: o DTW já resolveu o "quando", então a correlação
 * mede só o "como".
 */
export function projectByAlignment(
  values: Float32Array,
  alignment: Int32Array,
): Float32Array {
  const projected = new Float32Array(alignment.length)
  for (let frame = 0; frame < alignment.length; frame += 1) {
    const source = alignment[frame]
    projected[frame] =
      source !== undefined && source >= 0 && source < values.length
        ? (values[source] ?? Number.NaN)
        : Number.NaN
  }
  return projected
}
