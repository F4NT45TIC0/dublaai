'use client'

import { useEffect, useRef } from 'react'
import type { MelSpectrogram } from '@dubla/dsp'

export interface ReferenceSpectrogramProps {
  readonly spectrogram: MelSpectrogram
  readonly durationMs: number
  readonly mediaTimeRef: React.RefObject<number>
  readonly onSeek?: (ms: number) => void
}

const PLAYHEAD_COLOR = '#F2F0E9'
const KEYBOARD_SEEK_STEP_MS = 1_000
const KEYBOARD_PAGE_STEP_MS = 5_000

/** Espectrograma log-mel da faixa de áudio usada como referência pelo score. */
export function ReferenceSpectrogram({
  spectrogram,
  durationMs,
  mediaTimeRef,
  onSeek,
}: ReferenceSpectrogramProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const source = document.createElement('canvas')
    source.width = Math.max(1, spectrogram.columns)
    source.height = Math.max(1, spectrogram.bands)
    const sourceContext = source.getContext('2d')
    if (!sourceContext) return

    const image = sourceContext.createImageData(source.width, source.height)
    for (let column = 0; column < spectrogram.columns; column += 1) {
      for (let band = 0; band < spectrogram.bands; band += 1) {
        const intensity = (spectrogram.values[column * spectrogram.bands + band] ?? 0) / 255
        const [red, green, blue] = spectrogramColor(intensity)
        const y = spectrogram.bands - band - 1
        const pixel = (y * source.width + column) * 4
        image.data[pixel] = red
        image.data[pixel + 1] = green
        image.data[pixel + 2] = blue
        image.data[pixel + 3] = 255
      }
    }
    sourceContext.putImageData(image, 0, 0)

    let width = 1
    let height = 1
    let rafId = 0
    let lastAccessibleSecond = -1

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const rect = canvas.getBoundingClientRect()
      width = Math.max(1, Math.floor(rect.width))
      height = Math.max(1, Math.floor(rect.height))
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
    }

    const paint = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.imageSmoothingEnabled = true
      context.drawImage(source, 0, 0, canvas.width, canvas.height)
      context.scale(dpr, dpr)

      const progress =
        durationMs <= 0 ? 0 : Math.min(1, Math.max(0, (mediaTimeRef.current * 1_000) / durationMs))
      const accessibleSecond = Math.round((progress * durationMs) / 1_000)
      if (onSeek && accessibleSecond !== lastAccessibleSecond) {
        lastAccessibleSecond = accessibleSecond
        canvas.setAttribute(
          'aria-valuenow',
          String(Math.round(Math.min(durationMs, Math.max(0, mediaTimeRef.current * 1_000)))),
        )
      }
      context.fillStyle = PLAYHEAD_COLOR
      context.fillRect(Math.round(progress * width) - 1, 0, 2, height)
      rafId = requestAnimationFrame(paint)
    }

    resize()
    rafId = requestAnimationFrame(paint)
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)

    return () => {
      cancelAnimationFrame(rafId)
      observer.disconnect()
    }
  }, [durationMs, mediaTimeRef, onSeek, spectrogram])

  const seekTo = (milliseconds: number) => {
    onSeek?.(Math.min(durationMs, Math.max(0, milliseconds)))
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
    seekTo(targetMs)
  }

  return (
    <canvas
      ref={canvasRef}
      role={onSeek ? 'slider' : 'img'}
      aria-label="Espectrograma da referência sonora"
      aria-orientation={onSeek ? 'horizontal' : undefined}
      aria-valuemin={onSeek ? 0 : undefined}
      aria-valuemax={onSeek ? Math.max(0, Math.round(durationMs)) : undefined}
      aria-valuenow={
        onSeek
          ? Math.round(Math.min(durationMs, Math.max(0, mediaTimeRef.current * 1_000)))
          : undefined
      }
      data-testid="reference-spectrogram"
      onClick={(event) => {
        if (!onSeek) return
        const rect = event.currentTarget.getBoundingClientRect()
        seekTo(((event.clientX - rect.left) / rect.width) * durationMs)
      }}
      onKeyDown={handleKeyDown}
      tabIndex={onSeek ? 0 : undefined}
      className="block h-full w-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      style={{ cursor: onSeek ? 'pointer' : 'default' }}
    />
  )
}

function spectrogramColor(value: number): [number, number, number] {
  const clamped = Math.min(1, Math.max(0, value))
  if (clamped <= 0.7) {
    return mix([15, 14, 12], [255, 59, 0], clamped / 0.7)
  }
  return mix([255, 59, 0], [242, 240, 233], (clamped - 0.7) / 0.3)
}

function mix(from: [number, number, number], to: [number, number, number], t: number) {
  return from.map((value, index) => Math.round(value + ((to[index] ?? value) - value) * t)) as [
    number,
    number,
    number,
  ]
}
