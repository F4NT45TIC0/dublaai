/**
 * Gera os arquivos de áudio que o Chromium usa como microfone falso (§77).
 *
 * `--use-file-for-fake-audio-capture` exige WAV PCM 16-bit e reproduz o
 * arquivo em laço. Por isso a fixture é longa: um arquivo curto reiniciaria
 * várias vezes durante a cena e produziria emendas artificiais no meio da
 * "fala", que sujariam os MFCC.
 *
 * Uso: pnpm test:e2e:fixtures
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { encodeWav, resample } from '@dubla/dsp'
import { concat, silence, synthesizeUtterance, VOWELS } from '@dubla/dsp/testing'
import { ffmpeg } from './lib/ffmpeg'

const ROOT = resolve(import.meta.dirname, '..')
const OUTPUT_DIR = join(ROOT, 'tests', 'e2e', 'fixtures')

/** O Chromium reamostra internamente; 48 kHz evita conversões extras. */
const OUTPUT_RATE = 48_000
const SOURCE_RATE = 16_000

function buildVoiceTrack(): Float32Array {
  const phrase = [VOWELS.o, VOWELS.a, VOWELS.i, VOWELS.e, VOWELS.u] as const
  const chunks: Float32Array[] = []

  // ~30 s alternando fala e pausa, com alturas diferentes para que o contorno
  // de F0 tenha variação real e a métrica de entonação seja exercitada.
  for (let index = 0; index < 12; index += 1) {
    chunks.push(
      synthesizeUtterance({
        phonemes: phrase,
        f0Hz: 120 + (index % 4) * 25,
        sampleRate: SOURCE_RATE,
        gapMs: 60,
        amplitude: 0.5,
      }),
    )
    chunks.push(silence(0.5, SOURCE_RATE))
  }

  return concat(chunks)
}

function buildVideoOverDurationLimit(): void {
  const outputPath = join(OUTPUT_DIR, 'video-over-60s.mp4')

  // Um quadro por segundo e resolução mínima mantêm a fixture pequena,
  // mas ainda produzem um MP4 real cuja duração o navegador precisa ler.
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=160x90:r=1:d=61.1',
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '51',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    outputPath,
  ])
  console.log('video-over-60s.mp4 — 61+ s')
}

function buildVideoWithReferenceAudio(voicePath: string): void {
  const outputPath = join(OUTPUT_DIR, 'video-with-reference-audio.mp4')
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=0x0F0E0C:s=640x360:r=24:d=10',
    '-i',
    voicePath,
    '-t',
    '10',
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '30',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-movflags',
    '+faststart',
    outputPath,
  ])
  console.log('video-with-reference-audio.mp4 — 10 s, H.264 + AAC')
}

function main(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true })

  const voice = resample(buildVoiceTrack(), SOURCE_RATE, OUTPUT_RATE)
  const voicePath = join(OUTPUT_DIR, 'voice-30s.wav')
  writeFileSync(voicePath, Buffer.from(encodeWav(voice, OUTPUT_RATE)))
  console.log(
    `voice-30s.wav — ${(voice.length / OUTPUT_RATE).toFixed(1)}s, ${String(Math.round(voice.length / 512))} KB`,
  )

  // Fixture de silêncio: exercita o caminho do §100 (gravação inaudível não
  // vira score inventado).
  const quiet = new Float32Array(OUTPUT_RATE * 30)
  writeFileSync(join(OUTPUT_DIR, 'silence-30s.wav'), Buffer.from(encodeWav(quiet, OUTPUT_RATE)))
  console.log('silence-30s.wav — 30.0s')

  buildVideoWithReferenceAudio(voicePath)
  buildVideoOverDurationLimit()

  console.log(`\nFixtures em ${OUTPUT_DIR}`)
}

main()
