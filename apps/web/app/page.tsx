import Link from 'next/link'
import { Button } from '@dubla/ui'
import { SceneReel } from '@/components/home/scene-reel'

/**
 * Home.
 *
 * O produto é um só: pegar um vídeo seu e dublar. Não há catálogo nem cena de
 * exemplo — qualquer desvio aqui atrasa a única coisa que a pessoa veio fazer.
 */
export default function HomePage() {
  return (
    <div className="mx-auto w-full max-w-[100rem] px-4 sm:px-8">
      <section className="grid gap-10 border-b-2 border-ink py-12 lg:grid-cols-[1.1fr_1fr] lg:items-center lg:gap-16 lg:py-20">
        <div>
          {/*
            Uma linha só, e por isso o tamanho vem daqui e não do token `mega`:
            aquele foi calibrado para "Dubla" e "Aí" empilhados e, numa linha,
            estouraria a coluna. O `clamp` acompanha a largura da tela, e o
            `nowrap` garante que a quebra nunca volte sozinha num tamanho
            intermediário.

            A entrelinha folgada resolve o acento do Í: em Anton os acentos
            sobem acima da altura de caixa e seriam cortados pelo limite do
            bloco.
          */}
          <h1 className="whitespace-nowrap font-display text-[clamp(2.75rem,8.5vw,7rem)] uppercase leading-[1.08] tracking-[-0.03em]">
            Dubla Aí
          </h1>

          <p className="mt-6 max-w-2xl font-display text-title uppercase leading-[0.95]">
            Traga um vídeo. A voz é sua.
          </p>

          <p className="mt-5 max-w-prose text-lg leading-relaxed opacity-80">
            Escolha uma cena do seu computador, fale por cima e baixe o resultado. A gente separa as
            falas, mostra onde você entrou na hora e o quanto sua voz chegou perto — sem inventar
            nota.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Button asChild size="hero">
              <Link href="/enviar">Começar a dublar</Link>
            </Button>
          </div>

          <p className="mt-6 font-display text-sm uppercase tracking-[0.2em] text-muted">
            Nada é enviado. Tudo acontece no seu aparelho.
          </p>
        </div>

        {/*
          O lado direito mostra o objeto central do produto — a cena como uma
          fita de falas, umas preenchidas, outras não. Explica o jogo antes de
          qualquer texto e é exatamente o que aparece na tela de dublagem.
        */}
        <div className="flex flex-col gap-3">
          <SceneReel />
          <p className="font-body text-[0.6875rem] uppercase tracking-[0.16em] text-muted">
            Uma cena é uma fita de falas. Dublar é preencher as células.
          </p>
        </div>
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
