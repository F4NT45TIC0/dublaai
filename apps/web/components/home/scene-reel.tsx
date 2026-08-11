/**
 * A fita da cena, em repouso.
 *
 * É o mesmo objeto que a pessoa vai manipular dublando: uma cena é uma fita de
 * falas, e dublar é preencher as células. Mostrar isso na home explica o
 * produto sem uma linha de texto — e prepara o reconhecimento de quando a fita
 * de verdade aparecer na tela de dublagem.
 *
 * É decorativa: quem usa leitor de tela recebe a explicação em texto ao lado,
 * não uma leitura célula a célula de algo que ainda não existe.
 */
const CELULAS = [
  { fala: 'Ao infinito', nota: 91 },
  { fala: 'e além', nota: 78 },
  { fala: 'Você é um brinquedo', nota: 84 },
  { fala: 'Do que você está falando?', nota: null },
  { fala: 'Eu sou o Buzz Lightyear', nota: null },
] as const

export function SceneReel() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-1 select-none">
      {CELULAS.map((celula, index) => (
        <div key={celula.fala} className="flex items-stretch gap-1">
          {/* Perfurações: é isso que faz o objeto ler como filme, e não como lista. */}
          <div className="flex w-4 flex-col justify-around border-2 border-ink py-1">
            <span className="mx-auto block h-1.5 w-1.5 bg-ink" />
            <span className="mx-auto block h-1.5 w-1.5 bg-ink" />
          </div>

          <div
            className={`flex min-w-0 flex-1 items-center gap-3 border-2 border-ink px-3 py-2 ${
              celula.nota === null ? 'bg-paper' : 'bg-ink text-paper'
            }`}
          >
            <span className="font-body text-[0.625rem] font-bold tabular-nums opacity-60">
              {String(index + 1).padStart(2, '0')}
            </span>
            <span className="min-w-0 flex-1 truncate font-display text-sm uppercase tracking-tight sm:text-base">
              {celula.fala}
            </span>
            <span
              className={`font-display text-lg tabular-nums ${
                celula.nota === null ? 'text-muted' : 'text-accent'
              }`}
            >
              {celula.nota ?? '·'}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}
