'use client'

import { useEffect, useRef } from 'react'
import type { LiveWaveformData } from '@/lib/live-waveform'

export interface WaveformProps {
  /** Pares int8 min/max, como vêm de `reference.features.bin`. */
  readonly peaks: Int8Array | null
  readonly durationMs: number
  readonly mediaTimeRef: React.RefObject<number>
  /** Envelope mutável do microfone, lido dentro do mesmo rAF do playhead. */
  readonly liveOverlayRef?: React.RefObject<LiveWaveformData | null>
  readonly liveOverlayActive?: boolean
  readonly onSeek?: (ms: number) => void
  readonly className?: string
  readonly label?: string
}

const PLAYHEAD_COLOR = '#FF3B00'
const PAST_COLOR = '#FF3B00'
const FUTURE_COLOR = '#4A4540'
const LIVE_COLOR = '#00D9A3'
const KEYBOARD_SEEK_STEP_MS = 1_000
const KEYBOARD_PAGE_STEP_MS = 5_000

/**
 * Waveform da referência em Canvas.
 *
 * Canvas e não DOM porque uma cena de 20 s tem 4000 baldes de pico: como
 * elementos, seriam 4000 nós redesenhados a cada quadro (§69).
 *
 * A onda estática é desenhada UMA vez num canvas offscreen e apenas copiada a
 * cada quadro; só o playhead é recomposto. É o que mantém o custo por quadro
 * constante, independentemente da duração da cena.
 *
 * Mostra passado, presente e futuro simultaneamente (§16): o trecho já tocado
 * fica em acento, o que falta fica apagado.
 */
