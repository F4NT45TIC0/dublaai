/**
 * Código de partida do modo online.
 *
 * Por que não são 6 dígitos: o código é a ÚNICA coisa que protege as gravações
 * de voz de uma partida. Com 6 dígitos, alguém percorre o milhão de combinações
 * em minutos e baixa a voz de estranhos — e voz é dado sensível (SECURITY §42).
 * Com 12 caracteres em base 32 são 2^60 combinações: força bruta deixa de ser
 * um problema de paciência.
 *
 * O alfabeto é o de Crockford, sem I, L, O e U. Isso resolve o "é um zero ou um
 * ó?" de quem lê o código em voz alta ou digita do print — e as trocas mais
 * comuns são desfeitas na normalização em vez de virarem "partida não
 * encontrada".
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 12
const GROUP_SIZE = 4

/** Gera um código novo. `crypto` é obrigatório: `Math.random` não é segredo. */
export function createMatchCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH)
  crypto.getRandomValues(bytes)

  let code = ''
  for (const byte of bytes) {
    // O viés de 256 % 32 é zero, então o módulo aqui é uniforme de verdade.
    // `charAt` em vez de índice: o módulo garante que está dentro do alfabeto,
    // e o tipo não precisa de um fallback que nunca aconteceria.
    code += ALPHABET.charAt(byte % ALPHABET.length)
  }
  return formatMatchCode(code)
}

/** `K7M29XQP4TVB` → `K7M2-9XQP-4TVB`. */
export function formatMatchCode(code: string): string {
  const groups: string[] = []
  for (let index = 0; index < code.length; index += GROUP_SIZE) {
    groups.push(code.slice(index, index + GROUP_SIZE))
  }
  return groups.join('-')
}

/**
 * Aceita o código como a pessoa digitou e devolve a forma canônica.
 *
 * Hífens, espaços e minúsculas são ruído de digitação. I/L viram 1 e O vira 0
 * porque são exatamente as confusões que o alfabeto de Crockford prevê.
 * Devolve `null` quando não sobra um código válido — nunca um palpite.
 */
export function normalizeMatchCode(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')

  if (cleaned.length !== CODE_LENGTH) return null
  for (const character of cleaned) {
    if (!ALPHABET.includes(character)) return null
  }
  return cleaned
}

/** Forma usada em caminho de armazenamento: canônica, sem hífen. */
export function storageKeyFor(code: string): string | null {
  return normalizeMatchCode(code)
}
