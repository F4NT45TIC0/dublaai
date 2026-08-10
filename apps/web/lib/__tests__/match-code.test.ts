import { describe, expect, it } from 'vitest'
import { createMatchCode, formatMatchCode, normalizeMatchCode } from '../match-code'

describe('createMatchCode', () => {
  it('gera 12 caracteres agrupados de quatro em quatro', () => {
    const code = createMatchCode()
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
  })

  it('nunca usa as letras que se confundem com números', () => {
    // 200 códigos: se I, L, O ou U pudessem sair, sairiam aqui.
    for (let index = 0; index < 200; index += 1) {
      expect(createMatchCode()).not.toMatch(/[ILOU]/)
    }
  })

  it('não repete — é o que separa uma partida da outra', () => {
    const codes = new Set(Array.from({ length: 500 }, () => createMatchCode()))
    expect(codes.size).toBe(500)
  })
})

describe('normalizeMatchCode', () => {
  it('aceita o código como a pessoa recebeu no chat', () => {
    expect(normalizeMatchCode('K7M2-9XQP-4TVB')).toBe('K7M29XQP4TVB')
  })

  it('perdoa minúscula, espaço e hífen a mais', () => {
    expect(normalizeMatchCode(' k7m2 9xqp-4tvb ')).toBe('K7M29XQP4TVB')
  })

  it('desfaz as confusões que o alfabeto prevê', () => {
    // Quem digitou "I" e "O" quis dizer 1 e 0.
    expect(normalizeMatchCode('K7MI-9XQP-4TVO')).toBe('K7M19XQP4TV0')
  })

  it('recusa em vez de adivinhar', () => {
    expect(normalizeMatchCode('K7M2-9XQP')).toBeNull()
    expect(normalizeMatchCode('')).toBeNull()
    expect(normalizeMatchCode('K7M2-9XQP-4TVB-EXTRA')).toBeNull()
  })

  it('o código recém-criado passa pela própria normalização', () => {
    const code = createMatchCode()
    const normalized = normalizeMatchCode(code)
    expect(normalized).not.toBeNull()
    expect(formatMatchCode(normalized ?? '')).toBe(code)
  })
})
