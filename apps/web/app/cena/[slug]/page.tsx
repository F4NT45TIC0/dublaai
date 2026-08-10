import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
  DIFFICULTY_LABELS,
  formatTimecode,
  WORK_TYPE_LABELS,
} from '@dubla/shared'
import { Tag } from '@dubla/ui'
import { getPublishedScenes, getSceneBySlug, mediaUrl } from '@/lib/catalog'
import { SceneStage } from '@/components/scene/scene-stage'

export function generateStaticParams() {
  return getPublishedScenes().map((scene) => ({ slug: scene.slug }))
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const scene = getSceneBySlug(slug)
  if (!scene) return { title: 'Cena não encontrada' }

  return {
    title: `${scene.title} — ${scene.work.title}`,
    description: scene.description ?? `Duble a cena "${scene.title}" de ${scene.work.title}.`,
    openGraph: {
      title: `${scene.title} — ${scene.work.title}`,
      description: scene.description ?? '',
      images: scene.thumbnailKey ? [{ url: mediaUrl(scene.thumbnailKey) }] : [],
    },
  }
}

export default async function ScenePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const scene = getSceneBySlug(slug)
  if (!scene) notFound()

  return (
    <div className="surface-dark min-h-full">
      <div className="mx-auto w-full max-w-[72rem] px-4 py-8 sm:px-8 sm:py-12">
        <nav aria-label="Trilha" className="mb-6">
          <Link
            href="/explorar"
            className="font-display text-xs uppercase tracking-[0.16em] text-muted hover:text-paper"
          >
            ← Explorar
          </Link>
        </nav>

        <header className="mb-8">
          <p className="font-body text-[0.6875rem] font-bold uppercase tracking-[0.16em] text-muted">
            {scene.work.title}
          </p>
          <h1 className="mt-2 font-display text-giant uppercase">{scene.title}</h1>
          {scene.description ? (
            <p className="mt-4 max-w-prose text-base leading-relaxed opacity-75">
              {scene.description}
            </p>
          ) : null}

          <div className="mt-5 flex flex-wrap gap-2">
            <Tag>{WORK_TYPE_LABELS[scene.work.type]}</Tag>
            <Tag tone={scene.difficulty === 'insane' ? 'danger' : 'neutral'}>
              {DIFFICULTY_LABELS[scene.difficulty]}
            </Tag>
            <Tag>{formatTimecode(scene.durationMs)}</Tag>
            <Tag>
              {scene.characterCount === 1
                ? '1 personagem'
                : `${String(scene.characterCount)} personagens`}
            </Tag>
            <Tag>
              {scene.speakerSegments.length === 1
                ? '1 fala'
                : `${String(scene.speakerSegments.length)} falas`}
            </Tag>
          </div>
        </header>

        <SceneStage
          scene={scene}
          videoUrl={mediaUrl(scene.videoKey)}
          referenceAudioUrl={mediaUrl(scene.referenceAudioKey)}
          {...(scene.thumbnailKey === undefined
            ? {}
            : { posterUrl: mediaUrl(scene.thumbnailKey) })}
          featuresUrl={mediaUrl(scene.featuresKey)}
        />

        <footer className="mt-12 border-t-2 border-ink-line pt-6 text-xs text-muted">
          <p>
            {scene.rights.source} · Licença: {scene.rights.licenseType} · Detentor:{' '}
            {scene.rights.owner}
          </p>
        </footer>
      </div>
    </div>
  )
}
