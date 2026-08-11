import type { Metadata } from 'next'
import { LocalVideoDubber } from '@/components/upload/local-video-dubber'

export const metadata: Metadata = {
  title: 'Multiplayer',
  description:
    'Crie uma partida de dublagem com um vídeo, compartilhe o código e reveze as falas com outra pessoa.',
}

export default function MultiplayerPage() {
  return (
    <div className="mx-auto w-full max-w-[100rem] px-4 sm:px-8">
      <section className="py-6 sm:py-10" aria-label="Partida multiplayer de dublagem">
        <LocalVideoDubber experience="multiplayer" />
      </section>
    </div>
  )
}
