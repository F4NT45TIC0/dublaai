export type LiveWaveformMode = 'idle' | 'monitoring' | 'recording'

export interface LiveWaveformData {
  readonly durationMs: number
  readonly recordingPeaks: Int8Array
  readonly recordingBucketCount: number
  readonly monitorPeaks: Int8Array
  readonly monitorCapacity: number
  mode: LiveWaveformMode
  recordedUntilBucket: number
  monitorCount: number
  monitorWriteIndex: number
}

const RECORDING_BUCKETS_PER_SECOND = 200
const MONITOR_BUCKETS = 200

/** Buffer mutável lido pelo Canvas sem provocar renders do React em alta frequência. */
export function createLiveWaveform(durationMs: number): LiveWaveformData {
  const safeDurationMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0
  const recordingBucketCount = Math.max(
    1,
    Math.ceil((safeDurationMs / 1_000) * RECORDING_BUCKETS_PER_SECOND),
  )

  return {
    durationMs: safeDurationMs,
    recordingPeaks: new Int8Array(recordingBucketCount * 2),
    recordingBucketCount,
    monitorPeaks: new Int8Array(MONITOR_BUCKETS * 2),
    monitorCapacity: MONITOR_BUCKETS,
    mode: 'idle',
    recordedUntilBucket: 0,
    monitorCount: 0,
    monitorWriteIndex: 0,
  }
}

export function resetLiveWaveform(data: LiveWaveformData): void {
  data.mode = 'idle'
  data.recordingPeaks.fill(0)
  data.monitorPeaks.fill(0)
  data.recordedUntilBucket = 0
  data.monitorCount = 0
  data.monitorWriteIndex = 0
}

/** Inicia a janela rolante usada enquanto o microfone é preparado e no countdown. */
export function beginLiveWaveformMonitoring(data: LiveWaveformData): void {
  resetLiveWaveform(data)
  data.mode = 'monitoring'
}

/** Pico real do worklet; vira um par min/max simétrico para o envelope ao vivo. */
export function appendLiveWaveformLevel(data: LiveWaveformData, peak: number): void {
  if (data.mode !== 'monitoring' || data.monitorCapacity <= 0) return

  const quantized = quantizeAmplitude(Math.abs(Number.isFinite(peak) ? peak : 0))
  const offset = data.monitorWriteIndex * 2
  data.monitorPeaks[offset] = -quantized
  data.monitorPeaks[offset + 1] = quantized
  data.monitorWriteIndex = (data.monitorWriteIndex + 1) % data.monitorCapacity
  data.monitorCount = Math.min(data.monitorCapacity, data.monitorCount + 1)
}

/** Descarta todo pré-roll: a timeline verde sempre começa junto com o vídeo. */
export function beginLiveWaveformRecording(data: LiveWaveformData): void {
  data.mode = 'recording'
  data.recordingPeaks.fill(0)
  data.monitorPeaks.fill(0)
  data.recordedUntilBucket = 0
  data.monitorCount = 0
  data.monitorWriteIndex = 0
}

/**
 * Agrega PCM real na grade horizontal do vídeo.
 *
 * `mediaEndMs` vem do MediaClock no instante em que o chunk chega. Isso evita
 * usar o tamanho do buffer de captura, que inclui os ~3 s do countdown.
 */
export function appendTimedLiveWaveformSamples(
  data: LiveWaveformData,
  samples: Float32Array,
  sampleRate: number,
  mediaEndMs: number,
): void {
  if (
    data.mode !== 'recording' ||
    samples.length === 0 ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isFinite(mediaEndMs) ||
    data.durationMs <= 0
  ) {
    return
  }

  const chunkDurationMs = (samples.length / sampleRate) * 1_000
  const mediaStartMs = mediaEndMs - chunkDurationMs

  for (let index = 0; index < samples.length; index += 1) {
    const mediaMs = mediaStartMs + ((index + 0.5) / samples.length) * chunkDurationMs
    if (mediaMs < 0 || mediaMs >= data.durationMs) continue

    const bucket = Math.min(
      data.recordingBucketCount - 1,
      Math.floor((mediaMs / data.durationMs) * data.recordingBucketCount),
    )
    const value = quantizeSample(samples[index] ?? 0)
    const offset = bucket * 2
    if (value < (data.recordingPeaks[offset] ?? 0)) data.recordingPeaks[offset] = value
    if (value > (data.recordingPeaks[offset + 1] ?? 0)) {
      data.recordingPeaks[offset + 1] = value
    }
    data.recordedUntilBucket = Math.max(data.recordedUntilBucket, bucket + 1)
  }
}

function quantizeAmplitude(value: number): number {
  return Math.min(127, Math.max(0, Math.round(value * 127)))
}

function quantizeSample(value: number): number {
  return Math.min(127, Math.max(-127, Math.round(value * 127)))
}
