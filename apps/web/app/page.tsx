import Link from 'next/link'
import { Button } from '@dubla/ui'

/**
 * Home.
 *
 * O produto é um só: pegar um vídeo seu e dublar. Não há catálogo, exploração
 * nem cena de exemplo — qualquer desvio aqui atrasa a única coisa que a pessoa
 * veio fazer.
 */
export default function HomePage() {
  return (
    <div className="mx-auto w-full max-w-[100rem] px-4 sm:px-8">
      <section className="border-b-2 border-ink py-12 sm:py-20">
        <h1 className="font-display text-mega uppercase leading-none">
          Dubla
          <br />
          Aí
        </h1>

        <p className="mt-6 max-w-2xl font-display text-title uppercase leading-[0.95]">
          Traga um vídeo. A voz é sua.
        </p>

        <p className="mt-5 max-w-prose text-lg leading-relaxed opacity-80">
          Escolha uma cena do seu computador, fale por cima e baixe o resultado. A gente mostra
          onde você entrou na hora, onde correu e o quanto sua voz chegou perto — sem inventar nota.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-4">
          <Button asChild size="hero">
            <Link href="/enviar">Começar a dublar</Link>
          </Button>
        </div>

        <p className="mt-6 font-display text-sm uppercase tracking-[0.2em] text-muted">
          Nada é enviado. Tudo acontece no seu aparelho.
        </p>
      </section>

      <section className="border-b-2 border-ink py-12">
        <h2 className="font-display text-giant uppercase">Como funciona</h2>
        <ol className="mt-8 grid gap-6 sm:grid-cols-3">
          {[
            {
              n: '01',
              t: 'Envie',
              d: 'Um MP4, WebM ou MOV do seu computador, ou o link direto de um vídeo.',
            },
            {
              n: '02',
              t: 'Grave',
              d: 'A cena roda sem o áudio original. Três, dois, um — e você fala junto.',
            },
            {
              n: '03',
              t: 'Baixe',
              d: 'Sua voz volta encaixada no vídeo, pronta para salvar e compartilhar.',
            },
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
