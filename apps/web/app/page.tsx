import Link from 'next/link'
import { Button, SceneCard } from '@dubla/ui'
import { getSummaries, MEDIA_BASE_URL } from '@/lib/catalog'

export default function HomePage() {
  const scenes = getSummaries()
  const featured = scenes[0]
  const trending = scenes.slice(0, 4)
  const shortest = [...scenes].sort((a, b) => a.durationMs - b.durationMs).slice(0, 4)

  return (
    <div className="mx-auto w-full max-w-[100rem] px-4 sm:px-8">
      <section className="border-b-2 border-ink py-12 sm:py-20">
        <h1 className="font-display text-mega leading-none uppercase">
          Dubla
          <br />
          Aí
        </h1>

        <p className="mt-6 max-w-2xl font-display text-title uppercase leading-[0.95]">
          Você acha que dubla melhor que o original?
        </p>

        <p className="mt-5 max-w-prose text-lg leading-relaxed opacity-80">
          Escolha uma cena, aperte gravar e fale junto. A gente mostra onde você entrou na hora,
          onde correu e o quanto sua voz chegou perto — sem inventar nota.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-4">
          {featured ? (
            <Button asChild size="hero">
              <Link href={`/cena/${featured.slug}`}>Começar a dublar</Link>
            </Button>
          ) : null}
          <Button asChild size="hero" variant="secondary">
            <Link href="/explorar">Ver todas as cenas</Link>
          </Button>
          <Button asChild size="hero" variant="secondary">
            <Link href="/enviar">Dublar meu vídeo</Link>
          </Button>
        </div>

        <p className="mt-6 font-display text-sm uppercase tracking-[0.2em] text-muted">
          Dá o play. A voz é sua.
        </p>
      </section>

      <SceneRow title="Em alta" scenes={trending} />
      <SceneRow title="Comece por aqui" scenes={shortest} subtitle="As cenas mais curtas" />

      <section className="border-b-2 border-ink py-12">
        <h2 className="font-display text-giant uppercase">Como funciona</h2>
        <ol className="mt-8 grid gap-6 sm:grid-cols-3">
          {[
            { n: '01', t: 'Veja', d: 'A cena roda sem áudio, com a legenda e a referência na tela.' },
            { n: '02', t: 'Grave', d: 'Três, dois, um — e você fala junto com a cena.' },
            { n: '03', t: 'Ouça', d: 'Sua voz volta encaixada no vídeo, com o resultado ao lado.' },
          ].map((step) => (
            <li key={step.n} className="border-2 border-ink p-6">
              <p className="font-display text-5xl text-accent">{step.n}</p>
              <h3 className="mt-3 font-display text-2xl uppercase">{step.t}</h3>
              <p className="mt-2 text-base opacity-75">{step.d}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}

function SceneRow({
  title,
  subtitle,
  scenes,
}: {
  title: string
  subtitle?: string
  scenes: ReturnType<typeof getSummaries>
}) {
  if (scenes.length === 0) return null

  return (
    <section className="border-b-2 border-ink py-12">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-display text-giant uppercase">{title}</h2>
        {subtitle ? (
          <p className="font-body text-sm uppercase tracking-[0.16em] text-muted">{subtitle}</p>
        ) : null}
      </div>

      <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {scenes.map((scene) => (
          <SceneCard
            key={scene.id}
            scene={scene}
            href={`/cena/${scene.slug}`}
            mediaBaseUrl={MEDIA_BASE_URL}
          />
        ))}
      </div>
    </section>
  )
}
