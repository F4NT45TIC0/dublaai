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
      {/*
        O título mora dentro do componente porque some quando um vídeo entra:
        no celular ele custava meia tela acima do que a pessoa veio fazer.
      */}
      <section className="py-6 sm:py-10" aria-label="Enviar e dublar vídeo">
        <LocalVideoDubber />
      </section>
    </div>
  )
}
