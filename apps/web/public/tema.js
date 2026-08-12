/**
 * Aplica o tema antes da primeira pintura.
 *
 * Fica num arquivo servido pela própria origem, e não embutido no HTML: a
 * política do projeto proíbe `dangerouslySetInnerHTML` (SECURITY.md §2) e a CSP
 * só permite script de `self`. Sem este passo a página nasce clara e pisca para
 * escura quando o React monta.
 */
;(function () {
  try {
    var escolha = localStorage.getItem('dublaai:tema') || 'system'
    var escuro =
      escolha === 'dark' ||
      (escolha === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.dataset.theme = escuro ? 'dark' : 'light'
  } catch (_) {
    // Sem localStorage (aba privada restrita), o tema claro do CSS já vale.
  }
})()
