import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaClock } from '../clock/media-clock'

/**
 * Vídeo falso controlado pelo teste.
 *
 * Os quadros são entregues quando o teste manda, com os tempos que o teste
 * escolhe. É a única forma de afirmar algo sobre precisão de sincronização sem
 * depender do relógio real nem de um navegador compositando.
 */
class FakeVideo {
  currentTime = 0
  paused = false
  seeking = false
  ended = false

  private callbacks: VideoFrameRequestCallback[] = []
  private nextId = 1
  readonly supportsFrameCallback: boolean

  constructor(supportsFrameCallback: boolean) {
    this.supportsFrameCallback = supportsFrameCallback
    if (!supportsFrameCallback) {
      // Simula Firefox antigo: a API simplesmente não existe.
      ;(this as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback = undefined
    }
  }

  requestVideoFrameCallback(callback: VideoFrameRequestCallback): number {
    this.callbacks.push(callback)
    return this.nextId++
  }

  cancelVideoFrameCallback(): void {
    this.callbacks = []
  }

  addEventListener(): void {
    /* não usado nestes testes */
  }

  removeEventListener(): void {
    /* não usado nestes testes */
  }

  /** Entrega um quadro: `mediaTime` segundos exibido em `displayPerfMs`. */
  emitFrame(mediaTimeSec: number, displayPerfMs: number): void {
    this.currentTime = mediaTimeSec
    const pending = this.callbacks
    this.callbacks = []
    for (const callback of pending) {
      callback(displayPerfMs, {
        mediaTime: mediaTimeSec,
        expectedDisplayTime: displayPerfMs,
        presentationTime: displayPerfMs,
        presentedFrames: 1,
        width: 1280,
        height: 720,
      })
    }
  }
}

function asVideo(fake: FakeVideo): HTMLVideoElement {
  return fake as unknown as HTMLVideoElement
}

/** Reproduz 30 fps perfeitos começando em `startPerfMs`. */
function playFrames(
  fake: FakeVideo,
  count: number,
  startPerfMs = 1_000,
  fps = 30,
  startMediaSec = 0,
): void {
  for (let index = 0; index < count; index += 1) {
    fake.emitFrame(startMediaSec + index / fps, startPerfMs + (index * 1000) / fps)
  }
}

describe('MediaClock', () => {
  beforeEach(() => {
    vi.spyOn(performance, 'now').mockReturnValue(1_000)
  })

  it('cai para video.currentTime enquanto não tem amostras suficientes', () => {
    const fake = new FakeVideo(true)
    fake.currentTime = 4.2
    const clock = new MediaClock(asVideo(fake))
    clock.start()

    expect(clock.mediaTimeAtPerf(1_000)).toBe(4.2)
    expect(clock.confidence).toBe(0)
    clock.stop()
  })

  it('ajusta a reta e prevê o tempo de mídia com precisão de milissegundo', () => {
    const fake = new FakeVideo(true)
    const clock = new MediaClock(asVideo(fake))
    clock.start()

    playFrames(fake, 20)

    // Reta esperada: mediaTime = (perfMs − 1000) / 1000
    expect(clock.confidence).toBeGreaterThan(0.99)
    expect(clock.mediaTimeAtPerf(1_500)).toBeCloseTo(0.5, 4)
    expect(clock.mediaTimeAtPerf(3_000)).toBeCloseTo(2.0, 4)

    // E o caminho inverso precisa ser consistente com o direto.
    expect(clock.perfAtMediaTime(2.0)).toBeCloseTo(3_000, 1)
    clock.stop()
  })

  it('prevê além da última amostra, que é o que permite agendar o countdown', () => {
    const fake = new FakeVideo(true)
    const clock = new MediaClock(asVideo(fake))
    clock.start()
    playFrames(fake, 20)

    // Última amostra em perf ≈ 1633 ms. Prever 400 ms à frente.
    expect(clock.mediaTimeAtPerf(2_033)).toBeCloseTo(1.033, 3)
    clock.stop()
  })

  it('congela now() durante pausa sem perder a conversão histórica do offset', () => {
    const fake = new FakeVideo(true)
    const clock = new MediaClock(asVideo(fake))
    clock.start()
    playFrames(fake, 20)

    fake.paused = true
    fake.currentTime = 0.625
    vi.spyOn(performance, 'now').mockReturnValue(5_000)

    // A UI deve permanecer no playhead pausado, sem extrapolar a reta até 4 s.
    expect(clock.now().mediaTimeSec).toBe(0.625)

    const context = {
      currentTime: 4.5,
      getOutputTimestamp: () => ({ contextTime: 4.5, performanceTime: 5_000 }),
    } as unknown as AudioContext
    clock.attachAudioContext(context)

    // O cálculo do offset, porém, ainda precisa consultar a reta histórica.
    expect(clock.mediaTimeAtPerf(5_000)).toBeCloseTo(4, 4)
    expect(clock.contextTimeToMediaTime(4.5)).toBeCloseTo(4, 4)
    clock.stop()
  })

  it.each(['seeking', 'ended'] as const)('não extrapola now() quando o vídeo está %s', (state) => {
    const fake = new FakeVideo(true)
    const clock = new MediaClock(asVideo(fake))
    clock.start()
    playFrames(fake, 20)

    fake[state] = true
    fake.currentTime = 7.25
    vi.spyOn(performance, 'now').mockReturnValue(20_000)

    expect(clock.now().mediaTimeSec).toBe(7.25)
    clock.stop()
  })

  it('descarta o histórico quando o usuário faz seek para trás', () => {
    const fake = new FakeVideo(true)
    const clock = new MediaClock(asVideo(fake))
    clock.start()

    playFrames(fake, 20)
    expect(clock.sampleCount).toBe(20)

    // Seek: o tempo de mídia volta, mas o relógio de parede segue em frente.
    fake.emitFrame(0.2, 2_000)
    expect(clock.sampleCount).toBe(1)
    expect(clock.confidence).toBe(0)

    clock.stop()
  })

  it('descarta o histórico em um salto grande para a frente', () => {
    const fake = new FakeVideo(true)
    const clock = new MediaClock(asVideo(fake))
    clock.start()

    playFrames(fake, 20)
    fake.emitFrame(9.0, 2_000)
    expect(clock.sampleCount).toBe(1)
    clock.stop()
  })

  it('reset() limpa o ajuste', () => {
    const fake = new FakeVideo(true)
    const clock = new MediaClock(asVideo(fake))
    clock.start()
    playFrames(fake, 20)

    clock.reset()
    expect(clock.confidence).toBe(0)
    expect(clock.sampleCount).toBe(0)
    clock.stop()
  })

  it('reiniciar o relógio descarta a sessão anterior e ajusta a nova timeline', () => {
    const fake = new FakeVideo(true)
    const clock = new MediaClock(asVideo(fake))
    clock.start()
    playFrames(fake, 20)
    clock.stop()

    clock.start()
    expect(clock.sampleCount).toBe(0)
    expect(clock.confidence).toBe(0)
    playFrames(fake, 20, 10_000, 30, 12)

    expect(clock.mediaTimeAtPerf(10_500)).toBeCloseTo(12.5, 4)
    expect(clock.perfAtMediaTime(12.5)).toBeCloseTo(10_500, 1)
    clock.stop()
  })

  it('perde confiança quando os quadros chegam irregulares', () => {
    const fake = new FakeVideo(true)
    const clock = new MediaClock(asVideo(fake))
    clock.start()

    // Vídeo gaguejando: o tempo de mídia anda, o de parede anda diferente.
    const jitter = [0, 60, 70, 200, 210, 215, 400, 402, 700, 705]
    jitter.forEach((perfOffset, index) => {
      fake.emitFrame(index / 30, 1_000 + perfOffset)
    })

    expect(clock.confidence).toBeLessThan(0.99)
    clock.stop()
  })

  it('limita a confiança quando não há requestVideoFrameCallback', () => {
    const fake = new FakeVideo(false)
    const clock = new MediaClock(asVideo(fake))

    expect(clock.usesFallback).toBe(true)
    // Mesmo com um ajuste perfeito, o modo degradado não afirma certeza total.
    expect(clock.confidence).toBeLessThanOrEqual(0.7)
  })

  it('não converte tempo de áudio antes de receber um AudioContext', () => {
    const fake = new FakeVideo(true)
    const clock = new MediaClock(asVideo(fake))
    clock.start()
    playFrames(fake, 20)

    expect(clock.contextTimeToMediaTime(1.5)).toBeNull()
    clock.stop()
  })

  it('converte tempo do relógio de áudio para tempo de mídia', () => {
    const fake = new FakeVideo(true)
    const clock = new MediaClock(asVideo(fake))
    clock.start()
    playFrames(fake, 20)

    // Contexto de áudio cujo t=0 aconteceu 500 ms antes do início do vídeo.
    const context = {
      currentTime: 2.0,
      getOutputTimestamp: () => ({ contextTime: 2.0, performanceTime: 2_500 }),
    } as unknown as AudioContext

    clock.attachAudioContext(context)

    // contextTime 2.0 ↔ perf 2500 ↔ mediaTime 1.5
    expect(clock.contextTimeToMediaTime(2.0)).toBeCloseTo(1.5, 4)
    // Meio segundo depois no relógio de áudio = meio segundo depois no vídeo.
    expect(clock.contextTimeToMediaTime(2.5)).toBeCloseTo(2.0, 4)

    clock.stop()
  })

  it('sobrevive a getOutputTimestamp não populado (Safari)', () => {
    const fake = new FakeVideo(true)
    const clock = new MediaClock(asVideo(fake))
    clock.start()
    playFrames(fake, 20)

    const context = {
      currentTime: 2.0,
      getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }),
    } as unknown as AudioContext

    clock.attachAudioContext(context)
    // Aproximado, mas presente: degradar é aceitável, quebrar não é.
    expect(clock.contextTimeToMediaTime(2.0)).not.toBeNull()

    clock.stop()
  })
})