export function Waveform({
  peaks,
  durationMs,
  mediaTimeRef,
  liveOverlayRef,
  liveOverlayActive = false,
  onSeek,
  className,
  label = 'Forma de onda da referência',
}: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const offscreenRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const context = canvas.getContext('2d')
    if (!context) return

    let width = 0
    let height = 0
    let rafId = 0
    let lastAccessibleSecond = -1

    const paintStatic = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const rect = canvas.getBoundingClientRect()
      width = Math.max(1, Math.floor(rect.width))
      height = Math.max(1, Math.floor(rect.height))

      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)

      const offscreen = offscreenRef.current ?? document.createElement('canvas')
      offscreenRef.current = offscreen
      offscreen.width = canvas.width
      offscreen.height = canvas.height

      const off = offscreen.getContext('2d')
      if (!off) return

      off.scale(dpr, dpr)
      off.clearRect(0, 0, width, height)

      const middle = height / 2
      if (!peaks || peaks.length < 2) {
        off.fillStyle = FUTURE_COLOR
        off.fillRect(0, middle - 1, width, 2)
        return
      }

      const bucketCount = Math.floor(peaks.length / 2)
      off.fillStyle = FUTURE_COLOR
      for (let x = 0; x < width; x += 1) {
        const from = Math.floor((x / width) * bucketCount)
        const to = Math.max(from + 1, Math.floor(((x + 1) / width) * bucketCount))
        let min = 0
        let max = 0
        for (let bucket = from; bucket < to && bucket < bucketCount; bucket += 1) {
          min = Math.min(min, (peaks[bucket * 2] ?? 0) / 127)
          max = Math.max(max, (peaks[bucket * 2 + 1] ?? 0) / 127)
        }
        const top = middle - max * middle * 0.92
        const bottom = middle - min * middle * 0.92
        off.fillRect(x, top, 1, Math.max(1.5, bottom - top))
      }
    }

    const paintFrame = () => {
      const offscreen = offscreenRef.current
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.clearRect(0, 0, canvas.width, canvas.height)

      if (offscreen) context.drawImage(offscreen, 0, 0)

      context.scale(dpr, dpr)

      const progress =
        durationMs <= 0 ? 0 : Math.min(1, Math.max(0, (mediaTimeRef.current * 1000) / durationMs))
      const playheadX = progress * width
      const accessibleSecond = Math.round((progress * durationMs) / 1_000)
      if (onSeek && accessibleSecond !== lastAccessibleSecond) {
        lastAccessibleSecond = accessibleSecond
        canvas.setAttribute(
          'aria-valuenow',
          String(Math.round(Math.min(durationMs, Math.max(0, mediaTimeRef.current * 1_000)))),
        )
      }

      // O passado é recolorido por composição sobre a onda já desenhada, o que
      // evita redesenhar os picos a cada quadro.
      if (playheadX > 0) {
        context.save()
        context.globalCompositeOperation = 'source-atop'
        context.fillStyle = PAST_COLOR
        context.fillRect(0, 0, playheadX, height)
        context.restore()
      }

      if (liveOverlayActive && liveOverlayRef?.current) {
        paintLiveOverlay(context, liveOverlayRef.current, width, height, playheadX)
      }

      context.fillStyle = PLAYHEAD_COLOR
      context.fillRect(Math.round(playheadX) - 1, 0, 2, height)

      rafId = requestAnimationFrame(paintFrame)
    }

    paintStatic()
    rafId = requestAnimationFrame(paintFrame)

    const observer = new ResizeObserver(() => {
      paintStatic()
    })
    observer.observe(canvas)

    return () => {
      cancelAnimationFrame(rafId)
      observer.disconnect()
    }
  }, [peaks, durationMs, liveOverlayActive, liveOverlayRef, mediaTimeRef, onSeek])

  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onSeek) return
    const rect = event.currentTarget.getBoundingClientRect()
    onSeek(Math.min(durationMs, Math.max(0, ((event.clientX - rect.left) / rect.width) * durationMs)))
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (!onSeek) return
    const currentMs = Math.min(durationMs, Math.max(0, mediaTimeRef.current * 1_000))
    let targetMs: number

    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        targetMs = currentMs - KEYBOARD_SEEK_STEP_MS
        break
      case 'ArrowRight':
      case 'ArrowUp':
        targetMs = currentMs + KEYBOARD_SEEK_STEP_MS
        break
      case 'PageDown':
        targetMs = currentMs - KEYBOARD_PAGE_STEP_MS
        break
      case 'PageUp':
        targetMs = currentMs + KEYBOARD_PAGE_STEP_MS
        break
      case 'Home':
        targetMs = 0
        break
      case 'End':
        targetMs = durationMs
        break
      default:
        return
    }

    event.preventDefault()
    onSeek(Math.min(durationMs, Math.max(0, targetMs)))
  }

  return (
    <canvas
      ref={canvasRef}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role={onSeek ? 'slider' : 'img'}
      aria-label={label}
      aria-orientation={onSeek ? 'horizontal' : undefined}
      aria-valuemin={onSeek ? 0 : undefined}
      aria-valuemax={onSeek ? Math.max(0, Math.round(durationMs)) : undefined}
      aria-valuenow={
        onSeek
          ? Math.round(Math.min(durationMs, Math.max(0, mediaTimeRef.current * 1_000)))
          : undefined
      }
      tabIndex={onSeek ? 0 : undefined}
      className={`${className ?? ''} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
      style={{ width: '100%', height: '100%', display: 'block', cursor: onSeek ? 'pointer' : 'default' }}
    />
  )
}

function paintLiveOverlay(
  context: CanvasRenderingContext2D,
  data: LiveWaveformData,
  width: number,
  height: number,
  playheadX: number,
): void {
  if (data.mode === 'idle') return

  context.save()
  context.fillStyle = LIVE_COLOR
  context.globalAlpha = 0.95

  if (data.mode === 'monitoring') {
    if (data.monitorCount === 0) {
      context.restore()
      return
    }
    const latest = (data.monitorWriteIndex - 1 + data.monitorCapacity) % data.monitorCapacity
    const min = (data.monitorPeaks[latest * 2] ?? 0) / 127
    const max = (data.monitorPeaks[latest * 2 + 1] ?? 0) / 127
    const x = Math.min(Math.max(3, playheadX), Math.max(3, width - 3))
    paintLiveBar(context, x, min, max, height, 5)
    context.restore()
    return
  }

  const bucketCount = data.recordingBucketCount
  const capturedBuckets = Math.min(bucketCount, data.recordedUntilBucket)
  const xLimit = Math.min(width, Math.ceil((capturedBuckets / bucketCount) * width))

  for (let x = 0; x < xLimit; x += 1) {
    const from = Math.floor((x / width) * bucketCount)
    if (from >= capturedBuckets) break
    const to = Math.min(
      capturedBuckets,
      Math.max(from + 1, Math.floor(((x + 1) / width) * bucketCount)),
    )
    let min = 0
    let max = 0
    let hasSignal = false
    for (let bucket = from; bucket < to; bucket += 1) {
      const bucketMin = (data.recordingPeaks[bucket * 2] ?? 0) / 127
      const bucketMax = (data.recordingPeaks[bucket * 2 + 1] ?? 0) / 127
      min = Math.min(min, bucketMin)
      max = Math.max(max, bucketMax)
      if (bucketMin !== 0 || bucketMax !== 0) hasSignal = true
    }
    if (hasSignal) paintLiveBar(context, x, min, max, height, 1.5)
  }

  context.restore()
}

function paintLiveBar(
  context: CanvasRenderingContext2D,
  x: number,
  min: number,
  max: number,
  height: number,
  barWidth: number,
): void {
  if (min === 0 && max === 0) return
  const middle = height / 2
  const top = middle - max * middle * 0.92
  const bottom = middle - min * middle * 0.92
  context.fillRect(x - barWidth / 2, top, barWidth, Math.max(2, bottom - top))
}
