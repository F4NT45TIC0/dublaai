import type { Metadata } from 'next'
import { LocalVideoDubber } from '@/components/upload/local-video-dubber'

export const metadata: Metadata = {
  title: 'Dublar arquivo ou URL',
  description:
    'Envie um vídeo local ou uma URL direta, acompanhe as formas de onda, grave sua voz e baixe a cena dublada.',
}

export default function UploadPage() {
  return (
    <div className="mx-auto w-full max-w-[100rem] px-4 sm:px-8">
      <header className="border-b-2 border-ink py-10 sm:py-16">
        <p className="font-display text-sm uppercase tracking-[0.2em] text-accent">
          Arquivo ou URL direta
        </p>
        <h1 className="mt-3 max-w-5xl font-display text-giant uppercase">
          Duble a sua própria cena
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed opacity-80">
          Escolha um vídeo de até 1 minuto no computador ou cole uma URL direta. Extraímos a
          referência sonora, mostramos a forma de onda, pontuamos sua dublagem e liberamos o
          download — tudo no navegador.
        </p>
      </header>

      <section className="py-8 sm:py-12" aria-label="Enviar e dublar vídeo">
        <LocalVideoDubber />
      </section>
    </div>
  )
}
