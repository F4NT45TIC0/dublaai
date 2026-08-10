import { ANALYSIS_SAMPLE_RATE, DB_FLOOR, FEATURE_DIM, HOP_MS } from './constants'
import { activityEnvelope, type SpeechRegion } from './vad'
import type { FeatureSet } from './features'

/**
 * Codec do arquivo `reference.features.bin` (docs/MEDIA_PIPELINE.md §4).
 *
 * Binário e não JSON porque a diferença é grande: as mesmas features em JSON
 * passariam de 1 MB por cena, e elas são baixadas em toda tentativa de
 * dublagem. Aqui ficam em torno de 50 KB.
 *
 * Quantização em int8 introduz erro na referência que não existe nas features
 * do usuário (Float32). A assimetria é absorvida pela calibração: as âncoras
 * `dFloor`/`dChance` são calculadas contra a referência JÁ quantizada, então
 * a régua e o que se mede estão no mesmo domínio.
 */

const MAGIC = 0x44414631 // "DAF1"
const VERSION = 1
const HEADER_BYTES = 40
const FRAME_BYTES = FEATURE_DIM + 5
const FEATURE_SCALE = 16
const F0_UNVOICED = -32_768

/** Teto defensivo: um `frameCount` corrompido não pode virar alocação absurda. */
const MAX_FRAMES = 60 * 50 * 2

export interface ReferenceAnchors {
  /** Distância da referência contra ela mesma com ruído — o "tão perto quanto dá". */
  readonly dFloor: number
  /** Distância contra fala não relacionada — o "acaso". */
  readonly dChance: number
}

export interface ReferenceFeatures extends FeatureSet {
  readonly anchors: ReferenceAnchors
  readonly peaks: Int8Array
}

export function encodeReferenceFeatures(
  featureSet: FeatureSet,
  anchors: ReferenceAnchors,
  peaks: Int8Array,
): ArrayBuffer {
  const { frameCount } = featureSet
  const peakCount = Math.floor(peaks.length / 2)
  const buffer = new ArrayBuffer(HEADER_BYTES + frameCount * FRAME_BYTES + peakCount * 2)
  const view = new DataView(buffer)

  view.setUint32(0, MAGIC, false)
  view.setUint16(4, VERSION, true)
  view.setUint16(6, FRAME_BYTES, true)
  view.setUint32(8, featureSet.sampleRate, true)
  view.setUint16(12, featureSet.hopMs, true)
  view.setUint16(14, FEATURE_DIM, true)
  view.setUint32(16, frameCount, true)
  view.setFloat32(20, anchors.dFloor, true)
  view.setFloat32(24, anchors.dChance, true)
  view.setFloat32(28, featureSet.medianF0Hz, true)
  view.setFloat32(32, featureSet.noiseFloorDb, true)
  view.setUint32(36, peakCount, true)

  let offset = HEADER_BYTES
  for (let frame = 0; frame < frameCount; frame += 1) {
    const base = frame * FEATURE_DIM
    for (let d = 0; d < FEATURE_DIM; d += 1) {
      view.setInt8(offset + d, quantizeFeature(featureSet.features[base + d] ?? 0))
    }
    offset += FEATURE_DIM

    const cents = featureSet.f0Cents[frame] ?? Number.NaN
    view.setInt16(offset, Number.isFinite(cents) ? clampInt16(Math.round(cents)) : F0_UNVOICED, true)
    offset += 2

    view.setUint8(offset, Math.round(clamp(featureSet.voicing[frame] ?? 0, 0, 1) * 255))
    offset += 1

    view.setInt8(offset, clampInt8(Math.round(featureSet.rmsDb[frame] ?? DB_FLOOR)))
    offset += 1

    view.setUint8(offset, featureSet.speech[frame] === 1 ? 1 : 0)
    offset += 1
  }

  for (let i = 0; i < peakCount * 2; i += 1) {
    view.setInt8(offset + i, peaks[i] ?? 0)
  }

  return buffer
}

