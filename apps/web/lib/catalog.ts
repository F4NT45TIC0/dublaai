import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { catalogSchema, type SceneDetail, type SceneSummary } from '@dubla/shared'

/**
 * Catálogo de cenas.
 *
 * Nas Fases 0–4 vem de `apps/web/content/catalog.json`, produzido por
 * `pnpm content:build`. Na Fase 5 passa a vir do Postgres — e como o tipo
 * devolvido é o mesmo `SceneDetail`, nenhuma página muda (ADR 0006).
 *
 * O JSON é validado mesmo sendo "nosso": ele é gerado por um script que pode
 * ter um bug, e um `startMs` fora da duração produziria score errado em vez de
 * erro visível (§80).
 *
 * O caminho fica dentro da própria app e é montado a partir de literais, para
 * que o bundler consiga rastreá-lo em vez de incluir o projeto inteiro na saída.
 */
const CATALOG_PATH = join(process.cwd(), 'content', 'catalog.json')

let cache: readonly SceneDetail[] | null = null

function loadCatalog(): readonly SceneDetail[] {
  if (cache) return cache

  let raw: string
  try {
    raw = readFileSync(CATALOG_PATH, 'utf8')
  } catch {
    throw new Error(
      'Catálogo não encontrado. Rode `pnpm content:build` para gerar as cenas — ' +
        'a mídia não é versionada porque é reconstruível a partir de content/scenes.',
    )
  }

  const parsed = catalogSchema.safeParse(JSON.parse(raw) as unknown)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 10)
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    throw new Error(`Catálogo inválido:\n${issues}`)
  }

  cache = parsed.data
  return cache
}

/** Apenas cenas publicadas chegam ao público (§84). */
export function getPublishedScenes(): readonly SceneDetail[] {
  return loadCatalog().filter((scene) => scene.status === 'published')
}

export function getSceneBySlug(slug: string): SceneDetail | null {
  return getPublishedScenes().find((scene) => scene.slug === slug) ?? null
}

export function toSummary(scene: SceneDetail): SceneSummary {
  return {
    id: scene.id,
    slug: scene.slug,
    title: scene.title,
    workTitle: scene.work.title,
    workType: scene.work.type,
    durationMs: scene.durationMs,
    difficulty: scene.difficulty,
    characterCount: scene.characterCount,
    ...(scene.thumbnailKey === undefined ? {} : { thumbnailKey: scene.thumbnailKey }),
  }
}

export function getSummaries(): readonly SceneSummary[] {
  return getPublishedScenes().map(toSummary)
}

export const MEDIA_BASE_URL = process.env['NEXT_PUBLIC_MEDIA_BASE_URL'] ?? '/media'

export function mediaUrl(key: string): string {
  return `${MEDIA_BASE_URL}/${key}`
}
