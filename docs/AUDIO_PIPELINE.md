# AUDIO_PIPELINE — Captura, relógio, gravação e playback

> Área crítica (§1, §17, §18). Nada aqui pode ser simplificado sem revisão explícita.

---

## 1. Princípio central: não force o início simultâneo — meça o offset

A abordagem ingênua tenta disparar `video.play()` e o gravador no mesmo instante. Ela falha sempre,
porque:

- `play()` é assíncrono e resolve quando o navegador quer;
- `MediaRecorder.start()` tem tempo de priming do encoder, desconhecido e variável;
- a latência de captura do hardware não é exposta por nenhuma API;
- os três relógios envolvidos (vídeo, `performance.now()`, `AudioContext`) correm em taxas ligeiramente
  diferentes.

**Nossa abordagem:** o gravador já está capturando **antes** do countdown. Não tentamos alinhar o
início — registramos, em número de amostras, o instante exato em que o primeiro quadro de vídeo foi
efetivamente exibido. O offset deixa de ser erro e vira **dado medido**.

Isso elimina de uma vez a race condition do §19 e a maior fonte de drift do §17.

---

## 2. Captura — `AudioCaptureService`

Único ponto do código que chama `getUserMedia` (§22).

```ts
const constraints: MediaStreamConstraints = {
  audio: {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
}
```

### Por que os três processamentos ficam desligados

| Processamento | Motivo do desligamento |
|---|---|
| `echoCancellation` | O vídeo é mudo durante a gravação — não existe caminho de eco. O EC introduz atraso variável e não determinístico, que é exatamente o que estamos tentando medir. |
| `autoGainControl` | O AGC comprime a dinâmica — destrói a métrica de ENERGIA e distorce o envelope usado no VAD e no offset global. |
| `noiseSuppression` | Altera o espectro de forma não linear e dependente do conteúdo, contaminando MFCC e F0. |

Navegadores podem **ignorar** essas constraints. Depois de obter o stream:

```ts
const settings = track.getSettings()
if (settings.autoGainControl) → métrica de energia recebe status 'limited'
```

Nunca assumimos que a constraint foi respeitada. Verificamos e degradamos com honestidade.

### Responsabilidades

`start` · `stop` · `selectDevice` · `enumerate` (tolerante a labels ocultas antes da permissão, §21) ·
`monitorLevel` · `detectClipping` · `detectSilence` · `releaseTracks` · escuta de `devicechange`.

Um **único** `AudioContext` por sessão, criado sob gesto do usuário e mantido vivo. Criar um por
gravação é a causa mais comum de vazamento em uso repetido (§68).

---

## 3. `MediaClock` — três relógios, um mapeamento

| Relógio | Fonte | Papel |
|---|---|---|
| Vídeo | `video.requestVideoFrameCallback()` → `{ mediaTime, expectedDisplayTime }` | timeline mestre (§17) |
| Parede | `performance.now()` | base comum |
| Áudio | `audioCtx.getOutputTimestamp()` → `{ contextTime, performanceTime }` | domínio da gravação |

`expectedDisplayTime` e `performanceTime` estão **na mesma base**, o que permite fechar a ponte:

```
amostra N  →  contextTime = startContextTime + N / sampleRate
           →  performanceTime  (via getOutputTimestamp)
           →  mediaTime do vídeo  (via requestVideoFrameCallback)
```

O mapeamento é mantido como **ajuste afim contínuo** (`mediaTime = a · perfMs + b`) sobre uma janela
deslizante das últimas ~30 amostras de rVFC, e não como leitura pontual. Uma leitura pontual carrega o
jitter de um quadro; o ajuste dá a taxa real de avanço e permite detectar drift.

`clockConfidence` = qualidade do ajuste (R²). Se cair, a sincronia vira `limited`.

Fallback quando `requestVideoFrameCallback` não existe (Firefox antigo): `timeupdate` + `currentTime`
lido dentro de rAF, com confiança reduzida e registrada. **`setInterval` nunca é usado como relógio**
(§112).

---

## 4. Gravação

### 4.1 AudioWorklet

`public/audio-worklet/capture-processor.js` roda no thread de áudio. Dentro do
`AudioWorkletGlobalScope`, `currentFrame` é o índice **exato** da amostra global — é isto que dá
precisão de amostra, impossível de obter com `MediaRecorder`.

```
process(inputs):
  se ainda não iniciado e o flag 'armed' está ligado:
      startFrame = currentFrame          // instante t=0 do áudio, exato
  acumula blocos de 128 quadros
  a cada 4096 quadros: postMessage(Float32Array, [transfer])
```

Chunks de 4096 (≈85 ms a 48 kHz) equilibram overhead de mensagem e latência de feedback visual.
`SharedArrayBuffer` foi descartado deliberadamente: exigiria COOP/COEP em toda a aplicação sem ganho
mensurável nesta escala (ADR 0003).

