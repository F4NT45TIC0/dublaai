/** Hann periódica (divisor `n`, não `n-1`) — a variante correta para STFT. */
export function hannWindow(size: number): Float32Array {
  const window = new Float32Array(size)
  for (let i = 0; i < size; i += 1) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size))
  }
  return window
}

/** Blackman, usada no projeto do FIR de reamostragem. */
export function blackmanWindow(size: number): Float64Array {
  const window = new Float64Array(size)
  const last = size - 1
  for (let i = 0; i < size; i += 1) {
    const x = (2 * Math.PI * i) / last
    window[i] = 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x)
  }
  return window
}
