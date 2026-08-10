import {
  DIFFICULTY_LABELS,
  formatSeconds,
  type SceneSummary,
  WORK_TYPE_LABELS,
} from '@dubla/shared'
import { cn } from '../lib/cn'
import { Tag } from './tag'

export interface SceneCardProps {
  readonly scene: SceneSummary
  readonly href: string
  readonly mediaBaseUrl: string
  readonly className?: string
}

/**
 * Cartão de cena.
 *
 * O bloco inteiro é o alvo de clique via `::after` no link do título, o que
 * mantém um único elemento focável por cartão — vários links para o mesmo
 * destino tornam a navegação por teclado e leitor de tela repetitiva.
 */
export function SceneCard({ scene, href, mediaBaseUrl, className }: SceneCardProps) {
  return (
    <article
      className={cn(
        'group relative flex flex-col border-2 border-ink bg-paper',
        'transition-[transform,box-shadow] duration-100 ease-snap',
        'hover:-translate-x-[3px] hover:-translate-y-[3px] hover:shadow-hard',
        'focus-within:-translate-x-[3px] focus-within:-translate-y-[3px] focus-within:shadow-hard',
        className,
      )}
    >
      <div className="relative aspect-video overflow-hidden border-b-2 border-ink bg-ink">
        {scene.thumbnailKey ? (
          <img
            src={`${mediaBaseUrl}/${scene.thumbnailKey}`}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : null}
        <span className="absolute bottom-2 right-2 border border-paper bg-ink px-1.5 py-0.5 font-display text-xs text-paper">
          {formatSeconds(scene.durationMs)}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-2 p-4">
        <p className="font-body text-[0.6875rem] font-bold uppercase tracking-[0.16em] text-muted">
          {scene.workTitle}
        </p>
        <h3 className="font-display text-xl uppercase leading-[0.95]">
          <a href={href} className="after:absolute after:inset-0 after:content-['']">
            {scene.title}
          </a>
        </h3>
        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-2">
          <Tag>{WORK_TYPE_LABELS[scene.workType]}</Tag>
          <Tag tone={scene.difficulty === 'insane' ? 'danger' : 'neutral'}>
            {DIFFICULTY_LABELS[scene.difficulty]}
          </Tag>
          <Tag>
            {scene.characterCount === 1
              ? '1 personagem'
              : `${String(scene.characterCount)} personagens`}
          </Tag>
        </div>
      </div>
    </article>
  )
}
