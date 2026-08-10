/**
 * Cores de personagem.
 *
 * Definidas aqui, e não só no CSS, porque o gerador de cenas precisa das
 * mesmas cores para desenhar o vídeo com ffmpeg. Duas listas divergiriam na
 * primeira vez que alguém ajustasse um tom.
 *
 * A cor NUNCA identifica um personagem sozinha (§63) — ela sempre acompanha o
 * nome e um `patternToken`.
 */
export const CHARACTER_COLORS = {
  'character-1': '#FF3B00',
  'character-2': '#00D9A3',
  'character-3': '#FFC400',
  'character-4': '#8B7BFF',
  'character-5': '#FF4FA3',
  'character-6': '#3BB0FF',
} as const

export type CharacterColorToken = keyof typeof CHARACTER_COLORS

export function characterColor(token: string): string {
  const palette: Record<string, string> = CHARACTER_COLORS
  return palette[token] ?? CHARACTER_COLORS['character-1']
}

/** `#FF3B00` → `0xFF3B00`, que é o formato aceito pelos filtros do ffmpeg. */
export function toFfmpegColor(hex: string): string {
  return `0x${hex.replace('#', '').toUpperCase()}`
}

/**
 * Padrões visuais que acompanham a cor. Renderizados como textura de fundo no
 * badge do personagem, para que a distinção sobreviva a daltonismo e a
 * capturas em preto e branco.
 */
export const CHARACTER_PATTERNS = ['solid', 'stripes', 'dots', 'grid'] as const
export type CharacterPattern = (typeof CHARACTER_PATTERNS)[number]
