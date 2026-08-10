# ADR 0006 — Local-first nas Fases 0–4, Postgres escrito e adiado

**Status:** aceito · **Data:** 2026-08-09

## Contexto

O documento de origem sugere Supabase com PostgreSQL, Storage e Auth (§46). O MVP, porém, precisa
provar uma coisa só: que dublar uma cena sincronizada é divertido e funciona (§94). Nada nessa
afirmação exige servidor.

## Decisão

Nas Fases 0–4 a aplicação é local-first:

| Dado | Onde |
|---|---|
| Catálogo | `content/scenes/*/scene.json`, estático |
| Áudio das gravações | OPFS |
| Metadados e tentativas | IndexedDB |
| Preferências | `localStorage` |

O schema PostgreSQL completo, com RLS, é **escrito agora** (`db/migrations/0001_init.sql`) e revisado,
mas não aplicado.

## Razões

1. **Fricção zero para provar o produto.** `pnpm dev` funciona sem Docker, sem conta, sem chave.
2. **O caminho crítico não passa por servidor.** Sincronização, gravação e score são todos client-side.
   Adicionar infraestrutura agora seria infraestrutura desproporcional ao estágio (regra final do
   documento de origem).
3. **Privacidade de graça.** Enquanto a voz não sai do dispositivo, boa parte do §42 é satisfeita por
   construção, não por política.
4. **Escrever o schema agora, mesmo sem aplicar, é o que evita o retrabalho.** Os tipos de
   `packages/shared` são derivados dele; os nomes de coluna espelham os campos TS; as chaves de
   storage são idênticas nos dois mundos.

## O que isso custa

- Sem sincronização entre dispositivos e sem compartilhamento — ambos fora do MVP (§K).
- Cota de armazenamento do navegador é finita: `QuotaExceededError` é tratado explicitamente
  (`FAILURE_MATRIX.md`).
- A camada de acesso precisa ser abstraída por um repositório (`RecordingRepository`) para que a Fase 5
  troque a implementação sem tocar na UI.

## Gatilho de revisão

A Fase 5 começa quando **uma** destas for verdadeira: o usuário precisar salvar entre dispositivos,
compartilhar publicamente, ou for necessário um valor de score autoritativo que o cliente não possa
forjar.
