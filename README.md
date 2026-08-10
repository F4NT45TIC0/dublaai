# Dubla Aí

> Dá o play. A voz é sua.

Plataforma onde o usuário dubla cenas curtas (10–45 s) e recebe um retorno
honesto sobre quão perto chegou da entrega original.

O produto não é o score — é o loop: **assistir → gravar → ouvir a si mesmo
encaixado no vídeo → rir → tentar de novo**. O score existe para dar direção
("você atrasou a segunda fala") e motivo para repetir.

---

## Como o score funciona (e o que ele não afirma)

A fidelidade é medida **acusticamente**, comparando o espectrograma da voz do
usuário com o da referência. Não há transcrição, nem modelo de linguagem, nem
API paga: é DSP determinístico rodando no navegador.

O detalhe que decide tudo: comparar espectrogramas **crus** mediria timbre,
formantes e altura absoluta — ou seja, **identidade vocal**. Uma voz diferente
da original nunca pontuaria bem, por melhor que fosse a dublagem. Por isso a
comparação acontece em um domínio normalizado (MFCC com CMVN, F0 em cents
relativo à mediana do próprio falante, alinhamento por DTW), onde o que sobra
mede **a atuação, não as cordas vocais**.

| Métrica | O que afirma |
|---|---|
| SINCRONIA | Se você entrou e saiu de cada fala na hora |
| ARTICULAÇÃO | O quanto os sons que você produziu se parecem com os da referência |
| RITMO | Se você correu ou arrastou |
| ENTONAÇÃO | Se a melodia da fala bateu |
| ENERGIA | Se a variação de intensidade bateu |

Nenhuma métrica devolve um número solto: toda uma delas carrega `status`
(`ok` / `limited` / `unavailable`), `confidence` e um motivo em português
quando não está `ok`. `value: null` é a única forma de dizer "não deu para
medir" — nunca 0. Detalhes em [`docs/SCORING.md`](docs/SCORING.md).

---

## Stack

| Camada | Escolha |
|---|---|
| Web | Next.js 16 (App Router), React 19, TypeScript 6 strict |
| Estilo | Tailwind v4 com tokens em `@theme` — visual autoral, editorial brutalista |
| Áudio | Web Audio + AudioWorklet (captura PCM sample-accurate) |
| DSP | Implementação própria, sem dependências: STFT, mel, MFCC, CMVN, YIN, VAD, DTW |
| Testes | Vitest (unit/integração) + Playwright com mídia falsa (E2E) |
| Monorepo | pnpm workspaces + Turborepo |
| Mídia | ffmpeg + síntese de voz local (SAPI pt-BR) |

TypeScript está fixado em **6.0.3** de propósito: a versão 7 (porte nativo) ainda
não é suportada pelo `typescript-eslint`, e perder as regras de lint com
informação de tipo custaria mais do que ganhar o compilador novo.

---

## Estrutura

```
apps/web/           Next.js — home, explorar, página da cena
packages/
  shared/           tipos de domínio, taxonomia de erros, schemas zod, logger
  dsp/              DSP puro e isomórfico (navegador, worker, Node)
  scoring/          ScoreEngine determinístico + config versionada
  audio/            MediaClock e captura
  ui/               design system
content/scenes/     fontes autorais das cenas (versionadas)
scripts/            gerador de conteúdo e utilitários
db/migrations/      schema PostgreSQL com RLS (escrito, aplicado na Fase 5)
docs/               arquitetura, áudio, score, riscos, segurança, ADRs
```

---

## Rodando

Requisitos: **Node ≥ 22.12**, **pnpm 11**, **ffmpeg** no PATH e **Windows** para
a geração de conteúdo (usa a síntese de voz do sistema).

```bash
pnpm install
```

```bash
pnpm content:build
```

O segundo comando gera as cenas: sintetiza os diálogos autorais, monta as
trilhas de referência, renderiza os vídeos **sem faixa de áudio**, extrai as
features e escreve o catálogo. A mídia não é versionada porque é inteiramente
reconstruível — leva menos de um minuto.

```bash
pnpm dev
```

A aplicação sobe em `http://localhost:3000`. Nenhuma conta, container ou chave
de API é necessária.

### Dublando um arquivo ou URL direta

Abra `http://localhost:3000/enviar` (ou clique em **Meu vídeo**) e escolha uma
das entradas:

- um arquivo MP4, WebM ou MOV do computador;
- uma URL HTTPS direta para um desses arquivos, desde que o host permita CORS
  (`http://localhost` também é aceito durante desenvolvimento).

Nos dois casos, o limite é de **60 segundos e 250 MB**. Uma URL é baixada pelo
próprio navegador, sem cookies e sem passar por proxy do Dubla Aí; depois disso,
o vídeo é tratado como `blob:` local pelo mesmo fluxo do seletor de arquivo.
Links para páginas do YouTube, TikTok, Instagram ou Google Drive não são URLs
diretas de mídia e não funcionam. Playlists HLS/DASH também ficam fora deste
fluxo.

