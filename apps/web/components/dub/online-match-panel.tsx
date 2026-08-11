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
        className="flex h-full min-h-[34rem] flex-col justify-between border-2 border-accent bg-ink p-4 min-w-0"
        data-testid="online-setup"
        aria-label="Criar partida multiplayer"
      >
        <div className="flex flex-col gap-3">
          <div>
            <p className="font-body text-[0.625rem] font-bold uppercase tracking-[0.18em] text-accent">
              Vídeo pronto
            </p>
            <h3 className="mt-1 font-display text-lg uppercase tracking-wide">Gerar código da partida</h3>
            <p className="mt-1.5 text-xs leading-relaxed text-muted">
              Este será o único vídeo da sala. Seu amigo entra apenas com o código e recebe a mesma
              cena automaticamente.
            </p>
          </div>

          {!duasVozes ? (
            <p className="border-2 border-warn px-3 py-2 text-xs text-warn" role="status">
              Para duas pessoas jogarem sem a partida travar, a cena precisa ter exatamente duas
              vozes. Em Ajustes da cena, reconheça as falas e escolha 2 personagens.
            </p>
          ) : null}
        </div>

        <div className="mt-auto flex flex-col gap-3 pt-4 border-t-2 border-ink-line">
          <Button
            size="md"
            className="w-full"
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
        </div>
      </section>
    )
  }

  const videoReady = state.videoShared === true || state.videoUrl !== undefined
  if (!videoReady) {
    const souAnfitriao = state.hostId === match.playerId
    const mesmoVideo = state.videoId === videoId
    return (
      <section
        className="flex h-full min-h-[34rem] flex-col justify-between border-2 border-warn bg-ink p-4 min-w-0"
        data-testid="online-video-pendente"
      >
        <div className="flex flex-col gap-3">
          <h3 className="font-display text-lg uppercase tracking-wide">Partida {formatMatchCode(state.code)}</h3>
          <p className="text-xs leading-relaxed text-muted" role="status">
            {souAnfitriao
              ? 'A sala está criada, mas o vídeo ainda não terminou de chegar. Ninguém consegue iniciar enquanto ele não estiver pronto.'
              : 'O anfitrião ainda está preparando o vídeo da sala.'}
          </p>
          {souAnfitriao && !mesmoVideo ? (
            <p className="border-2 border-warn px-3 py-2 text-xs text-warn" role="alert">
              Este não é o arquivo usado para criar a sala. Reabra o vídeo correto ou saia e crie
              outra partida.
            </p>
          ) : null}
        </div>

        <div className="mt-auto flex flex-col gap-3 pt-4 border-t-2 border-ink-line">
          {souAnfitriao ? (
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
          ) : null}
          {match.error ? <MatchError message={match.error} /> : null}
          <Button variant="secondary" disabled={match.busy} onClick={onLeave}>
            Sair da partida
          </Button>
        </div>
      </section>
    )
  }

  const livres = availableCharacters(state)
  const meuPersonagem = state.players.find((player) => player.id === match.playerId)

  if (!meuPersonagem) {
    return (
      <section
        className="flex h-full min-h-[34rem] flex-col justify-between border-2 border-ink-line bg-ink p-4 min-w-0"
        data-testid="online-escolher-personagem"
        aria-label="Escolher personagem"
      >
        <div className="flex flex-col gap-4">
          <RoomCode code={state.code} copied={copied} onCopied={setCopied} />

          <div>
            <h3 className="font-display text-base uppercase tracking-wide">Escolha sua voz</h3>
            <p className="mt-0.5 text-xs text-muted">
              A primeira fala é liberada quando os dois entrarem na sala.
            </p>
          </div>

          <label className="flex flex-col gap-1">
            <span className="font-body text-[0.625rem] font-bold uppercase tracking-[0.16em] text-muted">
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
              className="h-10 border-2 border-ink-line bg-ink-soft px-3 font-body text-xs text-paper placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </label>

          <div className="flex flex-col gap-2">
            {livres.map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={characterId === id}
                data-testid={`online-personagem-${id}`}
                onClick={() => {
                  setCharacterId(id)
                }}
                className={`flex min-h-11 items-center justify-between border-2 p-3 text-left transition-colors ${
                  characterId === id
                    ? 'border-accent bg-accent/10 border-l-4 border-l-accent text-paper'
                    : 'border-ink-line bg-ink-soft/20 text-muted hover:border-paper hover:text-paper'
                }`}
              >
                <span className="font-display text-xs uppercase tracking-wider">
                  {characterName(characters, id)}
                </span>
                {characterId === id ? (
                  <span className="font-body text-[0.625rem] font-bold uppercase tracking-[0.16em] text-accent">
                    ✓ Selecionado
                  </span>
                ) : null}
              </button>
            ))}
          </div>

          {livres.length === 0 ? (
            <p className="text-xs text-muted">As duas vagas desta partida já estão ocupadas.</p>
          ) : null}
        </div>

        <div className="mt-auto flex flex-col gap-2.5 pt-4 border-t-2 border-ink-line">
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
        </div>
      </section>
    )
  }

  const placar = progressByPlayer(state)
  const ready = isMatchReady(state)

  return (
    <section
      className="flex h-full min-h-[34rem] flex-col justify-between border-2 border-ink-line bg-ink p-4 min-w-0"
      data-testid="online-turno"
      aria-label="Partida multiplayer"
    >
      <div className="flex flex-col gap-4">
        <RoomCode code={state.code} copied={copied} onCopied={setCopied} />

        <ul className="flex flex-col gap-2" aria-label="Jogadores da sala">
          {state.players.map((player) => (
            <li key={player.id} className="flex flex-col gap-1 border-2 border-ink-line bg-ink-soft/10 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-display text-sm uppercase tracking-wide">
                  {player.id === match.playerId ? 'Você' : player.name}
                </span>
                <span className="font-body text-[0.625rem] font-bold uppercase tracking-wider text-accent">
                  {characterName(characters, player.characterId)}
                </span>
              </div>
              <span className="text-[0.6875rem] text-muted">
                {placar[player.id] ?? 0} falas ·{' '}
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
                  className="mt-1"
                >
                  Liberar vaga desconectada
                </Button>
              ) : null}
            </li>
          ))}
          {state.players.length < 2 ? (
            <li className="flex min-h-12 items-center justify-center border-2 border-dashed border-ink-line p-3 font-body text-xs uppercase tracking-wider text-muted">
              Aguardando amigo…
            </li>
          ) : null}
        </ul>

        {state.players.length < 2 ? (
          <p className="text-xs text-muted leading-relaxed" role="status" data-testid="online-aguardando-dupla">
            Envie o código para a outra pessoa. A gravação fica bloqueada até ela entrar e ficar
            pronta.
          </p>
        ) : !ready ? (
          <p className="text-xs text-muted leading-relaxed" role="status" data-testid="online-aguardando-prontos">
            As duas vagas estão ocupadas. Esperando o outro aparelho preparar o vídeo ou voltar à
            partida.
          </p>
        ) : match.complete ? (
          <p className="text-xs font-semibold text-paper" role="status" data-testid="online-completa">
            Cena fechada. Ouça as duas vozes juntas aqui embaixo.
          </p>
        ) : match.myTurn ? (
          <p className="text-xs font-semibold text-accent" role="status" data-testid="online-minha-vez">
            É a sua vez. Grave a fala destacada — a outra pessoa recebe assim que você enviar.
          </p>
        ) : (
          <p className="text-xs text-muted" role="status" data-testid="online-vez-do-outro">
            Esperando {match.waitingFor ?? 'a outra pessoa'} gravar. A tela muda sozinha quando chegar
            sua vez.
          </p>
        )}
      </div>

      <div className="mt-auto flex flex-col gap-2.5 pt-4 border-t-2 border-ink-line">
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
      </div>
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
