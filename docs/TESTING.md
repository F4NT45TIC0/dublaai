# TESTING

## 1. Pirâmide

| Camada | Ferramenta | O que cobre |
|---|---|---|
| Unitário | Vitest (node) | `dsp`, `scoring`, `shared`, parsers, máquina de estados |
| Integração | Vitest + jsdom + mocks de Web API | `AudioCaptureService`, `MediaClock`, persistência |
| E2E | Playwright + mídia falsa | fluxo completo de dublagem |
| Verificação de mídia | script + `ffprobe` | invariantes dos artefatos de cena |

## 2. O que é testado de verdade

### 2.1 DSP (`packages/dsp`)

Contra sinais de resposta conhecida — não contra snapshots, que só congelam bugs:

| Entrada | Asserção |
|---|---|
| Seno 1 kHz | pico do espectro no bin de 1 kHz ±1 bin |
| Silêncio | RMS = −∞ tratado; VAD não detecta fala; YIN reporta não sonoro |
| Ruído branco | YIN reporta não sonoro (aperiodicidade alta) |
| Seno 200 Hz | YIN retorna 200 Hz ±2 Hz |
| Sinal deslocado de N quadros | DTW encontra caminho com offset N |
| Sinal idêntico | distância DTW = 0, caminho = diagonal |
| Filtro mel | soma das respostas ≈ 1 em cada frequência (partição de unidade) |

### 2.2 ScoreEngine (`packages/scoring`) — §75

Fixtures sintetizadas em `src/__tests__/fixtures.ts`, faixas em `SCORING.md` §7. Além delas:

- **Determinismo**: duas execuções sobre a mesma entrada produzem JSON idêntico.
- **Renormalização**: com uma métrica `unavailable`, o geral usa apenas os pesos restantes e o
  resultado é o esperado analiticamente.
- **Degradação**: abaixo de 50% do peso disponível, o próprio geral vira `limited`.
- **Ausência de aleatoriedade**: teste de lint que falha se `Math.random` aparecer no pacote (§115).
- **Config**: alterar um peso muda o geral na direção certa e na magnitude certa.

### 2.3 Gravador (§76)

Web APIs mockadas (`getUserMedia`, `AudioContext`, `AudioWorkletNode`, `MediaStreamTrack`):

permissão concedida · negada · bloqueada · dispositivo ausente · dispositivo ocupado · `track.onended`
durante gravação · `devicechange` · parar · cancelar durante countdown · gravar duas vezes seguidas ·
desmontar durante gravação · aba oculta.

Cada teste verifica **duas** coisas: o estado final da máquina e que todas as tracks foram paradas.

### 2.4 E2E (§77)

```bash
pnpm test:e2e
```

Chromium com:

```
--use-fake-ui-for-media-stream
--use-fake-device-for-media-stream
--use-file-for-fake-audio-capture=tests/e2e/fixtures/voice-30s.wav
```

Fluxo: abrir cena → permitir microfone → countdown → gravar → parar → resultado → tentar de novo.

A asserção não é "a tela renderizou". É **o score está na faixa esperada para aquele arquivo
conhecido**. Um E2E que só verifica se apareceu um número passaria com `Math.random()`.

## 3. Verificação de sincronização — o teste que mais importa

Um erro de sincronia é invisível para testes comuns e fatal para o produto.

### O que foi planejado e por que não funciona

O plano original era uma claquete: um WAV com beeps deslocados por um offset
**conhecido**, e a asserção de que `mediaStartOffsetMs` bate com ele dentro de
±30 ms.

Isso **não é possível** com `--use-file-for-fake-audio-capture`. O Chromium
reproduz o arquivo em laço a partir do momento em que a track começa, e a fase
do laço no instante em que o vídeo arranca é desconhecida. Não há como injetar
um deslocamento controlado *relativo à timeline do vídeo* — que é exatamente a
grandeza a medir.

### O que verifica de fato

A verificação foi dividida em duas, e as duas juntas cobrem o mesmo risco:

**Unitária, com precisão exata** (`packages/audio/src/__tests__/media-clock.test.ts`).
O `MediaClock` recebe quadros de vídeo em instantes escolhidos pelo teste, e as
asserções são de milissegundo: a reta ajustada prevê o tempo de mídia, a
conversão do relógio de áudio bate com o esperado, seek descarta o histórico e
jitter derruba a confiança. É aqui que a matemática do §17 é provada.

**E2E, por faixa de plausibilidade** (`tests/e2e/dub-flow.spec.ts`).
O gravador é armado no início do countdown e o vídeo só começa ~3 s depois,
então `mediaStartOffsetMs` precisa ser negativo e próximo de −3000 ms. A
asserção exige `−6000 < offset < −1500`, mais `clockConfidence > 0.5` e
continuidade de amostras intacta.

A faixa é larga de propósito — ela não mede precisão, mede que a **cadeia
inteira está conectada**: `currentFrame` do worklet → `contextTime` →
`performanceTime` → `mediaTime` do vídeo. Qualquer elo quebrado produz zero ou
um valor fora da faixa. A precisão dentro dessa cadeia é o que o teste unitário
cobre.

A precisão percebida de verdade continua exigindo ouvido humano, e está no
checklist manual do §111.

## 4. Vazamento de memória (§68)

```bash
pnpm check:leaks
```

Doze ciclos por padrão; `LEAK_CYCLES=30` para o número do §68 (leva ~2,5 min).
A linha de base é tomada no 4º ciclo, para ignorar carregamento de módulos,
criação do worker e aquecimento de cache.

Falha se, ao final: mais de dois `AudioContext` tiverem sido criados (o §22
manda um por sessão, não um por gravação), mais de uma `MediaStreamTrack`
continuar viva, ou as object URLs crescerem mais rápido que uma por tentativa.

`AudioContext` e `URL.createObjectURL` são instrumentados via `addInitScript`,
antes de qualquer script da página — instrumentar depois perderia justamente as
criações do carregamento inicial.

## 5. Quality gates (§116)

Nenhuma fase é concluída sem:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## 6. Matriz de navegadores (§119)

Preenchida conforme os testes forem executados. Diferenças conhecidas ficam registradas aqui, não na
cabeça de quem testou.

| Navegador | Captura | Worklet | rVFC | Sincronia observada | Notas |
|---|---|---|---|---|---|
| Chrome desktop | — | — | — | — | referência |
| Edge desktop | — | — | — | — | |
| Firefox desktop | — | — | — | — | rVFC pode faltar → fallback rAF |
| Safari macOS | — | — | — | — | contexto suspenso no início |
| Chrome Android | — | — | — | — | Bluetooth altera o offset |
| Safari iOS | — | — | — | — | `playsinline`, interrupções do sistema |

## 7. O que deliberadamente não é testado automaticamente

- Qualidade **perceptual** da sincronia — exige ouvido humano; está no checklist manual do §111.
- Hardware Bluetooth real — não há como emular latência de fone em CI.
- Comportamento sob interrupção telefônica real (§105) — verificado manualmente em dispositivo.