Quando o contêiner traz uma faixa de áudio compatível, o navegador a decodifica,
faz o downmix para mono e o worker produz a referência acústica, os trechos de
fala detectados por VAD e os picos da **forma de onda**. Durante a gravação, a
voz real do microfone aparece em verde sobre essa mesma timeline, alinhada pelo
MediaClock do vídeo. A dublagem é comparada com a referência pelo mesmo motor
determinístico do catálogo. A articulação fica
honestamente `unavailable`, porque um vídeo arbitrário não tem o corpus de outras
falas necessário para calibrar `dFloor`/`dChance`; as demais métricas continuam
com seus próprios status e confiança.

Se não existir faixa de áudio ou o navegador não conseguir decodificá-la, a cena
ainda pode ser dublada, ouvida e exportada, mas fica sem forma de onda e sem
pontuação. Depois da gravação, **Gerar vídeo dublado** renderiza a cena com a voz
e libera o download. A exportação leva aproximadamente a duração da cena e, no
Chrome/Edge, normalmente é entregue em WebM.

### Outros comandos

```bash
pnpm verify
```

Roda lint, typecheck, testes e build — o portão de qualidade do §116.

| Comando | O que faz |
|---|---|
| `pnpm lint` | ESLint com regras que codificam requisitos do projeto |
| `pnpm typecheck` | `tsc --noEmit` em todos os pacotes |
| `pnpm test` | Vitest |
| `pnpm build` | Build de produção |
| `pnpm content:build` | Regenera as cenas |
| `pnpm test:e2e` | E2E com microfone falso (gera fixtures e faz build antes) |
| `pnpm check:leaks` | Ciclos de gravação verificando vazamento (`LEAK_CYCLES=30` para o número do §68) |

O lint carrega requisitos como regras: `getUserMedia` fora do
`AudioCaptureService`, `setInterval` como relógio, `Math.random` no motor de
score e `dangerouslySetInnerHTML` são **erros de lint**, não convenções que
alguém precisa lembrar.

---

## Modo online (partida com um amigo)

O modo online é o **único** lugar em que áudio sai do aparelho, e por isso é o
único que precisa de configuração. Ele guarda as tomadas de voz num Blob store
da Vercel:

1. no projeto da Vercel, abra **Storage → Blob** e crie um store;
2. conecte-o ao projeto. A variável `BLOB_READ_WRITE_TOKEN` aparece sozinha;
3. faça um novo deploy.

Sem essa variável, a tela do modo online diz exatamente isso em vez de fingir
que funciona — e todo o resto do Dubla Aí segue normal, sem servidor nenhum.

O vídeo **não** trafega: cada pessoa abre o mesmo arquivo no próprio computador
e a partida guarda só a impressão digital dele, recusando quem chegar com outro.
As tomadas expiram em 24 horas.

O código da partida tem 12 caracteres (`K7M2-9XQP-4TVB`), e não 6 dígitos, por
um motivo concreto: ele é a única coisa que protege as gravações. Com 6 dígitos,
percorrer o milhão de combinações e baixar voz de estranhos seria questão de
minutos.

Em desenvolvimento (`pnpm dev`) o modo online usa o disco local em
`.dubla-partidas/`, o que permite jogar entre duas abas sem nuvem nenhuma. Esse
caminho **não** serve para produção — o disco de uma função serverless não é
compartilhado entre instâncias — e por isso só liga com `next dev` ou com
`DUBLA_MATCH_DIR` escrita à mão (é o que o teste de ponta a ponta usa).

## Conteúdo e direitos

O Dubla Aí não distribui conteúdo: o material é sempre um arquivo que a própria
pessoa escolhe no computador. Use apenas o que você tem o direito de usar.

## Privacidade

A gravação, a análise, a transcrição e a renderização acontecem no navegador.
Nada disso sobe para servidor.

A transcrição automática das falas roda localmente (Whisper via
onnxruntime-web). O áudio não sai do aparelho; o que vem da rede é o modelo,
baixado uma vez (~90 MB) e guardado em cache.

Ao colar uma URL, o navegador faz a requisição diretamente ao host informado —
esse host recebe a requisição e o IP como em qualquer download —, mas o arquivo
não passa por um servidor do Dubla Aí.

A exceção é o **modo online**, descrito acima: nele as tomadas de voz vão para o
armazenamento da partida para que a outra pessoa possa ouvi-las. A tela avisa
isso antes de qualquer gravação. Ver [`docs/SECURITY.md`](docs/SECURITY.md).

---

## Documentação

| Documento | Assunto |
|---|---|
| [PROJECT_SPEC](docs/PROJECT_SPEC.md) | O que é o produto e o que é inegociável |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Camadas, máquina de estados, race conditions |
| [AUDIO_PIPELINE](docs/AUDIO_PIPELINE.md) | Captura, relógios, gravação, playback |
| [SCORING](docs/SCORING.md) | Como cada métrica é calculada e calibrada |
| [DATA_MODEL](docs/DATA_MODEL.md) | Entidades, RLS, armazenamento |
| [MEDIA_PIPELINE](docs/MEDIA_PIPELINE.md) | Ingestão e verificações de publicação |
| [FAILURE_MATRIX](docs/FAILURE_MATRIX.md) | Toda falha prevista e seu tratamento |
| [SECURITY](docs/SECURITY.md) · [TESTING](docs/TESTING.md) · [RISKS](docs/RISKS.md) · [MVP](docs/MVP.md) | — |
| [decisions/](docs/decisions/) | ADRs |
