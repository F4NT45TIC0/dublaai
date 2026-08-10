import { resample } from '@dubla/dsp'

/**
 * Costura das tomadas do modo fala-a-fala numa trilha única.
 *
 * No modo por falas, cada segmento vira uma gravação separada, com o seu
 * próprio `mediaStartOffsetMs`. Para ouvir a cena inteira, exportar o vídeo ou
 * pontuar o conjunto, tudo precisa virar uma trilha só, posicionada na timeline
 * do vídeo.
 *
 * Quem consome — o playback comparativo e `export-dubbed-video.ts` — não deve
 * saber se veio de uma tomada ou de doze.
 */

export interface Take {
  /** PCM mono da tomada, na taxa em que foi capturada. */
  readonly samples: Float32Array
  readonly sampleRate: number
  /**
   * Tempo de vídeo da PRIMEIRA amostra da tomada, em ms.
   *
   * Normalmente negativo: o gravador é armado antes do countdown, então a
   * gravação começa alguns segundos antes do vídeo (AUDIO_PIPELINE §1).
   */
  readonly mediaStartOffsetMs: number
  /** Trecho da cena que esta tomada cobre. Fora dele o áudio é descartado. */
  readonly windowStartMs?: number
  readonly windowEndMs?: number
}

/**
 * Rampa aplicada nas bordas de cada tomada.
 *
 * Sem ela, o corte cai no meio de um ciclo da onda e a descontinuidade vira um
 * clique audível — logo na emenda entre uma fala e a seguinte, que é
 * exatamente onde a atenção de quem ouve está.
 */
const CROSSFADE_MS = 20

export interface StitchResult {
  readonly samples: Float32Array
  readonly sampleRate: number
  /** Quantas tomadas contribuíram com pelo menos uma amostra. */
  readonly placed: number
}

export function stitchTakes(
  takes: readonly Take[],
  sceneDurationMs: number,
  sampleRate: number,
): StitchResult {
  const total = Math.max(0, Math.round((sceneDurationMs / 1000) * sampleRate))
  const output = new Float32Array(total)
  if (total === 0 || takes.length === 0) return { samples: output, sampleRate, placed: 0 }

  const fadeSamples = Math.max(1, Math.round((CROSSFADE_MS / 1000) * sampleRate))
  let placed = 0

  for (const take of takes) {
    // Cada tomada pode ter vindo de um dispositivo com taxa diferente — a
    // troca de fone entre falas é comum e não pode desalinhar a costura.
    const samples =
      take.sampleRate === sampleRate
        ? take.samples
        : resample(take.samples, take.sampleRate, sampleRate)

    // Início da tomada na timeline do vídeo. Offset negativo significa que a
    // gravação começou antes do vídeo: essa cauda inicial é descartada.
    const takeStartMs = take.mediaStartOffsetMs
    const windowStartMs = take.windowStartMs ?? 0
    const windowEndMs = take.windowEndMs ?? sceneDurationMs

    // Recorta para a janela do segmento e para os limites da cena.
    const fromMs = Math.max(windowStartMs, 0)
    const toMs = Math.min(windowEndMs, sceneDurationMs)
    if (toMs <= fromMs) continue

    const firstSample = Math.round(((fromMs - takeStartMs) / 1000) * sampleRate)
    const lastSample = Math.round(((toMs - takeStartMs) / 1000) * sampleRate)
    const destination = Math.round((fromMs / 1000) * sampleRate)

    const available = Math.min(lastSample, samples.length) - Math.max(firstSample, 0)
    if (available <= 0) continue

    const sourceStart = Math.max(firstSample, 0)
    const length = Math.min(available, total - destination)
    if (length <= 0) continue

    const fade = Math.min(fadeSamples, Math.floor(length / 2))
    for (let i = 0; i < length; i += 1) {
      const source = samples[sourceStart + i] ?? 0
      let gain = 1
      if (i < fade) gain = i / fade
      else if (i >= length - fade) gain = (length - i) / fade
      // Soma em vez de sobrescrever: tomadas de personagens diferentes podem
      // se sobrepor por alguns quadros nas bordas.
      const target = destination + i
      output[target] = (output[target] ?? 0) + source * gain
    }

    placed += 1
  }

  // A soma pode estourar quando duas falas se encostam. Normalizar só quando
  // passa de 1 preserva o nível original no caso comum.
  let peak = 0
  for (const sample of output) {
    const magnitude = Math.abs(sample)
    if (magnitude > peak) peak = magnitude
  }
  if (peak > 1) {
    for (let i = 0; i < output.length; i += 1) output[i] = (output[i] ?? 0) / peak
  }

  return { samples: output, sampleRate, placed }
}
