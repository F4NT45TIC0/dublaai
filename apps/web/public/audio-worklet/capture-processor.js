/**
 * Captura de PCM no thread de áudio.
 *
 * A razão de existir deste arquivo cabe em uma linha: dentro do
 * AudioWorkletGlobalScope, `currentFrame` é o índice EXATO da amostra no início
 * do bloco sendo processado. É o único ponto do navegador onde se obtém um t=0
 * com precisão de amostra — `MediaRecorder` só oferece um evento `onstart` que
 * chega depois de um priming de encoder de duração desconhecida (ADR 0001).
 *
 * Este arquivo é JavaScript puro, servido estaticamente: o escopo do worklet
 * não passa pelo bundler e não tem acesso a módulos da aplicação.
 */

const CHUNK_FRAMES = 4096
/** ~21 ms a 48 kHz: cadência do medidor de nível para a waveform ao vivo. */
const LEVEL_INTERVAL_QUANTA = 8

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()

    this.armed = false
    this.startFrame = -1
    this.chunk = new Float32Array(CHUNK_FRAMES)
    this.chunkOffset = 0
    this.quantaSinceLevel = 0
    this.peakSinceLevel = 0
    this.clippedSamples = 0
    this.totalSamples = 0

    this.port.onmessage = (event) => {
      const data = event.data
      if (!data || typeof data.type !== 'string') return

      if (data.type === 'arm') {
        this.armed = true
      } else if (data.type === 'disarm') {
        this.flush()
        this.armed = false
        this.startFrame = -1
        this.chunkOffset = 0
        this.clippedSamples = 0
        this.totalSamples = 0
      }
    }
  }

  /** Envia o que estiver acumulado, transferindo a posse do buffer. */
  flush() {
    if (this.chunkOffset === 0) return
    const slice = this.chunk.slice(0, this.chunkOffset)
    this.port.postMessage({ type: 'chunk', samples: slice }, [slice.buffer])
    this.chunkOffset = 0
  }

  process(inputs) {
    const input = inputs[0]
    const channel = input && input[0]

    // Sem entrada neste bloco (dispositivo trocando, track mutada): manter o
    // processador vivo é essencial — retornar false o encerraria de vez.
    if (!channel || channel.length === 0) return true

    let peak = 0
    for (const sample of channel) {
      const magnitude = sample < 0 ? -sample : sample
      if (magnitude > peak) peak = magnitude
    }
    if (peak > this.peakSinceLevel) this.peakSinceLevel = peak

    if (this.armed) {
      if (this.startFrame < 0) {
        // O instante exato, em amostras, do primeiro bloco gravado. Tudo que o
        // §18 pede é derivado daqui.
        this.startFrame = currentFrame
        this.port.postMessage({
          type: 'started',
          startFrame: currentFrame,
          contextTime: currentTime,
          sampleRate,
        })
      }

      for (const sample of channel) {
        this.chunk[this.chunkOffset] = sample
        this.chunkOffset += 1
        this.totalSamples += 1
        if (sample >= 0.99 || sample <= -0.99) this.clippedSamples += 1
        if (this.chunkOffset === CHUNK_FRAMES) this.flush()
      }
    }

    this.quantaSinceLevel += 1
    if (this.quantaSinceLevel >= LEVEL_INTERVAL_QUANTA) {
      this.port.postMessage({
        type: 'level',
        peak: this.peakSinceLevel,
        recording: this.armed,
        clippedRatio: this.totalSamples === 0 ? 0 : this.clippedSamples / this.totalSamples,
      })
      this.quantaSinceLevel = 0
      this.peakSinceLevel = 0
    }

    return true
  }
}

registerProcessor('capture-processor', CaptureProcessor)
