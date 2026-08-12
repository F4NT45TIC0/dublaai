import type { Metadata, Viewport } from 'next'
import { Anton, Archivo } from 'next/font/google'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { ThemeToggle } from '@/components/theme-toggle'
import './globals.css'

// Auto-hospedadas pelo next/font: nenhuma requisição a terceiros em runtime,
// o que mantém a CSP fechada e elimina CLS de troca de fonte.
const anton = Anton({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-anton',
  display: 'swap',
})

const archivo = Archivo({
  subsets: ['latin'],
  variable: '--font-archivo',
  display: 'swap',
})

export const metadata: Metadata = {
  metadataBase: new URL(process.env['NEXT_PUBLIC_SITE_URL'] ?? 'http://localhost:3000'),
  title: {
    default: 'Dubla Aí',
    template: '%s · Dubla Aí',
  },
  description: 'Dá o play. A voz é sua. Duble cenas curtas e veja o quanto você chegou perto.',
  openGraph: {
    type: 'website',
    locale: 'pt_BR',
    siteName: 'Dubla Aí',
  },
}

export const viewport: Viewport = {
  themeColor: '#0F0E0C',
  // O usuário precisa poder ampliar. Travar o zoom é uma barreira de
  // acessibilidade, não uma decisão de design (§63).
  maximumScale: 5,
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR" className={`${anton.variable} ${archivo.variable}`} suppressHydrationWarning>
      <head>
        {/*
          O tema é aplicado antes da primeira pintura. Sem isto a página nasce
          clara e pisca para escura assim que o React monta — e esse flash é
          justamente o que faz o tema escuro parecer quebrado.
        */}
        <script src="/tema.js" />
      </head>
      <body className="flex min-h-dvh flex-col">
        <a
          href="#conteudo"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:border-2 focus:border-ink focus:bg-paper focus:px-4 focus:py-2 focus:font-display focus:uppercase"
        >
          Pular para o conteúdo
        </a>

        <header className="border-b-2 border-ink">
          <div className="mx-auto flex w-full max-w-[100rem] items-center justify-between gap-4 px-4 py-3 sm:px-8">
            <Link
              href="/"
              className="font-display text-xl uppercase tracking-tight sm:text-2xl"
              aria-label="Dubla Aí — página inicial"
            >
              Dubla&nbsp;Aí
            </Link>
            <nav aria-label="Principal" className="flex items-center gap-2">
              <ThemeToggle />
              <Link
                href="/multiplayer"
                className="border-2 border-ink px-3 py-1.5 font-display text-xs uppercase tracking-widest hover:bg-ink hover:text-paper sm:text-sm"
              >
                Multiplayer
              </Link>
              <Link
                href="/enviar"
                className="border-2 border-accent bg-accent px-3 py-1.5 font-display text-xs uppercase tracking-widest text-paper hover:border-ink hover:bg-ink sm:text-sm"
              >
                Meu vídeo
              </Link>
            </nav>
          </div>
        </header>

        <main id="conteudo" className="flex-1">
          {children}
        </main>

        <footer className="border-t-2 border-ink">
          <div className="mx-auto w-full max-w-[100rem] px-4 py-6 text-xs sm:px-8">
            <p className="max-w-prose opacity-70">
              Em Meu vídeo, seus arquivos ficam no aparelho. No Multiplayer, vídeo e falas são
              compartilhados somente dentro da partida. Use apenas material que você tenha o direito
              de usar.
            </p>
          </div>
        </footer>
      </body>
    </html>
  )
}