export function decodeReferenceFeatures(buffer: ArrayBuffer): ReferenceFeatures {
  // Validação antes de qualquer alocação (docs/SECURITY.md §2).
  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error('features: arquivo menor que o cabeçalho')
  }

  const view = new DataView(buffer)
  if (view.getUint32(0, false) !== MAGIC) {
    throw new Error('features: assinatura inválida')
  }

  const version = view.getUint16(4, true)
  if (version !== VERSION) {
    throw new Error(`features: versão ${String(version)} não suportada`)
  }

  const frameBytes = view.getUint16(6, true)
  const featureDim = view.getUint16(14, true)
  if (frameBytes !== FRAME_BYTES || featureDim !== FEATURE_DIM) {
    throw new Error('features: layout de quadro incompatível com este motor')
  }

  const frameCount = view.getUint32(16, true)
  const peakCount = view.getUint32(36, true)
  if (frameCount > MAX_FRAMES) {
    throw new Error('features: contagem de quadros fora do limite')
  }

  const expectedBytes = HEADER_BYTES + frameCount * FRAME_BYTES + peakCount * 2
  if (buffer.byteLength !== expectedBytes) {
    throw new Error(
      `features: tamanho inconsistente (esperado ${String(expectedBytes)}, recebido ${String(buffer.byteLength)})`,
    )
  }

  const sampleRate = view.getUint32(8, true)
  const hopMs = view.getUint16(12, true)
  const dFloor = view.getFloat32(20, true)
  const dChance = view.getFloat32(24, true)
  const medianF0Hz = view.getFloat32(28, true)
  const noiseFloorDb = view.getFloat32(32, true)

  const features = new Float32Array(frameCount * FEATURE_DIM)
  const f0Cents = new Float32Array(frameCount)
  const voicing = new Float32Array(frameCount)
  const rmsDb = new Float32Array(frameCount)
  const speech = new Uint8Array(frameCount)

  let offset = HEADER_BYTES
  let speechFrames = 0

  for (let frame = 0; frame < frameCount; frame += 1) {
    const base = frame * FEATURE_DIM
    for (let d = 0; d < FEATURE_DIM; d += 1) {
      features[base + d] = view.getInt8(offset + d) / FEATURE_SCALE
    }
    offset += FEATURE_DIM

    const cents = view.getInt16(offset, true)
    f0Cents[frame] = cents === F0_UNVOICED ? Number.NaN : cents
    offset += 2

    voicing[frame] = view.getUint8(offset) / 255
    offset += 1

    rmsDb[frame] = view.getInt8(offset)
    offset += 1

    const isSpeech = view.getUint8(offset)
    speech[frame] = isSpeech
    if (isSpeech === 1) speechFrames += 1
    offset += 1
  }

  const peaks = new Int8Array(peakCount * 2)
  for (let i = 0; i < peaks.length; i += 1) peaks[i] = view.getInt8(offset + i)

  let peakDb = DB_FLOOR
  for (let frame = 0; frame < frameCount; frame += 1) {
    const level = rmsDb[frame] ?? DB_FLOOR
    if (level > peakDb) peakDb = level
  }

  return {
    sampleRate: sampleRate || ANALYSIS_SAMPLE_RATE,
    hopMs: hopMs || HOP_MS,
    frameCount,
    features,
    f0Cents,
    voicing,
    rmsDb,
    speech,
    regions: regionsFromMask(speech),
    medianF0Hz,
    noiseFloorDb,
    peakDb,
    clippedRatio: 0,
    speechRatio: frameCount === 0 ? 0 : speechFrames / frameCount,
    activity: activityEnvelope(rmsDb, noiseFloorDb),
    anchors: { dFloor, dChance },
    peaks,
  }
}

/** Reconstrói as regiões de fala a partir da máscara por quadro. */
export function regionsFromMask(speech: Uint8Array): SpeechRegion[] {
  const regions: SpeechRegion[] = []
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
 * Aplica ao `FeatureSet` do usuário a mesma quantização da referência.
 *
 * Sem isto, o usuário seria medido em Float32 contra uma referência em int8, e
 * uma parte constante da distância viria só do erro de quantização — inflando
 * a distância de todo mundo por igual, mas de forma que as âncoras não
 * descrevem. É barato e mantém os dois lados no mesmo domínio.
 */
export function quantizeFeatureSet(featureSet: FeatureSet): FeatureSet {
  const features = new Float32Array(featureSet.features.length)
  for (let i = 0; i < features.length; i += 1) {
    features[i] = quantizeFeature(featureSet.features[i] ?? 0) / FEATURE_SCALE
  }
  return { ...featureSet, features }
}

function quantizeFeature(value: number): number {
  return clampInt8(Math.round(value * FEATURE_SCALE))
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

function clampInt8(value: number): number {
  return clamp(value, -128, 127)
}

function clampInt16(value: number): number {
  return clamp(value, -32_767, 32_767)
}
