import { catalogSchema, type SceneDetail, type SceneSummary } from '@dubla/shared'
import catalogSource from '../content/catalog.json'

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
 * O catálogo é IMPORTADO, não lido do disco em runtime.
 *
 * A versão anterior montava o caminho com `process.cwd()`, o que amarrava a
 * aplicação ao diretório de onde o processo foi iniciado: rodar `next start` a
 * partir da raiz do monorepo — como o Playwright faz — resolvia para
 * `<raiz>/content/catalog.json`, que não existe, e derrubava `/explorar` em
 * runtime enquanto as páginas pré-renderizadas continuavam funcionando. Um
 * import estático não tem cwd: o bundler resolve em build e o arquivo viaja
 * junto.
 */
let cache: readonly SceneDetail[] | null = null

function loadCatalog(): readonly SceneDetail[] {
  if (cache) return cache

  const parsed = catalogSchema.safeParse(catalogSource)
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
