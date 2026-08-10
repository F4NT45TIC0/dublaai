import { describe, expect, it } from 'vitest'
import {
  appendLiveWaveformLevel,
  appendTimedLiveWaveformSamples,
  beginLiveWaveformMonitoring,
  beginLiveWaveformRecording,
  createLiveWaveform,
  resetLiveWaveform,
} from '../live-waveform'

describe('live waveform', () => {
  it('usa o pico real do monitor e descarta o pré-roll ao começar a gravação', () => {
    const data = createLiveWaveform(1_000)
    beginLiveWaveformMonitoring(data)
    appendLiveWaveformLevel(data, 0.5)

    expect(data.mode).toBe('monitoring')
    expect(data.monitorCount).toBe(1)
    expect(data.monitorPeaks[0]).toBe(-64)
    expect(data.monitorPeaks[1]).toBe(64)

    beginLiveWaveformRecording(data)

    expect(data.mode).toBe('recording')
    expect(data.monitorCount).toBe(0)
    expect(data.recordedUntilBucket).toBe(0)
    expect(Array.from(data.recordingPeaks).every((value) => value === 0)).toBe(true)
  })

  it('posiciona PCM pela timeline do vídeo e ignora a parte anterior a zero', () => {
    const data = createLiveWaveform(1_000)
    beginLiveWaveformRecording(data)

    // O chunk dura 1 s e termina em 500 ms: metade dele ainda é pré-roll.
    appendTimedLiveWaveformSamples(data, new Float32Array([-1, 1, -0.25, 0.5]), 4, 500)

    expect(data.recordingPeaks[25 * 2]).toBe(-32)
    expect(data.recordingPeaks[25 * 2 + 1]).toBe(0)
    expect(data.recordingPeaks[75 * 2]).toBe(0)
    expect(data.recordingPeaks[75 * 2 + 1]).toBe(64)
    expect(data.recordedUntilBucket).toBe(76)
  })

  it('limpa todos os dados entre tentativas', () => {
    const data = createLiveWaveform(2_000)
    beginLiveWaveformRecording(data)
    appendTimedLiveWaveformSamples(data, new Float32Array([0.8, -0.8]), 2, 1_000)

    resetLiveWaveform(data)

    expect(data.mode).toBe('idle')
    expect(data.recordedUntilBucket).toBe(0)
    expect(data.monitorCount).toBe(0)
    expect(Array.from(data.recordingPeaks).every((value) => value === 0)).toBe(true)
  })
})
