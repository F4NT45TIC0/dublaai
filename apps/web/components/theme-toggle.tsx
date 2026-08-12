'use client'

import { useEffect, useState } from 'react'

export type ThemeChoice = 'light' | 'dark' | 'system'

export const THEME_STORAGE_KEY = 'dublaai:tema'

const OPCOES: readonly { readonly value: ThemeChoice; readonly rotulo: string }[] = [
  { value: 'light', rotulo: 'Claro' },
  { value: 'dark', rotulo: 'Escuro' },
  { value: 'system', rotulo: 'Sistema' },
]

function aplicar(escolha: ThemeChoice): void {
  const escuroDoSistema = window.matchMedia('(prefers-color-scheme: dark)').matches
  const efetivo = escolha === 'system' ? (escuroDoSistema ? 'dark' : 'light') : escolha
  document.documentElement.dataset['theme'] = efetivo
}

/**
 * Claro, escuro ou o que o sistema mandar.
 *
 * O ícone é um disco que gira e troca de preenchimento — sol cheio no claro,
 * lua vazada no escuro, metade e metade no sistema. A animação é curta e
 * respeita `prefers-reduced-motion` pela regra global: ela existe para dar
 * retorno ao toque, não para chamar atenção.
 *
 * Os três estados ficam num `radiogroup` de verdade, e não num botão que
 * cicla: com um botão cíclico não há como saber qual é o estado atual sem
 * clicar, nem chegar direto no que se quer.
 */
export function ThemeToggle() {
  const [escolha, setEscolha] = useState<ThemeChoice>('system')
  const [montado, setMontado] = useState(false)

  useEffect(() => {
    const guardado = localStorage.getItem(THEME_STORAGE_KEY)
    const inicial: ThemeChoice =
      guardado === 'light' || guardado === 'dark' || guardado === 'system' ? guardado : 'system'
    setEscolha(inicial)
    setMontado(true)
  }, [])

  // Em "sistema", trocar o tema do aparelho precisa refletir na hora, sem
  // recarregar — é o que a pessoa espera de quem escolheu seguir o sistema.
  useEffect(() => {
    if (!montado) return
    aplicar(escolha)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, escolha)
    } catch {
      // Sem espaço para guardar não pode impedir de trocar o tema agora.
    }
    if (escolha !== 'system') return

    const consulta = window.matchMedia('(prefers-color-scheme: dark)')
    const aoTrocar = () => {
      aplicar('system')
    }
    consulta.addEventListener('change', aoTrocar)
    return () => {
      consulta.removeEventListener('change', aoTrocar)
    }
  }, [escolha, montado])

  return (
    <div
      role="radiogroup"
      aria-label="Tema da interface"
      data-testid="theme-toggle"
      className="flex items-center gap-0.5 border-2 border-ink p-0.5"
    >
      {OPCOES.map((opcao) => {
        const ativo = montado && escolha === opcao.value
        return (
          <button
            key={opcao.value}
            type="button"
            role="radio"
            aria-checked={ativo}
            title={opcao.rotulo}
            data-testid={`tema-${opcao.value}`}
            onClick={() => {
              setEscolha(opcao.value)
            }}
            className={`flex h-9 w-9 items-center justify-center transition-colors duration-150 ${
              ativo ? 'bg-ink text-paper' : 'text-ink hover:bg-ink/10'
            }`}
          >
            <span className="sr-only">{opcao.rotulo}</span>
            <ThemeGlyph choice={opcao.value} active={ativo} />
          </button>
        )
      })}
    </div>
  )
}

/**
 * O mesmo disco em três estados.
 *
 * Desenhar os três com a mesma geometria faz a troca parecer um giro do mesmo
 * objeto, e não três ícones diferentes piscando no lugar um do outro.
 */
function ThemeGlyph({ choice, active }: { choice: ThemeChoice; active: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={`h-5 w-5 transition-transform duration-300 ease-snap ${
        active ? 'rotate-0 scale-110' : 'rotate-[-20deg] scale-100'
      }`}
    >
      {choice === 'light' ? (
        <>
          <circle cx="12" cy="12" r="5" fill="currentColor" />
          {[0, 45, 90, 135, 180, 225, 270, 315].map((angulo) => (
            <line
              key={angulo}
              x1="12"
              y1="1.5"
              x2="12"
              y2="4.5"
              stroke="currentColor"
              strokeWidth="2"
              transform={`rotate(${String(angulo)} 12 12)`}
            />
          ))}
        </>
      ) : choice === 'dark' ? (
        // Lua como recorte do mesmo disco: um círculo mordido por outro.
        <path
          d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"
          fill="currentColor"
        />
      ) : (
        <>
          <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" />
        </>
      )}
    </svg>
  )
}
