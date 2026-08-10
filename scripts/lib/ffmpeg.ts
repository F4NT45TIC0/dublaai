import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Wrappers de ffmpeg/ffprobe. Sem rede, sem stdin, com timeout. */

function run(command: string, args: readonly string[]): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
  })
}

export function ffmpeg(args: readonly string[]): void {
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args])
}

export function ffprobeJson(args: readonly string[]): unknown {
  return JSON.parse(run('ffprobe', ['-hide_banner', '-loglevel', 'error', '-of', 'json', ...args]))
}

export interface ProbeSummary {
  readonly durationSec: number
  readonly hasAudioStream: boolean
  readonly width: number
  readonly height: number
}

export function probe(path: string): ProbeSummary {
  const raw = ffprobeJson(['-show_streams', '-show_format', path]) as {
    streams?: { codec_type?: string; width?: number; height?: number }[]
    format?: { duration?: string }
  }

  const streams = raw.streams ?? []
  const video = streams.find((stream) => stream.codec_type === 'video')

  return {
    durationSec: Number(raw.format?.duration ?? 0),
    hasAudioStream: streams.some((stream) => stream.codec_type === 'audio'),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
  }
}

/**
 * Escapa um caminho para uso DENTRO de um filtro do ffmpeg.
 *
 * No Windows, `C:/Windows/...` contém o mesmo dois-pontos que o ffmpeg usa
 * para separar opções de filtro — sem escapar, `fontfile=C:/...` é lido como
 * duas opções e o filtro falha com uma mensagem que não menciona o caminho.
 */
export function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/:/g, '\\:')
}

export interface SubtitleCard {
  readonly characterName: string
  readonly text: string
  readonly startMs: number
  readonly endMs: number
  readonly colorHex: string
}

export interface VideoOptions {
  readonly outputPath: string
  readonly workDir: string
  readonly durationMs: number
  readonly workTitle: string
  readonly sceneTitle: string
  readonly cards: readonly SubtitleCard[]
  readonly displayFont: string
  readonly bodyFont: string
}

const WIDTH = 1280
const HEIGHT = 720
const FPS = 30
const BACKGROUND = '0x0F0E0C'

/**
 * Gera o vídeo da cena — 720p, H.264, **sem faixa de áudio** (ADR 0004).
 *
 * O texto vai para arquivos e entra por `textfile=`. Passar diálogo em pt-BR
 * direto na linha de comando exigiria escapar acentos, apóstrofos, vírgulas e
 * dois-pontos em três níveis de parsing (shell, filtergraph, drawtext) — é a
 * origem clássica de bugs silenciosos de renderização.
 */
export function renderSceneVideo(options: VideoOptions): void {
  const { outputPath, workDir, durationMs, cards, displayFont, bodyFont } = options
  const durationSec = durationMs / 1000

  mkdirSync(dirname(outputPath), { recursive: true })
  mkdirSync(workDir, { recursive: true })

  const headerPath = join(workDir, 'header.txt')
  writeFileSync(headerPath, `${options.workTitle}  ·  ${options.sceneTitle}`, 'utf8')

  const filters: string[] = [
    // Faixa superior com a obra e a cena.
    `drawtext=fontfile='${escapeFilterPath(bodyFont)}':textfile='${escapeFilterPath(headerPath)}':` +
      `fontcolor=0x8A8580:fontsize=24:x=64:y=56`,
  ]

  cards.forEach((card, index) => {
    const namePath = join(workDir, `card-${String(index)}-name.txt`)
    const textPath = join(workDir, `card-${String(index)}-text.txt`)
    writeFileSync(namePath, card.characterName, 'utf8')
    writeFileSync(textPath, wrapText(card.text, 34), 'utf8')

    const from = (card.startMs / 1000).toFixed(3)
    const to = (card.endMs / 1000).toFixed(3)
    const enable = `between(t,${from},${to})`

    // Marca de cor do personagem — redundante com o nome, nunca sozinha (§63).
    filters.push(
      `drawbox=x=64:y=232:w=12:h=190:color=${card.colorHex}@1:t=fill:enable='${enable}'`,
      `drawtext=fontfile='${escapeFilterPath(displayFont)}':textfile='${escapeFilterPath(namePath)}':` +
        `fontcolor=${card.colorHex}:fontsize=34:x=104:y=236:enable='${enable}'`,
      `drawtext=fontfile='${escapeFilterPath(displayFont)}':textfile='${escapeFilterPath(textPath)}':` +
        `fontcolor=0xF2F0E9:fontsize=58:line_spacing=16:x=104:y=300:enable='${enable}'`,
    )
  })

  // Barra de progresso: a largura cresce com o tempo, dando ao dublador uma
  // referência visual de quanto falta sem precisar ler um cronômetro.
  filters.push(
    `drawbox=x=64:y=${String(HEIGHT - 96)}:w=${String(WIDTH - 128)}:h=4:color=0x2A2724@1:t=fill`,
    `drawbox=x=64:y=${String(HEIGHT - 96)}:w='(${String(WIDTH - 128)})*t/${durationSec.toFixed(3)}':h=4:color=0xFF3B00@1:t=fill`,
  )

  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `color=c=${BACKGROUND}:s=${String(WIDTH)}x${String(HEIGHT)}:r=${String(FPS)}:d=${durationSec.toFixed(3)}`,
    '-vf',
    filters.join(','),
    // -an é o requisito duro do §14: o arquivo não tem o que desmutar.
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    outputPath,
  ])
}

export function encodeOpus(wavPath: string, outputPath: string): void {
  mkdirSync(dirname(outputPath), { recursive: true })
  ffmpeg(['-i', wavPath, '-c:a', 'libopus', '-b:a', '48k', '-ac', '1', outputPath])
}

export function extractThumbnail(videoPath: string, outputPath: string, atSec: number): void {
  mkdirSync(dirname(outputPath), { recursive: true })
  ffmpeg([
    '-ss',
    atSec.toFixed(3),
    '-i',
    videoPath,
    '-frames:v',
    '1',
    '-vf',
    'scale=640:-1',
    '-c:v',
    'libwebp',
    '-quality',
    '80',
    outputPath,
  ])
}

/** Quebra em linhas de no máximo `maxChars`, sem cortar palavras. */
function wrapText(text: string, maxChars: number): string {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`
    if (candidate.length > maxChars && current.length > 0) {
      lines.push(current)
      current = word
    } else {
      current = candidate
    }
  }
  if (current.length > 0) lines.push(current)
  return lines.join('\n')
}
