# ADR 0002 — Score espectral normalizado, sem transcrição

**Status:** aceito · **Data:** 2026-08-09
**Substitui:** a métrica de TEXTO prevista no documento de origem (§11, §28, §29)

## Contexto

O documento de origem previa um score de fidelidade textual baseado em Speech-to-Text. O usuário
decidiu o contrário: **não deve existir score de texto**; a fidelidade deve ser medida pela
proximidade entre o espectrograma da voz do usuário e o da referência.

Isso remove STT, custo por análise, chaves de API e dependência de fornecedor (§27, §101). Mas cria um
problema técnico sério.

## O problema

A distância entre dois espectrogramas de fala é dominada, nesta ordem, por:

1. timbre e formantes do falante;
2. altura absoluta da voz;
3. ganho e distância do microfone;
4. resposta de frequência do microfone e da sala.

Nenhum desses fatores mede dublagem, e nenhum está sob controle do usuário. Uma comparação espectral
ingênua produziria, na prática, um medidor de semelhança de **identidade vocal** — e apresentá-lo como
"quão bem você dublou" seria precisão inventada, proibida pelo §12.

## Decisão

Comparar espectrogramas em um **domínio normalizado**:

| Fator indesejado | Remoção |
|---|---|
| Ganho e distância | descarte do coeficiente cepstral C0 + CMVN |
| Microfone e sala | CMVN (a média cepstral aproxima a resposta do canal) |
| Registro vocal | F0 em cents relativo à mediana do próprio falante |
| Andamento | alinhamento DTW |

Métricas resultantes: **sincronia** (VAD + offset global), **articulação** (MFCC+delta com CMVN,
alinhado por DTW), **ritmo** (inclinação do caminho DTW), **entonação** (correlação do contorno F0
normalizado), **energia** (correlação do envelope RMS relativo).

Calibração por âncoras `dFloor` e `dChance` calculadas por cena na ingestão, de modo que o número
tenha significado declarável: *0 = indistinguível de fala não relacionada; 100 = tão perto quanto o
próprio áudio com ruído leve.*

## Consequências

**Positivas:** custo zero por análise; feedback instantâneo; funciona offline; a voz não sai do
dispositivo (§42); determinístico e testável com fixtures; justo entre vozes diferentes.

**Negativas e declaradas ao usuário:**

- não identifica palavras — alta articulação significa "os sons se parecem", não "você disse o texto";
- degrada com ruído de fundo, música ou múltiplos falantes;
- exige as âncoras por cena, o que acopla o score ao pipeline de ingestão;
- MFCC não é totalmente independente de falante; a normalização reduz o efeito, não o elimina. Por
  isso a articulação nunca é apresentada como medida de acerto textual.

## Reversibilidade

`SpeechAnalysisProvider` permanece definido como interface em `packages/shared`, sem implementação. Se
um score de texto voltar a ser desejado, ele entra como métrica **adicional** — o eixo espectral
continua válido e independente.
