'use client'

import { useState } from 'react'
import type { Character } from '@dubla/shared'
import { Button, Tag } from '@dubla/ui'
import { formatMatchCode } from '@/lib/match-code'
import { availableCharacters, progressByPlayer } from '@/lib/online-match'
import type { OnlineMatch } from '@/lib/use-online-match'

export interface OnlineMatchPanelProps {
  readonly match: OnlineMatch
  readonly characters: readonly Character[]
  readonly videoName: string
  /** Entrega o vídeo aberto aqui, para subir junto com a partida. */
  readonly loadVideoBlob?: () => Promise<Blob | null>
  /** Abre neste aparelho o vídeo que veio da partida. */
  readonly onAdoptVideo?: (file: File) => void
}

function characterName(characters: readonly Character[], id: string): string {
  return characters.find((character) => character.id === id)?.name ?? id
}

/**
 * Criar ou entrar numa partida online.
 *
 * O aviso de que o áudio sai do aparelho fica ANTES do botão, não no rodapé:
 * em todo o resto do Dubla Aí nada é enviado, e essa é a única exceção. Quem
 * escolhe jogar online precisa saber disso antes de gravar, não depois.
 */
export function OnlineMatchPanel({
  match,
  characters,
  videoName,
  loadVideoBlob,
  onAdoptVideo,
}: OnlineMatchPanelProps) {
  const [codeInput, setCodeInput] = useState('')
  const [name, setName] = useState('')
  const [characterId, setCharacterId] = useState('')

  const state = match.state
  const livres = state ? availableCharacters(state) : []
  const meuPersonagem = state?.players.find((player) => player.id === match.playerId)

  if (!state) {
    return (
      <section
        className="flex flex-col gap-4 border-2 border-ink-line p-4"
        data-testid="online-setup"
        aria-label="Partida online"
      >
        <div>
          <h3 className="font-display text-lg uppercase">Jogar com um amigo à distância</h3>
          <p className="mt-1 text-sm text-muted">
            Só você precisa ter o vídeo: ele vai junto com a partida e a outra pessoa recebe
            automaticamente ao entrar com o código. As falas gravadas também viajam, para que cada
            um ouça a do outro antes de responder. Tudo some depois de 24 horas.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Button
            data-testid="online-criar"
            disabled={match.busy}
            onClick={() => {
              const criar = async () => {
                const video = loadVideoBlob ? await loadVideoBlob() : null
                await match.create(video ?? undefined)
              }
              void criar()
            }}
          >
            {match.busy ? 'Criando…' : 'Criar partida'}
          </Button>
          <p className="text-xs text-muted">
            Você recebe um código para mandar para quem vai jogar com você. Vídeos de até 200 MB
            vão junto; acima disso, a outra pessoa precisa abrir o mesmo arquivo.
          </p>
        </div>

        <div className="flex flex-col gap-2 border-t-2 border-ink-line pt-4">
          <label className="font-body text-[0.6875rem] font-bold uppercase tracking-[0.16em] text-muted">
            Recebeu um código?
          </label>
          <input
            type="text"
            value={codeInput}
            maxLength={20}
            placeholder="K7M2-9XQP-4TVB"
            data-testid="online-codigo"
            onChange={(event) => {
              setCodeInput(event.target.value)
            }}
            className="min-h-12 border-2 border-ink-line bg-ink-soft px-3 font-display text-lg uppercase tracking-[0.2em] text-paper placeholder:text-muted"
          />
          <Button
            variant="secondary"
            disabled={match.busy || codeInput.trim() === ''}
            data-testid="online-entrar-codigo"
            onClick={() => {
              // Só carrega a partida: a escolha do personagem acontece na tela
              // seguinte, já sabendo o que sobrou.
              void match.peek(codeInput)
            }}
          >
            Entrar na partida
          </Button>
        </div>

        {match.error ? (
          <p className="border-2 border-warn px-3 py-2 text-xs text-warn" role="alert">
            {match.error}
          </p>
        ) : null}
      </section>
    )
  }

  if (!meuPersonagem) {
    return (
      <section
        className="flex flex-col gap-4 border-2 border-ink-line p-4"
        data-testid="online-escolher-personagem"
        aria-label="Escolher personagem"
      >
        <div>
          <h3 className="font-display text-lg uppercase">Escolha sua voz</h3>
          <p className="mt-1 text-sm text-muted">
            Partida <strong>{formatMatchCode(state.code)}</strong> · {state.videoName}
          </p>
        </div>

        {state.videoShared && onAdoptVideo ? (
          <div className="flex flex-col gap-2 border-2 border-ink-line p-3">
            <p className="text-sm">
              Esta partida traz o vídeo. Baixe para dublar a mesma cena que a outra pessoa.
            </p>
            <Button
              variant="secondary"
              disabled={match.busy}
              data-testid="online-baixar-video"
              onClick={() => {
                const baixar = async () => {
                  const file = await match.pullVideo()
                  if (file) onAdoptVideo(file)
                }
                void baixar()
              }}
            >
              {match.busy ? 'Baixando…' : 'Baixar o vídeo da partida'}
            </Button>
          </div>
        ) : null}

        <label className="flex flex-col gap-1">
          <span className="font-body text-[0.6875rem] font-bold uppercase tracking-[0.16em] text-muted">
            Seu apelido
          </span>
          <input
            type="text"
            maxLength={40}
            value={name}
            placeholder="Como te chamam?"
            data-testid="online-apelido"
            onChange={(event) => {
              setName(event.target.value)
            }}
            className="min-h-11 border-2 border-ink-line bg-ink-soft px-3 font-body text-sm text-paper placeholder:text-muted"
          />
        </label>

        <div className="flex flex-wrap gap-2">
          {livres.map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={characterId === id}
              data-testid={`online-personagem-${id}`}
              onClick={() => {
                setCharacterId(id)
              }}
              className={`min-h-11 border-2 px-4 font-display text-sm uppercase tracking-widest ${
                characterId === id
                  ? 'border-accent bg-accent text-paper'
                  : 'border-ink-line text-muted hover:border-paper hover:text-paper'
              }`}
            >
              {characterName(characters, id)}
            </button>
          ))}
        </div>

        {livres.length === 0 ? (
          <p className="text-sm text-muted">
            Todos os personagens já têm dono. Peça para alguém sair ou crie outra partida.
          </p>
        ) : null}

        <Button
          disabled={match.busy || characterId === ''}
          data-testid="online-confirmar-personagem"
          onClick={() => {
            void match.join(state.code, name.trim() === '' ? 'Jogador' : name.trim(), characterId)
          }}
        >
          {match.busy ? 'Entrando…' : 'Entrar na cena'}
        </Button>

        {match.error ? (
          <p className="border-2 border-warn px-3 py-2 text-xs text-warn" role="alert">
            {match.error}
          </p>
        ) : null}
      </section>
    )
  }

  const placar = progressByPlayer(state)

  return (
    <section
      className="flex flex-col gap-3 border-2 border-ink-line p-4"
      data-testid="online-turno"
      aria-label="Partida online em andamento"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-lg uppercase">
          Partida {formatMatchCode(state.code)}
        </h3>
        <span className="font-body text-[0.6875rem] font-bold uppercase tracking-[0.16em] text-muted">
          {videoName}
        </span>
      </div>

      <ul className="flex flex-wrap gap-2">
        {state.players.map((player) => (
          <li key={player.id}>
            <Tag>
              {player.name} · {characterName(characters, player.characterId)} ·{' '}
              {placar[player.id] ?? 0}
            </Tag>
          </li>
        ))}
      </ul>

      {state.players.length < 2 ? (
        <p className="text-sm text-muted" role="status" data-testid="online-aguardando-dupla">
          Mande o código <strong>{formatMatchCode(state.code)}</strong> para a outra pessoa. A cena
          começa quando ela entrar.
        </p>
      ) : match.complete ? (
        <p className="text-sm" role="status" data-testid="online-completa">
          Cena fechada. Monte a cena completa aqui embaixo para ouvir as duas vozes juntas.
        </p>
      ) : match.myTurn ? (
        <p className="text-sm" role="status" data-testid="online-minha-vez">
          É a sua vez. Grave a fala destacada — a outra pessoa vai ouvir assim que você terminar.
        </p>
      ) : (
        <p className="text-sm text-muted" role="status" data-testid="online-vez-do-outro">
          Esperando {match.waitingFor ?? 'a outra pessoa'} gravar. A tela avisa quando voltar para
          você.
        </p>
      )}

      {match.error ? (
        <p className="border-2 border-warn px-3 py-2 text-xs text-warn" role="alert">
          {match.error}
        </p>
      ) : null}

      <Button variant="secondary" onClick={match.leave} data-testid="online-sair">
        Sair da partida
      </Button>
    </section>
  )
}
