# ADR 0001 — Captura por AudioWorklet em vez de MediaRecorder

**Status:** aceito · **Data:** 2026-08-09

## Contexto

O produto exige alinhar a gravação do usuário à timeline do vídeo com precisão suficiente para que a
voz "encaixe" no playback e para que o score de sincronia seja verdadeiro (§17, §18).

`MediaRecorder` é o caminho óbvio, mas:

- não expõe um `t0` confiável — `onstart` dispara depois de um priming de encoder de duração variável;
- entrega contêiner comprimido cujo início precisa ser decodificado para se saber quando começa;
- o formato suportado varia por navegador (§23), e cada codec tem seu próprio atraso de algoritmo;
- não dá acesso a amostras, então waveform ao vivo, detecção de silêncio e clipping exigiriam um
  segundo caminho de captura em paralelo.

## Decisão

Capturar PCM cru por `AudioWorkletNode`.

Dentro do `AudioWorkletGlobalScope`, `currentFrame` é o índice global exato da amostra sendo
processada. Isso dá um `t0` **em amostras**, no mesmo domínio de `AudioContext.currentTime`, sem
qualquer estimativa.

Consequências diretas:

- waveform ao vivo, VAD, detecção de silêncio e de clipping saem do mesmo fluxo, sem custo extra;
- a codificação passa a ser nossa: WAV 16-bit para playback, Float32 16 kHz para análise;
- `MediaRecorder` fica apenas como fallback documentado caso `AudioWorklet` não exista — situação em
  que a aplicação avisa que a precisão de sincronia será menor.

## Alternativas descartadas

| Alternativa | Por que não |
|---|---|
| `MediaRecorder` puro | `t0` não confiável; sem acesso a amostras |
| `ScriptProcessorNode` | Depreciado, roda no thread principal, causa glitch sob carga |
| `MediaRecorder` + `AudioWorklet` em paralelo | Dois caminhos de captura para o mesmo áudio; complexidade sem ganho, já que o worklet cobre tudo |

## Consequências

**Positivas:** precisão de amostra; um só fluxo de dados; independência de codec; análise mais simples.

**Negativas:** WAV é maior que Opus (≈5 MB para 45 s a 48 kHz mono, 16-bit) — aceitável localmente, e
na Fase 5 a compressão acontece antes do upload. Precisamos manter um encoder WAV próprio (~60 linhas,
testável).
