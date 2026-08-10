/**
 * FFT radix-2 iterativa (Cooley-Tukey), com tabelas pré-computadas.
 *
 * Float64 e não Float32: o espectro alimenta logaritmos e depois uma DCT, e
 * erro relativo em bandas de baixa energia se amplifica no domínio log.
 *
 * As leituras são hasteadas para constantes locais dentro dos laços. Além de
 * satisfazer `noUncheckedIndexedAccess`, isso reduz o número de acessos ao
 * buffer por butterfly de seis para quatro.
 */
export class Fft {
  readonly size: number
  private readonly levels: number
  private readonly cosTable: Float64Array
  private readonly sinTable: Float64Array
  private readonly reverse: Uint32Array

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`Fft: tamanho precisa ser potência de 2, recebido ${String(size)}`)
    }
    this.size = size
    this.levels = Math.log2(size)

    const half = size / 2
    this.cosTable = new Float64Array(half)
    this.sinTable = new Float64Array(half)
    for (let i = 0; i < half; i += 1) {
      this.cosTable[i] = Math.cos((2 * Math.PI * i) / size)
      this.sinTable[i] = Math.sin((2 * Math.PI * i) / size)
    }

    this.reverse = new Uint32Array(size)
    for (let i = 0; i < size; i += 1) {
      let value = 0
      for (let bit = 0; bit < this.levels; bit += 1) {
        value = (value << 1) | ((i >>> bit) & 1)
      }
      this.reverse[i] = value
    }
  }

  /** Transformada no lugar. `re` e `im` precisam ter exatamente `size`. */
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.size
    if (re.length !== n || im.length !== n) {
      throw new Error('Fft.transform: buffers precisam ter o tamanho da FFT')
    }

    for (let i = 0; i < n; i += 1) {
      const j = this.reverse[i] ?? 0
      if (j > i) {
        const tmpRe = re[i] ?? 0
        re[i] = re[j] ?? 0
        re[j] = tmpRe
        const tmpIm = im[i] ?? 0
        im[i] = im[j] ?? 0
        im[j] = tmpIm
      }
    }

    for (let span = 2; span <= n; span *= 2) {
      const half = span / 2
      const step = n / span
      for (let start = 0; start < n; start += span) {
        for (let j = start, k = 0; j < start + half; j += 1, k += step) {
          const l = j + half
          const cos = this.cosTable[k] ?? 0
          const sin = this.sinTable[k] ?? 0
          const lRe = re[l] ?? 0
          const lIm = im[l] ?? 0
          const jRe = re[j] ?? 0
          const jIm = im[j] ?? 0

          const tRe = lRe * cos + lIm * sin
          const tIm = -lRe * sin + lIm * cos

          re[l] = jRe - tRe
          im[l] = jIm - tIm
          re[j] = jRe + tRe
          im[j] = jIm + tIm
        }
      }
    }
  }

  /**
   * Espectro de potência de um sinal real já janelado.
   *
   * `frame` pode ser menor que a FFT (o resto fica em zero, que é o
   * zero-padding padrão). Saída tem `size/2 + 1` bins.
   */
  powerSpectrum(frame: Float32Array, out: Float64Array): void {
    const n = this.size
    if (frame.length > n) {
      throw new Error('Fft.powerSpectrum: quadro maior que a FFT')
    }
    if (out.length !== n / 2 + 1) {
      throw new Error('Fft.powerSpectrum: saída precisa ter size/2 + 1')
    }

    const re = new Float64Array(n)
    const im = new Float64Array(n)
    re.set(frame)
    this.transform(re, im)

    for (let i = 0; i <= n / 2; i += 1) {
      const real = re[i] ?? 0
      const imaginary = im[i] ?? 0
      out[i] = real * real + imaginary * imaginary
    }
  }
}
