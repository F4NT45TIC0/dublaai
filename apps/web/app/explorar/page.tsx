import type { Metadata } from 'next'
import Link from 'next/link'
import {
  DIFFICULTY_LABELS,
  DIFFICULTIES,
  DURATION_BUCKETS,
  type SceneSummary,
  type SceneDifficulty,
  WORK_TYPE_LABELS,
  WORK_TYPES,
  type WorkType,
} from '@dubla/shared'
import { EmptyState, SceneCard } from '@dubla/ui'
import { getSummaries, MEDIA_BASE_URL } from '@/lib/catalog'

export const metadata: Metadata = {
  title: 'Explorar',
  description: 'Encontre uma cena para dublar: filtre por tipo, duração, dificuldade e personagens.',
}

type SearchParams = Record<string, string | string[] | undefined>

function first(params: SearchParams, key: string): string | undefined {
  const value = params[key]
  return Array.isArray(value) ? value[0] : value
}

/**
 * Filtros no servidor, via query string.
 *
 * Isso mantém cada combinação de filtros endereçável e compartilhável, deixa a
 * página funcionando sem JavaScript, e evita mandar o catálogo inteiro para o
 * cliente só para filtrá-lo lá.
 */
export default async function ExplorePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const type = first(params, 'tipo')
  const difficulty = first(params, 'dificuldade')
  const duration = first(params, 'duracao')
  const cast = first(params, 'personagens')

  const scenes = getSummaries().filter((scene) => {
    if (type && scene.workType !== type) return false
    if (difficulty && scene.difficulty !== difficulty) return false
    if (duration) {
      const bucket = DURATION_BUCKETS.find((entry) => entry.id === duration)
      if (bucket && (scene.durationMs < bucket.minMs || scene.durationMs > bucket.maxMs)) {
        return false
      }
    }
    if (cast === '3' && scene.characterCount < 3) return false
    if (cast && cast !== '3' && scene.characterCount !== Number(cast)) return false
    return true
  })

  return (
    <div className="mx-auto w-full max-w-[100rem] px-4 py-10 sm:px-8">
      <h1 className="font-display text-giant uppercase">Explorar</h1>
      <p className="mt-3 max-w-prose text-base opacity-75">
        {scenes.length === 1
          ? '1 cena disponível'
          : `${String(scenes.length)} cenas disponíveis`}
      </p>

      <div className="mt-8 flex flex-col gap-5 border-y-2 border-ink py-6">
        <FilterGroup
          label="Tipo"
          param="tipo"
          current={type}
          params={params}
          options={WORK_TYPES.map((value: WorkType) => ({
            value,
            label: WORK_TYPE_LABELS[value],
          }))}
        />
        <FilterGroup
          label="Duração"
          param="duracao"
          current={duration}
          params={params}
          options={DURATION_BUCKETS.map((bucket) => ({ value: bucket.id, label: bucket.label }))}
        />
        <FilterGroup
          label="Dificuldade"
          param="dificuldade"
          current={difficulty}
          params={params}
          options={DIFFICULTIES.map((value: SceneDifficulty) => ({
            value,
            label: DIFFICULTY_LABELS[value],
          }))}
        />
        <FilterGroup
          label="Personagens"
          param="personagens"
          current={cast}
          params={params}
          options={[
            { value: '1', label: '1' },
            { value: '2', label: '2' },
            { value: '3', label: '3+' },
          ]}
        />
      </div>

      {scenes.length === 0 ? (
        <EmptyState
          className="mt-12"
          title="Nenhuma cena com esses filtros"
          description="Tente afrouxar algum filtro — o catálogo ainda está crescendo."
          action={
            <Link
              href="/explorar"
              className="border-2 border-ink px-4 py-2 font-display uppercase hover:bg-ink hover:text-paper"
            >
              Limpar filtros
            </Link>
          }
        />
      ) : (
        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {scenes.map((scene: SceneSummary) => (
            <SceneCard
              key={scene.id}
              scene={scene}
              href={`/cena/${scene.slug}`}
              mediaBaseUrl={MEDIA_BASE_URL}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function FilterGroup({
  label,
  param,
  current,
  params,
  options,
}: {
  label: string
  param: string
  current: string | undefined
  params: SearchParams
  options: readonly { value: string; label: string }[]
}) {
  const href = (value: string | null): string => {
    const next = new URLSearchParams()
    for (const [key, raw] of Object.entries(params)) {
      const single = Array.isArray(raw) ? raw[0] : raw
      if (single && key !== param) next.set(key, single)
    }
    if (value !== null) next.set(param, value)
    const query = next.toString()
    return query.length > 0 ? `/explorar?${query}` : '/explorar'
  }

  return (
    <fieldset>
      <legend className="font-body text-[0.6875rem] font-bold uppercase tracking-[0.16em] text-muted">
        {label}
      </legend>
      <div className="mt-2 flex flex-wrap gap-2">
        <FilterLink href={href(null)} active={current === undefined}>
          Todos
        </FilterLink>
        {options.map((option) => (
          <FilterLink key={option.value} href={href(option.value)} active={current === option.value}>
            {option.label}
          </FilterLink>
        ))}
      </div>
    </fieldset>
  )
}

function FilterLink({
  href,
  active,
  children,
}: {
  href: string
  active: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'true' : undefined}
      className={`inline-flex min-h-11 items-center border-2 border-ink px-3 font-display text-xs uppercase tracking-widest transition-colors ${
        active ? 'bg-ink text-paper' : 'bg-paper hover:bg-paper-dim'
      }`}
    >
      {children}
    </Link>
  )
}
