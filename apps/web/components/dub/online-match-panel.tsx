'use client'

import { useState } from 'react'
import type { Character } from '@dubla/shared'
import { Button } from '@dubla/ui'
import { formatMatchCode } from '@/lib/match-code'
import {
  availableCharacters,
  isMatchReady,
  isPlayerPresent,
  progressByPlayer,
} from '@/lib/online-match'
import type { OnlineMatch, OnlineMatchScene } from '@/lib/use-online-match'

export interface OnlineMatchPanelProps {
  readonly match: OnlineMatch
  readonly scene: OnlineMatchScene
  readonly characters: readonly Character[]
  readonly videoId: string
  /** Entrega o vídeo já preparado neste aparelho. */
  readonly loadVideoBlob: () => Promise<Blob>
  readonly onLeave: () => void
}

function characterName(characters: readonly Character[], id: string): string {
  return characters.find((character) => character.id === id)?.name ?? id
}

/** Sala, escolha de voz e turno da experiência Multiplayer. */
export function OnlineMatchPanel({
  match,
  scene,
  characters,
  videoId,
  loadVideoBlob,
  onLeave,
}: OnlineMatchPanelProps) {
  const [name, setName] = useState('')
  const [characterId, setCharacterId] = useState('')
  const [copied, setCopied] = useState(false)

  const state = match.state

  if (!state) {
    const duasVozes = characters.length === 2
    return (
      <section
        className="flex flex-col gap-4 border-2 border-accent p-4"
        data-testid="online-setup"
        aria-label="Criar partida multiplayer"
      >
        <div>
          <p className="font-display text-sm uppercase tracking-[0.2em] text-accent">
            Vídeo pronto
          </p>
          <h3 className="mt-1 font-display text-2xl uppercase">Gerar o código da partida</h3>
          <p className="mt-2 text-sm text-muted">
            Este será o único vídeo da sala. Seu amigo entra apenas com o código e recebe a mesma
            cena automaticamente.
          </p>
        </div>

        {!duasVozes ? (
          <p className="border-2 border-warn px-3 py-2 text-sm text-warn" role="status">
            Para duas pessoas jogarem sem a partida travar, a cena precisa ter exatamente duas
            vozes. Em Ajustes da cena, reconheça as falas e escolha 2 personagens.
          </p>
        ) : null}

        <Button
          size="hero"
          data-testid="online-criar"
          disabled={match.busy || !duasVozes || match.playerId === ''}
          onClick={() => {
            const criar = async () => {
              const video = await loadVideoBlob()
              await match.create(scene, video)
            }
            void criar()
          }}
        >
          {match.uploadProgress !== null
            ? `Enviando vídeo… ${String(Math.round(match.uploadProgress))}%`
            : match.busy
              ? 'Criando sala…'
              : 'Gerar código da partida'}
        </Button>

        {match.error ? <MatchError message={match.error} /> : null}
      </section>
    )
  }

  const videoReady = state.videoShared === true || state.videoUrl !== undefined
  if (!videoReady) {
    const souAnfitriao = state.hostId === match.playerId
    const mesmoVideo = state.videoId === videoId
    return (
      <section
        className="flex flex-col gap-4 border-2 border-warn p-4"
        data-testid="online-video-pendente"
      >
        <h3 className="font-display text-xl uppercase">Partida {formatMatchCode(state.code)}</h3>
        <p className="text-sm text-muted" role="status">
          {souAnfitriao
            ? 'A sala está criada, mas o vídeo ainda não terminou de chegar. Ninguém consegue iniciar enquanto ele não estiver pronto.'
            : 'O anfitrião ainda está preparando o vídeo da sala.'}
        </p>
        {souAnfitriao ? (
          <>
            {!mesmoVideo ? (
              <p className="border-2 border-warn px-3 py-2 text-sm text-warn" role="alert">
                Este não é o arquivo usado para criar a sala. Reabra o vídeo correto ou saia e crie
                outra partida.
              </p>
            ) : null}
            <Button
              disabled={match.busy || !mesmoVideo}
              onClick={() => {
                const retry = async () => {
                  await match.shareVideo(await loadVideoBlob(), scene.videoName)
                }
                void retry()
              }}
            >
              {match.uploadProgress !== null
                ? `Enviando vídeo… ${String(Math.round(match.uploadProgress))}%`
                : match.busy
                  ? 'Enviando…'
                  : 'Tentar enviar o vídeo novamente'}
            </Button>
          </>
        ) : null}
        {match.error ? <MatchError message={match.error} /> : null}
        <Button variant="secondary" disabled={match.busy} onClick={onLeave}>
          Sair da partida
        </Button>
      </section>
    )
  }

  const livres = availableCharacters(state)
  const meuPersonagem = state.players.find((player) => player.id === match.playerId)

  if (!meuPersonagem) {
    return (
      <section
        className="flex flex-col gap-4 border-2 border-ink-line p-4"
        data-testid="online-escolher-personagem"
        aria-label="Escolher personagem"
      >
        <RoomCode code={state.code} copied={copied} onCopied={setCopied} />

        <div>
          <h3 className="font-display text-xl uppercase">Escolha sua voz</h3>
          <p className="mt-1 text-sm text-muted">
            Quando você confirmar, este aparelho fica pronto. A primeira fala só é liberada depois
            que as duas pessoas estiverem dentro da sala.
          </p>
        </div>

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

        <div className="grid gap-2 sm:grid-cols-2">
          {livres.map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={characterId === id}
              data-testid={`online-personagem-${id}`}
              onClick={() => {
                setCharacterId(id)
              }}
              className={`min-h-14 border-2 px-4 font-display text-sm uppercase tracking-widest ${
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
          <p className="text-sm text-muted">As duas vagas desta partida já estão ocupadas.</p>
        ) : null}

        <Button
          disabled={match.busy || characterId === ''}
          data-testid="online-confirmar-personagem"
          onClick={() => {
            void match.join(
              state.code,
              name.trim() === '' ? 'Jogador' : name.trim(),
              characterId,
              videoId,
            )
          }}
        >
          {match.busy ? 'Confirmando…' : 'Estou pronto'}
        </Button>

        {match.error ? <MatchError message={match.error} /> : null}

        <Button variant="secondary" disabled={match.busy} onClick={onLeave}>
          Voltar
        </Button>
      </section>
    )
  }

  const placar = progressByPlayer(state)
  const ready = isMatchReady(state)

  return (
    <section
      className="flex flex-col gap-4 border-2 border-ink-line p-4"
      data-testid="online-turno"
      aria-label="Partida multiplayer"
    >
      <RoomCode code={state.code} copied={copied} onCopied={setCopied} />

      <ul className="grid gap-2 sm:grid-cols-2" aria-label="Jogadores da sala">
        {state.players.map((player) => (
          <li key={player.id} className="flex flex-col gap-1 border-2 border-ink-line p-3">
            <span className="font-display uppercase">
              {player.id === match.playerId ? 'Você' : player.name}
            </span>
            <span className="text-xs text-muted">
              {characterName(characters, player.characterId)} · {placar[player.id] ?? 0} falas ·{' '}
              {!isPlayerPresent(player, state.updatedAt)
                ? 'Desconectado'
                : player.ready
                  ? 'Pronto'
                  : 'Preparando vídeo'}
            </span>
            {player.id !== match.playerId && !isPlayerPresent(player, state.updatedAt) ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={match.busy}
                data-testid="online-liberar-vaga"
                onClick={() => {
                  void match.reclaim(player.id)
                }}
              >
                Liberar vaga desconectada
              </Button>
            ) : null}
          </li>
        ))}
        {state.players.length < 2 ? (
          <li className="flex min-h-16 items-center border-2 border-dashed border-ink-line p-3 text-sm text-muted">
            Aguardando amigo
          </li>
        ) : null}
      </ul>

      {state.players.length < 2 ? (
        <p className="text-sm text-muted" role="status" data-testid="online-aguardando-dupla">
          Envie o código para a outra pessoa. A gravação fica bloqueada até ela entrar e ficar
          pronta.
        </p>
      ) : !ready ? (
        <p className="text-sm text-muted" role="status" data-testid="online-aguardando-prontos">
          As duas vagas estão ocupadas. Esperando o outro aparelho preparar o vídeo ou voltar à
          partida.
        </p>
      ) : match.complete ? (
        <p className="text-sm" role="status" data-testid="online-completa">
          Cena fechada. Ouça as duas vozes juntas aqui embaixo.
        </p>
      ) : match.myTurn ? (
        <p className="text-sm" role="status" data-testid="online-minha-vez">
          É a sua vez. Grave a fala destacada — a outra pessoa recebe assim que você enviar.
        </p>
      ) : (
        <p className="text-sm text-muted" role="status" data-testid="online-vez-do-outro">
          Esperando {match.waitingFor ?? 'a outra pessoa'} gravar. A tela muda sozinha quando chegar
          sua vez.
        </p>
      )}

      {!meuPersonagem.ready ? (
        <Button
          disabled={match.busy}
          onClick={() => {
            void match.ready()
          }}
        >
          Confirmar que estou pronto
        </Button>
      ) : null}

      {match.error ? <MatchError message={match.error} /> : null}

      <Button variant="secondary" onClick={onLeave} data-testid="online-sair">
        Sair da partida
      </Button>
    </section>
  )
}

function RoomCode({
  code,
  copied,
  onCopied,
}: {
  code: string
  copied: boolean
  onCopied: (copied: boolean) => void
}) {
  const formatted = formatMatchCode(code)
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-2 border-accent p-3">
      <p>
        <span className="block font-body text-[0.6875rem] font-bold uppercase tracking-[0.16em] text-muted">
          Código da partida
        </span>
        <strong
          className="font-display text-xl tracking-[0.12em] text-accent"
          data-testid="online-codigo-da-sala"
        >
          {formatted}
        </strong>
      </p>
      <Button
        variant="secondary"
        onClick={() => {
          void navigator.clipboard.writeText(formatted).then(() => {
            onCopied(true)
            window.setTimeout(() => {
              onCopied(false)
            }, 2_000)
          })
        }}
      >
        {copied ? 'Código copiado' : 'Copiar código'}
      </Button>
    </div>
  )
}

function MatchError({ message }: { message: string }) {
  return (
    <p className="border-2 border-warn px-3 py-2 text-xs text-warn" role="alert">
      {message}
    </p>
  )
}
