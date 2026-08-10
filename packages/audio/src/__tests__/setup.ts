import { afterEach, vi } from 'vitest'

// jsdom não implementa rAF de forma útil para testes determinísticos: os
// callbacks ficariam presos ao relógio real. Aqui o tempo é controlado pelo
// teste, que é o que permite afirmar coisas sobre sincronização.
afterEach(() => {
  vi.restoreAllMocks()
})
