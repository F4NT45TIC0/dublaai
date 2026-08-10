import {
  VAD_MIN_SPEECH_FRAMES,
  VAD_NOISE_PERCENTILE,
  VAD_OFFSET_FRAMES,
  VAD_ONSET_FRAMES,
  VAD_THRESHOLD_DB,
} from './constants'
import { percentile } from './energy'

export interface SpeechRegion {
  readonly startFrame: number
  /** Exclusivo. */
  readonly endFrame: number
}

export interface VadResult {
  readonly speech: Uint8Array
  readonly regions: readonly SpeechRegion[]
  readonly noiseFloorDb: number
  readonly thresholdDb: number
  /** Fração de quadros com fala. */
  readonly speechRatio: number
}

/**
 * Detecção de atividade vocal por energia com piso de ruído adaptativo.
 *
 * O piso vem do percentil 10 da própria gravação, e não de uma constante: um
 * limiar fixo classificaria como fala todo o ruído de um ambiente barulhento, e
 * como silêncio a voz inteira de quem grava baixinho.
 *
 * A histerese é assimétrica de propósito — entrar em fala exige 60 ms, sair
 * exige 160 ms. Simétrica, ela quebraria uma frase em cada plosiva, e o VAD
 * produziria dezenas de falsos onsets que arruinariam a métrica de sincronia.
 */
export function detectSpeech(rmsDb: Float32Array): VadResult {
  const frameCount = rmsDb.length
  const speech = new Uint8Array(frameCount)

  if (frameCount === 0) {
    return { speech, regions: [], noiseFloorDb: 0, thresholdDb: 0, speechRatio: 0 }
  }

  const noiseFloorDb = percentile(rmsDb, VAD_NOISE_PERCENTILE)
  const thresholdDb = noiseFloorDb + VAD_THRESHOLD_DB

  const regions: SpeechRegion[] = []
  let active = false
  let candidateStart = -1
  let aboveRun = 0
  let belowRun = 0
  let regionStart = -1

  for (let frame = 0; frame < frameCount; frame += 1) {
    const isAbove = (rmsDb[frame] ?? Number.NEGATIVE_INFINITY) > thresholdDb

    if (!active) {
      if (isAbove) {
        if (aboveRun === 0) candidateStart = frame
        aboveRun += 1
        if (aboveRun >= VAD_ONSET_FRAMES) {
          active = true
          regionStart = candidateStart
          belowRun = 0
        }
      } else {
        aboveRun = 0
      }
      continue
    }

    if (isAbove) {
      belowRun = 0
    } else {
      belowRun += 1
      if (belowRun >= VAD_OFFSET_FRAMES) {
        const endFrame = frame - belowRun + 1
        if (endFrame - regionStart >= VAD_MIN_SPEECH_FRAMES) {
          regions.push({ startFrame: regionStart, endFrame })
        }
        active = false
        aboveRun = 0
        belowRun = 0
      }
    }
  }

  if (active && frameCount - regionStart >= VAD_MIN_SPEECH_FRAMES) {
    regions.push({ startFrame: regionStart, endFrame: frameCount })
  }

  let speechFrames = 0
  for (const region of regions) {
    for (let frame = region.startFrame; frame < region.endFrame; frame += 1) {
      speech[frame] = 1
      speechFrames += 1
    }
  }

  return {
    speech,
    regions,
    noiseFloorDb,
    thresholdDb,
    speechRatio: speechFrames / frameCount,
  }
}

/**
 * Envelope contínuo de atividade em 0..1, usado na correlação cruzada que
 * estima o offset global.
 *
 * Contínuo e não binário porque a correlação de dois sinais binários satura e
 * produz platôs — vários lags empatados, e a escolha entre eles vira arbitrária.
 */
export function activityEnvelope(rmsDb: Float32Array, noiseFloorDb: number): Float32Array {
  const envelope = new Float32Array(rmsDb.length)
  const range = 30
  for (let frame = 0; frame < rmsDb.length; frame += 1) {
    const normalized = ((rmsDb[frame] ?? noiseFloorDb) - noiseFloorDb) / range
    envelope[frame] = Math.min(1, Math.max(0, normalized))
  }
  return envelope
}

/** Primeiro quadro de fala dentro de uma janela, ou -1. */
export function findOnset(
  speech: Uint8Array,
  fromFrame: number,
  toFrame: number,
): number {
  const start = Math.max(0, fromFrame)
  const end = Math.min(speech.length, toFrame)
  for (let frame = start; frame < end; frame += 1) {
    if (speech[frame] === 1) return frame
  }
  return -1
}

/** Último quadro de fala (exclusivo) dentro de uma janela, ou -1. */
export function findOffset(speech: Uint8Array, fromFrame: number, toFrame: number): number {
  const start = Math.max(0, fromFrame)
  const end = Math.min(speech.length, toFrame)
  for (let frame = end - 1; frame >= start; frame -= 1) {
    if (speech[frame] === 1) return frame + 1
  }
  return -1
}