### 4.2 Dados registrados por gravação (§18)

```ts
type RecordingClockInfo = {
  sampleRate: number             // taxa real, nunca presumida
  startFrame: number             // primeira amostra capturada
  videoStartMediaTime: number    // mediaTime do 1º quadro exibido
  mediaStartOffsetMs: number     // ponte entre os dois — o número que importa
  estimatedInputLatencyMs: number  // baseLatency + settings.latency quando existir
  clockConfidence: number        // 0..1, R² do ajuste afim
  sampleContinuityOk: boolean    // false se a aba foi suspensa
}
```

`estimatedInputLatencyMs` é uma **estimativa parcial declarada**, não uma verdade. A latência real do
hardware permanece inobservável; é por isso que o score reporta o offset global separadamente em vez
de fingir que o compensou (ver `SCORING.md` §2.2).

### 4.3 Ao parar

```
capture → validation → decode → resample → normalize → analysis
```

O PCM cru é **preservado** (§24). Os derivados são:

- **WAV 16-bit na taxa nativa** → playback e download;
- **Float32 16 kHz mono** → análise (decimação com filtro anti-aliasing FIR, não simples descarte de
  amostras — descartar produziria aliasing e envenenaria os MFCC).

---

## 5. Validação antes de analisar (§25, §100)

| Verificação | Limiar | Mensagem ao usuário |
|---|---|---|
| Duração | < 500 ms | "A gravação foi curta demais." |
| Pico | < −45 dBFS | "Quase não conseguimos ouvir sua voz." |
| Clipping | > 1% das amostras em \|x\| ≥ 0.99 | "Sua voz está estourando. Fale um pouco mais longe do microfone." |
| Continuidade | lacuna de amostras detectada | "A aba ficou em segundo plano durante a gravação." |
| Duração vs cena | desvio > 25% | "A gravação não bate com a duração da cena." |

Falha nas duas primeiras **interrompe a análise**: nenhum processamento caro sobre gravação vazia.

---

## 6. Playback sincronizado (Fase 4)

Reproduzir a voz do usuário sobre o vídeo é o momento em que o produto se prova.

```
1. video.currentTime = t0
2. source = ctx.createBufferSource() com o PCM do usuário
3. quando = ctx.currentTime + 0.15   (margem de agendamento)
4. source.start(quando, mediaStartOffsetMs / 1000)
5. video.play() sincronizado pelo MediaClock no mesmo instante
```

O agendamento do Web Audio é preciso ao nível da amostra; o vídeo é que deriva. Portanto **o áudio é o
mestre no playback** (invertido em relação à gravação) e o vídeo é corrigido:

```
erro = mediaTimeEsperado − video.currentTime
|erro| < 15 ms   → não faz nada
15–250 ms        → video.playbackRate = 1 ± min(0.02, erro·k)   (correção suave)
> 250 ms         → seek único (último recurso; causa stutter)
```

Micro-ajuste de `playbackRate` é imperceptível abaixo de 2%; o seek é visível. Por isso o seek só
aparece quando a correção suave não dá conta.

Mixagem oferecida: **só minha voz** · **minha voz + referência** · **trecho isolado de um segmento**.
Nada toca com som sem gesto do usuário (§33, §66).

---

## 7. Cleanup — obrigatório (§67)

Ao desmontar a tela de dublagem, em ordem:

1. `recorder.stop()` e desarmar o worklet;
2. `track.stop()` em **todas** as tracks;
3. desconectar todos os `AudioNode` (worklet, analyser, source);
4. `cancelAnimationFrame` e `cancelVideoFrameCallback`;
5. `URL.revokeObjectURL` de todo blob criado;
6. `AbortController.abort()` nos fetches pendentes;
7. `worker.terminate()` no worker de análise.

O `AudioContext` **não** é fechado — ele é da sessão, não da tela.

Em desenvolvimento, um HUD mostra contagem de tracks vivas, nós conectados, object URLs e workers.
`pnpm check:leaks` roda 30 ciclos e falha se qualquer contador crescer entre ciclos (§68).

---

## 8. Diferenças conhecidas por navegador

| Navegador | Comportamento | Tratamento |
|---|---|---|
| Chrome/Edge desktop | referência | — |
| Firefox | `requestVideoFrameCallback` ausente em versões antigas | fallback rAF + confiança reduzida |
| Safari macOS/iOS | `AudioContext` nasce `suspended`; sampleRate imposto pelo dispositivo | `resume()` em gesto; nunca presumir 48 kHz |
| iOS Safari | vídeo exige `playsinline`; interrupções do sistema suspendem o contexto | `onstatechange` → parada limpa preservando o Blob |
| Chrome Android | Bluetooth pode adicionar 150–300 ms | offset global reportado, nunca prometido como zero |

Resultados reais de teste ficam em `TESTING.md` (§119).
