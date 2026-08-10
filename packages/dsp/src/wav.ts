/**
 * Codec WAV mínimo.
 *
 * Isomórfico de propósito: o mesmo código escreve o arquivo que o navegador
 * entrega no playback e lê o que a ingestão sintetiza. Ter duas implementações
 * seria ter dois formatos ligeiramente diferentes.
 */

export interface DecodedWav {
  readonly samples: Float32Array
  readonly sampleRate: number
  readonly channels: number
}

const RIFF = 0x52494646
const WAVE = 0x57415645
const FMT = 0x666d7420
const DATA = 0x64617461

const FORMAT_PCM = 1
const FORMAT_FLOAT = 3
const FORMAT_EXTENSIBLE = 0xfffe

/**
 * Lê WAV PCM 8/16/24/32-bit e float32, mono ou multicanal (mixado para mono).
 *
 * Os chunks são percorridos em vez de assumidos em posição fixa: arquivos
 * gerados por síntese e por gravadores trazem `LIST`/`fact` antes do `data`, e
 * um leitor que pula direto para o byte 44 devolveria ruído.
 */
export function decodeWav(buffer: ArrayBuffer): DecodedWav {
  if (buffer.byteLength < 44) throw new Error('wav: arquivo curto demais')

  const view = new DataView(buffer)
  if (view.getUint32(0, false) !== RIFF || view.getUint32(8, false) !== WAVE) {
    throw new Error('wav: não é um arquivo RIFF/WAVE')
  }

  let offset = 12
  let format = 0
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let dataStart = -1
  let dataLength = 0

  while (offset + 8 <= buffer.byteLength) {
    const chunkId = view.getUint32(offset, false)
    const chunkSize = view.getUint32(offset + 4, true)
    const body = offset + 8

    if (chunkId === FMT) {
      format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bitsPerSample = view.getUint16(body + 14, true)
      if (format === FORMAT_EXTENSIBLE && chunkSize >= 40) {
        format = view.getUint16(body + 24, true)
      }
    } else if (chunkId === DATA) {
      dataStart = body
      dataLength = Math.min(chunkSize, buffer.byteLength - body)
    }

    // Chunks têm padding para tamanho par.
    offset = body + chunkSize + (chunkSize % 2)
  }

  if (dataStart < 0 || channels <= 0 || sampleRate <= 0) {
    throw new Error('wav: cabeçalho incompleto (fmt ou data ausente)')
  }

  const bytesPerSample = bitsPerSample / 8
  const totalSamples = Math.floor(dataLength / bytesPerSample)
  const frames = Math.floor(totalSamples / channels)
  const samples = new Float32Array(frames)

  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0
    for (let channel = 0; channel < channels; channel += 1) {
      const position = dataStart + (frame * channels + channel) * bytesPerSample
      sum += readSample(view, position, format, bitsPerSample)
    }
    samples[frame] = sum / channels
  }

  return { samples, sampleRate, channels }
}

function readSample(
  view: DataView,
  position: number,
  format: number,
  bitsPerSample: number,
): number {
  if (format === FORMAT_FLOAT) return view.getFloat32(position, true)
  if (format !== FORMAT_PCM) {
    throw new Error(`wav: formato ${String(format)} não suportado`)
  }

  switch (bitsPerSample) {
    case 8:
      return (view.getUint8(position) - 128) / 128
    case 16:
      return view.getInt16(position, true) / 32_768
    case 24: {
      const byte0 = view.getUint8(position)
      const byte1 = view.getUint8(position + 1)
      const byte2 = view.getUint8(position + 2)
      const raw = (byte2 << 16) | (byte1 << 8) | byte0
      // Extensão de sinal do inteiro de 24 bits.
      const signed = raw & 0x80_0000 ? raw - 0x100_0000 : raw
      return signed / 8_388_608
    }
    case 32:
      return view.getInt32(position, true) / 2_147_483_648
    default:
      throw new Error(`wav: ${String(bitsPerSample)} bits não suportado`)
  }
}

/** Escreve WAV PCM 16-bit mono. Formato universalmente reproduzível. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const dataBytes = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)

  view.setUint32(0, RIFF, false)
  view.setUint32(4, 36 + dataBytes, true)
  view.setUint32(8, WAVE, false)

  view.setUint32(12, FMT, false)
  view.setUint32(16, 16, true)
  view.setUint16(20, FORMAT_PCM, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)

  view.setUint32(36, DATA, false)
  view.setUint32(40, dataBytes, true)

  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] ?? 0
    // Clamp antes de escalar: valores fora de [-1, 1] dariam a volta no
    // inteiro de 16 bits e um pico viraria um estalo invertido.
    const clamped = value < -1 ? -1 : value > 1 ? 1 : value
    view.setInt16(44 + i * 2, Math.round(clamped * 32_767), true)
  }

  return buffer
}
