/**
 * Gerador do catálogo de cenas do Dubla Aí.
 *
 * Produz, a partir das fontes autorais em `content/scenes/<slug>/source.json`:
 *
 *   apps/web/public/media/scenes/<slug>/video.mp4              (sem áudio)
 *   apps/web/public/media/scenes/<slug>/reference.opus
 *   apps/web/public/media/scenes/<slug>/reference.features.bin
 *   apps/web/public/media/scenes/<slug>/thumb.webp
 *   apps/web/content/catalog.json
 *
 * Todo o conteúdo é autoral e gerado localmente — nenhum arquivo de terceiros é
 * baixado, e nenhuma obra comercial entra no repositório (§39/§40).
 *
 * Uso: pnpm content:build
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { globSync } from 'node:fs'
import {
  ANALYSIS_SAMPLE_RATE,
  computeWaveformPeaks,
  detectSpeech,
  dtwAlign,
  encodeReferenceFeatures,
  encodeWav,
  extractFeatures,
  type FeatureSet,
  HOP_MS,
  quantizeFeatureSet,
} from '@dubla/dsp'
import {
  characterColor,
  type Character,
  type SceneDetail,
  type SpeakerSegment,
  type SubtitleSegment,
  toFfmpegColor,
} from '@dubla/shared'
import { sourceSceneSchema, type SourceScene } from './lib/source-schema'
import { synthesizeAll, type SynthRequest } from './lib/tts'
import { encodeOpus, extractThumbnail, probe, renderSceneVideo } from './lib/ffmpeg'

const ROOT = resolve(import.meta.dirname, '..')
const CONTENT_DIR = join(ROOT, 'content', 'scenes')
const GENERATED_DIR = join(ROOT, 'apps', 'web', 'content')
const MEDIA_DIR = join(ROOT, 'apps', 'web', 'public', 'media', 'scenes')
const WORK_DIR = join(ROOT, 'node_modules', '.cache', 'dubla-content')

const DISPLAY_FONT = 'C:/Windows/Fonts/seguibl.ttf'
const BODY_FONT = 'C:/Windows/Fonts/arialbd.ttf'

/** Tolerância entre o onset detectado e o tempo declarado (MEDIA_PIPELINE §3). */
const ONSET_TOLERANCE_MS = 150

interface TimedLine {
  readonly characterId: string
  readonly text: string
  readonly startMs: number
  readonly endMs: number
  readonly samples: Float32Array
}

interface BuiltScene {
  readonly source: SourceScene
  readonly lines: readonly TimedLine[]
  readonly durationMs: number
  readonly track: Float32Array
  readonly features: FeatureSet
}

function main(): void {
  const sourcePaths = globSync('*/source.json', { cwd: CONTENT_DIR }).sort()
  if (sourcePaths.length === 0) {
    throw new Error(`nenhuma cena encontrada em ${CONTENT_DIR}`)
  }

  console.log(`Encontradas ${String(sourcePaths.length)} cenas.`)

  const sources = sourcePaths.map((relative) => {
    const raw: unknown = JSON.parse(readFileSync(join(CONTENT_DIR, relative), 'utf8'))
    const parsed = sourceSceneSchema.safeParse(raw)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `    ${issue.path.join('.')}: ${issue.message}`)
        .join('\n')
      throw new Error(`fonte inválida em ${relative}:\n${issues}`)
    }
    return parsed.data
  })

  // 1. Sintetiza todas as falas de todas as cenas em um único processo.
  console.log('Sintetizando falas...')
  const requests: SynthRequest[] = []
  for (const source of sources) {
    source.lines.forEach((line, index) => {
      const character = source.characters.find((entry) => entry.id === line.characterId)
      if (!character) throw new Error(`personagem ${line.characterId} não encontrado`)
      requests.push({
        id: `${source.slug}:${String(index)}`,
        text: line.text,
        rate: character.voice.rate,
        pitch: character.voice.pitch,
        outputPath: join(WORK_DIR, source.slug, `line-${String(index)}.wav`),
      })
    })
  }

  const synthesized = new Map(
    synthesizeAll(requests, WORK_DIR).map((result) => [result.id, result]),
  )

  // 2. Monta a trilha de referência de cada cena.
  const built: BuiltScene[] = sources.map((source) => {
    const lines: TimedLine[] = []
    let cursorMs = source.leadInMs

    source.lines.forEach((line, index) => {
      const result = synthesized.get(`${source.slug}:${String(index)}`)
      if (!result) throw new Error(`fala não sintetizada: ${source.slug}:${String(index)}`)
      if (result.sampleRate !== ANALYSIS_SAMPLE_RATE) {
        throw new Error(
          `SAPI devolveu ${String(result.sampleRate)} Hz; esperado ${String(ANALYSIS_SAMPLE_RATE)}`,
        )
      }

      // Aparar o silêncio da síntese é o que faz o tempo declarado coincidir
      // com a fala audível. Sem isso, `startMs` apontaria para o começo do
      // ARQUIVO e não para o começo da VOZ — e o score mediria contra um tempo
      // que ninguém consegue acertar (R-03).
      const trimmed = trimSilence(result.samples)
      const startMs = cursorMs + line.gapBeforeMs
      const durationMs = (trimmed.length / ANALYSIS_SAMPLE_RATE) * 1000

      lines.push({
        characterId: line.characterId,
        text: line.text,
        startMs: Math.round(startMs),
        endMs: Math.round(startMs + durationMs),
        samples: trimmed,
      })
      cursorMs = startMs + durationMs
    })

    const durationMs = Math.round(cursorMs + source.tailMs)
    if (durationMs > 60_000) {
      throw new Error(`cena ${source.slug} tem ${String(durationMs)}ms; o limite do MVP é 60000ms`)
    }

    const track = assembleTrack(lines, durationMs)
    return { source, lines, durationMs, track, features: extractFeatures(track, ANALYSIS_SAMPLE_RATE) }
  })

  // 3. Âncoras de calibração — exigem comparar cada cena com as demais.
  console.log('Calculando âncoras de articulação...')
  const anchors = computeAnchors(built)

  // 4. Artefatos por cena.
  const catalog: SceneDetail[] = []
  for (const scene of built) {
    console.log(`  ${scene.source.slug} (${String(Math.round(scene.durationMs / 1000))}s)`)
    catalog.push(emitScene(scene, anchors))
  }

  mkdirSync(GENERATED_DIR, { recursive: true })
  writeFileSync(join(GENERATED_DIR, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')

  rmSync(WORK_DIR, { recursive: true, force: true })
  console.log(`\nPronto. ${String(catalog.length)} cenas em apps/web/content/catalog.json`)
}

/**
 * Remove silêncio das pontas mantendo uma margem curta.
 *
 * O limiar é relativo ao pico da própria fala: um valor absoluto cortaria a
 * respiração inicial de uma fala alta e não cortaria nada de uma fala baixa.
 */
function trimSilence(samples: Float32Array): Float32Array {
  let peak = 0
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
  if (peak === 0) return samples

  const threshold = peak * 0.02
  const margin = Math.round(0.02 * ANALYSIS_SAMPLE_RATE)

  let start = 0
  while (start < samples.length && Math.abs(samples[start] ?? 0) < threshold) start += 1
  let end = samples.length - 1
  while (end > start && Math.abs(samples[end] ?? 0) < threshold) end -= 1

  return samples.slice(Math.max(0, start - margin), Math.min(samples.length, end + margin))
}

function assembleTrack(lines: readonly TimedLine[], durationMs: number): Float32Array {
  const track = new Float32Array(Math.round((durationMs / 1000) * ANALYSIS_SAMPLE_RATE))
  for (const line of lines) {
    const offset = Math.round((line.startMs / 1000) * ANALYSIS_SAMPLE_RATE)
    for (let i = 0; i < line.samples.length; i += 1) {
      const target = offset + i
      if (target >= track.length) break
      track[target] = line.samples[i] ?? 0
    }
  }
  return track
}

/**
 * `dFloor` e `dChance` por cena (docs/SCORING.md §3.2).
 *
 * `dChance` é a mediana da distância contra as OUTRAS cenas — fala real, do
 * mesmo sintetizador, com conteúdo diferente. É a definição operacional de
 * "não relacionado" que dá significado absoluto ao número mostrado ao usuário.
 */
function computeAnchors(scenes: readonly BuiltScene[]): Map<string, { dFloor: number; dChance: number }> {
  const quantized = scenes.map((scene) => quantizeFeatureSet(scene.features))
  const anchors = new Map<string, { dFloor: number; dChance: number }>()

  scenes.forEach((scene, index) => {
    const reference = quantized[index]
    if (!reference) throw new Error('features ausentes')
    const mask = reference.speech

    const noisy = quantizeFeatureSet(
      extractFeatures(addPinkishNoise(scene.track, 0.02), ANALYSIS_SAMPLE_RATE),
    )
    const dFloor = dtwAlign(
      reference.features,
      reference.frameCount,
      noisy.features,
      noisy.frameCount,
      { referenceMask: mask },
    ).speechDistance

    const others: number[] = []
    quantized.forEach((other, otherIndex) => {
      if (otherIndex === index) return
      others.push(
        dtwAlign(reference.features, reference.frameCount, other.features, other.frameCount, {
          referenceMask: mask,
        }).speechDistance,
      )
    })

    others.sort((a, b) => a - b)
    const dChance = others.length === 0 ? 1 : (others[Math.floor(others.length / 2)] ?? 1)

    if (dChance <= dFloor) {
      throw new Error(
        `cena ${scene.source.slug}: dChance (${dChance.toFixed(4)}) não é maior que dFloor (${dFloor.toFixed(4)}); a articulação ficaria sem régua`,
      )
    }

    anchors.set(scene.source.slug, { dFloor, dChance })
  })

  return anchors
}

/** Ruído determinístico, sem `Math.random`, para a âncora `dFloor`. */
function addPinkishNoise(samples: Float32Array, amplitude: number): Float32Array {
  const output = new Float32Array(samples.length)
  let state = 987_654_321
  let previous = 0
  for (let i = 0; i < samples.length; i += 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    const white = state / 0x1_0000_0000 - 0.5
    // Filtro de primeira ordem: aproxima ruído rosa, mais parecido com ruído
    // ambiente real do que ruído branco.
    previous = 0.85 * previous + 0.15 * white
    output[i] = (samples[i] ?? 0) + previous * amplitude * 4
  }
  return output
}

function emitScene(
  scene: BuiltScene,
  anchors: Map<string, { dFloor: number; dChance: number }>,
): SceneDetail {
  const { source, lines, durationMs, track, features } = scene
  const outputDir = join(MEDIA_DIR, source.slug)
  const sceneWorkDir = join(WORK_DIR, source.slug, 'render')
  mkdirSync(outputDir, { recursive: true })

  const anchor = anchors.get(source.slug)
  if (!anchor) throw new Error(`âncoras ausentes para ${source.slug}`)

  const characters: Character[] = source.characters.map((character) => ({
    id: `${source.work.slug}--${character.id}`,
    workId: source.work.slug,
    name: character.name,
    colorToken: character.colorToken,
    patternToken: character.patternToken,
  }))

  const speakerSegments: SpeakerSegment[] = lines.map((line, index) => ({
    id: `${source.slug}--seg-${String(index)}`,
    sceneId: source.slug,
    characterId: `${source.work.slug}--${line.characterId}`,
    startMs: line.startMs,
    endMs: line.endMs,
    text: line.text,
    orderIndex: index,
  }))

  const subtitleSegments: SubtitleSegment[] = speakerSegments.map((segment) => ({
    id: `${segment.id}--sub`,
    sceneId: source.slug,
    speakerSegmentId: segment.id,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
  }))

  // Vídeo sem faixa de áudio.
  renderSceneVideo({
    outputPath: join(outputDir, 'video.mp4'),
    workDir: sceneWorkDir,
    durationMs,
    workTitle: source.work.title,
    sceneTitle: source.title,
    displayFont: DISPLAY_FONT,
    bodyFont: BODY_FONT,
    cards: speakerSegments.map((segment) => {
      const character = source.characters.find(
        (entry) => `${source.work.slug}--${entry.id}` === segment.characterId,
      )
      return {
        characterName: character?.name ?? '',
        text: segment.text,
        // A legenda entra um pouco antes da fala: o dublador precisa ler o
        // texto ANTES de precisar dizê-lo.
        startMs: Math.max(0, segment.startMs - 600),
        endMs: segment.endMs + 200,
        colorHex: toFfmpegColor(characterColor(character?.colorToken ?? 'character-1')),
      }
    }),
  })

  // Áudio de referência.
  const wavPath = join(sceneWorkDir, 'reference.wav')
  mkdirSync(sceneWorkDir, { recursive: true })
  writeFileSync(wavPath, Buffer.from(encodeWav(track, ANALYSIS_SAMPLE_RATE)))
  encodeOpus(wavPath, join(outputDir, 'reference.opus'))

  // Features + âncoras.
  writeFileSync(
    join(outputDir, 'reference.features.bin'),
    Buffer.from(
      encodeReferenceFeatures(
        quantizeFeatureSet(features),
        anchor,
        computeWaveformPeaks(track, ANALYSIS_SAMPLE_RATE, 200),
      ),
    ),
  )

  extractThumbnail(
    join(outputDir, 'video.mp4'),
    join(outputDir, 'thumb.webp'),
    Math.min(durationMs / 1000 - 0.1, (speakerSegments[0]?.startMs ?? 0) / 1000 + 0.3),
  )

  verify(scene, speakerSegments, join(outputDir, 'video.mp4'))

  return {
    id: source.slug,
    slug: source.slug,
    workId: source.work.slug,
    title: source.title,
    ...(source.description === undefined ? {} : { description: source.description }),
    durationMs,
    difficulty: source.difficulty,
    language: 'pt-BR',
    videoKey: `scenes/${source.slug}/video.mp4`,
    referenceAudioKey: `scenes/${source.slug}/reference.opus`,
    featuresKey: `scenes/${source.slug}/reference.features.bin`,
    thumbnailKey: `scenes/${source.slug}/thumb.webp`,
    characterCount: characters.length,
    status: 'published',
    work: {
      id: source.work.slug,
      slug: source.work.slug,
      title: source.work.title,
      type: source.work.type,
      ...(source.work.year === undefined ? {} : { year: source.work.year }),
      ...(source.work.synopsis === undefined ? {} : { synopsis: source.work.synopsis }),
    },
    characters,
    speakerSegments,
    subtitleSegments,
    rights: {
      source: source.rights.source,
      owner: source.rights.owner,
      licenseType: source.rights.licenseType,
      territories: source.rights.territories,
      ...(source.rights.usageRestrictions === undefined
        ? {}
        : { usageRestrictions: source.rights.usageRestrictions }),
      ...(source.rights.proofReference === undefined
        ? {}
        : { proofReference: source.rights.proofReference }),
    },
  }
}

/**
 * Verificações de publicação (docs/MEDIA_PIPELINE.md §3).
 *
 * A checagem de onset é a que importa mais: ela garante que os tempos
 * declarados no catálogo correspondem à voz que realmente está no arquivo.
 * Sem ela, um erro de montagem produziria scores errados de forma silenciosa.
 */
function verify(
  scene: BuiltScene,
  segments: readonly SpeakerSegment[],
  videoPath: string,
): void {
  const summary = probe(videoPath)

  if (summary.hasAudioStream) {
    throw new Error(`${scene.source.slug}: o vídeo tem faixa de áudio, o que o §14 proíbe`)
  }
  if (summary.width !== 1280 || summary.height !== 720) {
    throw new Error(`${scene.source.slug}: vídeo em ${String(summary.width)}x${String(summary.height)}`)
  }

  const videoDurationMs = summary.durationSec * 1000
  if (Math.abs(videoDurationMs - scene.durationMs) > 150) {
    throw new Error(
      `${scene.source.slug}: vídeo tem ${videoDurationMs.toFixed(0)}ms mas a cena declara ${String(scene.durationMs)}ms`,
    )
  }

  const vad = detectSpeech(scene.features.rmsDb)
  for (const segment of segments) {
    const detected = vad.regions.find(
      (region) => Math.abs(region.startFrame * HOP_MS - segment.startMs) <= ONSET_TOLERANCE_MS,
    )
    if (!detected) {
      const nearest = vad.regions
        .map((region) => region.startFrame * HOP_MS)
        .reduce<number | null>(
          (best, value) =>
            best === null || Math.abs(value - segment.startMs) < Math.abs(best - segment.startMs)
              ? value
              : best,
          null,
        )
      throw new Error(
        `${scene.source.slug}: o segmento ${segment.id} declara início em ${String(segment.startMs)}ms, ` +
          `mas o áudio de referência não tem fala ali (mais próximo: ${nearest === null ? 'nenhum' : `${String(Math.round(nearest))}ms`}). ` +
          `Os tempos do catálogo precisam corresponder ao áudio, senão o score mede contra dados errados.`,
      )
    }
  }
}

if (!existsSync(CONTENT_DIR)) {
  throw new Error(`diretório de cenas não encontrado: ${CONTENT_DIR}`)
}

main()
