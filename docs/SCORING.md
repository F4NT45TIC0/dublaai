# SCORING — Como o Dubla Aí avalia uma dublagem

> Documento normativo. Os números aqui são a especificação que `packages/scoring` e `packages/dsp`
> implementam. Qualquer divergência entre este documento e o código é um bug.

---

## 0. O problema central: espectrograma mede identidade, não desempenho

A pergunta do produto é *"quão perto você chegou do original?"*. A tentação é comparar os
espectrogramas diretamente — distância L2 sobre magnitudes de STFT.

**Isso não funciona.** Essa distância é dominada, nesta ordem, por:

1. timbre e formantes do falante (identidade vocal);
2. altura absoluta da voz (F0);
3. ganho do microfone e distância da boca;
4. resposta de frequência do microfone e acústica da sala.

Nenhum desses quatro fatores tem relação com a qualidade da dublagem, e nenhum deles está sob controle
do usuário. Uma mulher dublando um personagem masculino receberia nota baixa por ter as cordas vocais
que tem. Isso é exatamente a "precisão inventada" que o §12 proíbe.

**A solução:** comparar os espectrogramas em um **domínio normalizado** onde a identidade é removida e
o desempenho permanece.

| Fator | Como é removido | O que sobra |
|---|---|---|
| Ganho / distância do mic | descarte do coeficiente cepstral C0 + CMVN | dinâmica relativa |
| Microfone e sala | CMVN (média cepstral ≈ resposta do canal) | articulação |
| Altura da voz (registro) | F0 convertido para cents, centrado na mediana do próprio falante | melodia da fala |
| Andamento | alinhamento DTW | ritmo (extraído do próprio caminho) |

O que resta de fato mede: **quais sons você produziu, quando, com que melodia e com que dinâmica.**
Continua sendo o seu espectrograma contra o do original — medido de forma que pontue a sua atuação.

---

## 1. Representação — `FeatureSet`

Idêntica para referência e usuário. Sempre 16 kHz mono.

| Parâmetro | Valor | Motivo |
|---|---|---|
| Sample rate de análise | 16000 Hz | fala útil até 8 kHz; reduz custo 3x vs 48 kHz |
| Janela | 400 amostras (25 ms) | padrão em análise de fala |
| Hop | 320 amostras (20 ms) | 50 quadros/s |
| FFT | 512 pontos | próxima potência de 2 acima da janela |
| Janelamento | Hann periódica | vazamento espectral baixo |
| Pré-ênfase | `y[n] = x[n] − 0.97·x[n−1]` | compensa a inclinação −6 dB/oitava da voz |
| Banco mel | 26 filtros triangulares, 50–8000 Hz | resolução perceptual |
| Escala mel | `mel = 2595·log10(1 + f/700)` (HTK) | convenção mais comum |
| MFCC | DCT-II das log-energias, coeficientes **1..13** | **C0 é descartado** — é o volume |
| Deltas | regressão ±2 quadros sobre os 13 | captura transições de articulação |
| Vetor final | 26 dimensões | 13 MFCC + 13 delta |
| F0 | YIN, 60–400 Hz, limiar 0.15, interpolação parabólica | robusto e determinístico |
| RMS | dBFS por quadro | envelope de energia |

### CMVN (Cepstral Mean and Variance Normalization)

Aplicada **por elocução**, calculada **somente sobre quadros com fala** (quadros de silêncio
enviesariam a média):

```
μ = média dos vetores em quadros de fala
σ = desvio-padrão dos vetores em quadros de fala
v̂ = (v − μ) / max(σ, 1e-6)
```

Isto é o que remove microfone, sala e volume. É a peça que torna a comparação justa entre duas pessoas
diferentes em dois equipamentos diferentes.

### Arquivo binário da referência

`reference.features.bin` — pré-computado na ingestão, **nunca** calculado no navegador.

```
header:  magic "DAF1" · sampleRate · hopMs · frameCount · flags
frames:  int8[13] mfcc (escala 1/8) · int16 f0Cents · uint8 voicing · int8 rmsDb
extras:  waveform peaks (int8 min/max, 400 buckets/s)
âncoras: dFloor, dChance  (ver §3.2)
```

≈ **40 KB para 45 s**. O áudio de referência só é baixado na tela de comparação — nunca no modo de
dublagem (§14/§15/§61).

---

## 2. VAD e offset global

### 2.1 VAD (detecção de atividade vocal)

Energia com piso de ruído adaptativo:

```
noiseFloorDb = percentil 10 do RMS dB de todos os quadros
limiar       = noiseFloorDb + 12 dB
onset        exige 3 quadros consecutivos acima  (60 ms)
offset       exige 8 quadros consecutivos abaixo (160 ms)
duração mínima de fala: 100 ms
```

A histerese assimétrica é intencional: pausas curtas dentro de uma frase não devem quebrar o segmento.

### 2.2 Offset global — o passo mais importante

A latência de captura do hardware **não é conhecível por nenhuma API**. Bluetooth pode custar
150–300 ms. Punir o usuário por isso seria medir o fone, não a dublagem.

Estimativa por correlação cruzada normalizada dos envelopes de atividade vocal, com atraso limitado a
**±300 ms** (±15 quadros):

```
lag* = argmax_{|lag| ≤ 15} ncc(refActivity, userActivity, lag)
```

- **Todas as métricas são calculadas depois de remover `lag*`.**
- `lag*` é exibido **separadamente**: "atraso do seu setup: 180 ms", com calibração manual (§107).
- Se o pico da correlação `< 0.30`, o offset é considerado não confiável: usa-se 0 e a sincronia cai
  para `limited` com motivo declarado.

---

## 3. Métricas

Toda métrica retorna:

```ts
type Metric = {
  value: number | null          // 0..100, null quando unavailable
  status: 'ok' | 'limited' | 'unavailable'
  confidence: number            // 0..1
  reason?: string               // obrigatório quando status !== 'ok'
}
```

### 3.1 SINCRONIA — você entrou e saiu na hora?

Para cada `SpeakerSegment` da referência, procura-se o onset do usuário numa janela de ±800 ms em
torno do onset esperado (já compensado por `lag*`).

```
Δ = userOnset − refOnset

|Δ| ≤ 120 ms          → 100      PERFEITO
120 < |Δ| ≤ 250 ms    → 100→85   ÓTIMO
250 < |Δ| ≤ 400 ms    → 85→65    BOM
400 < |Δ| ≤ 800 ms    → 65→0     ATRASADO / ADIANTADO
sem fala no segmento  → 0        com bandeira "não detectamos fala aqui"
```

Interpolação linear dentro de cada faixa. Score final = média ponderada pela duração dos segmentos.
`confidence` cai com a confiança do offset global e com a fração de segmentos sem fala detectada.

### 3.2 ARTICULAÇÃO — você produziu os mesmos sons?

O núcleo da comparação espectral. Substitui o score de texto sem precisar de transcrição.

1. Vetores de 26 dimensões (MFCC + delta), CMVN aplicada dos dois lados.
2. Distância local: **cosseno**, `d(i,j) = max(0, 1 − cos(v̂ᵢ, ŵⱼ))`, faixa `[0, 2]`.
   O `max(0, …)` é obrigatório: para vetores idênticos o cosseno sai levemente
   acima de 1 por arredondamento, e um custo de passo negativo faz o DTW
   preferir caminhos longos e tortos — seguindo ruído de ponto flutuante em vez
   da diagonal.
3. DTW com banda de Sakoe-Chiba de **±75 quadros (±1,5 s)** e passos `(1,1) (1,0) (0,1)`,
   com a diagonal vencendo empates.
4. `d̄` = custo médio por passo **restrito aos quadros em que a referência tem fala**.

O recorte por fala no passo 4 não é detalhe. Numa cena de 5,6 s com 1,4 s de
fala, três quartos dos passos comparam silêncio com silêncio — custo quase zero
dos dois lados, independentemente do que a pessoa falou. Usando o custo do
caminho inteiro, `dChance` colapsa sobre `dFloor` e a métrica perde qualquer
poder de separação. As âncoras são calculadas com o mesmo recorte.

**Calibração honesta.** `d̄` sozinho não tem significado absoluto. Cada cena carrega duas âncoras
calculadas na ingestão:

| Âncora | Como é obtida | Significa |
|---|---|---|
| `dFloor` | referência contra ela mesma com ruído rosa a 20 dB SNR | "tão perto quanto é fisicamente razoável" |
| `dChance` | referência contra as referências **das outras cenas** (mesma voz, texto diferente) | "fala não relacionada" |

```
articulação = 100 · clamp((dChance − d̄) / (dChance − dFloor), 0, 1)
```

Ou seja: **0 = indistinguível de uma fala qualquer; 100 = tão perto quanto o próprio áudio com ruído.**
Essa é a única afirmação que os dados sustentam, e é exatamente o que a UI diz.

Degradação: SNR estimado do usuário < 10 dB → `limited`; < 5 dB ou menos de 500 ms de fala → `unavailable`.

### 3.3 RITMO — você correu ou arrastou?

Extraído do **caminho DTW já calculado** — custo computacional zero adicional.

Para cada quadro de referência `i`, o caminho dá `j(i)`. A inclinação local numa janela de ±12 quadros
(±240 ms) é `s(i) = dj/di`:

- `s = 1` → mesmo andamento
- `s < 1` → o usuário correu
- `s > 1` → o usuário arrastou

```
ritmo = 100 · exp(−k · média(|log₂ s(i)|)),  k = 2.0 (configurável)
```

`|log₂ s| = 0.5` significa 1,41× mais rápido ou mais lento → ≈ 37 pontos. Por segmento, a UI mostra
"você correu aqui" / "você arrastou aqui".

A largura da janela é um compromisso medido, não um chute. Com ±500 ms a janela
atravessava a fala inteira (as falas de cena duram ~900 ms) e entrava no
silêncio vizinho, onde o caminho é diagonal: alguém falando 40% mais rápido
aparecia com andamento quase correto. Abaixo de ~±200 ms aparece o problema
oposto — o caminho anda em passos inteiros e a inclinação vira ruído de
quantização.

### 3.4 ENTONAÇÃO — a melodia bateu?

1. F0 por YIN nos quadros sonoros dos dois lados.
2. Conversão para cents relativos ao **próprio** falante:
   `c = 1200 · log₂(f / medianaF0doFalante)`.
   Um barítono e uma soprano com a mesma melodia produzem contornos idênticos.
3. Alinhamento pelo caminho DTW da articulação.
4. Correlação de Pearson `r` sobre os quadros sonoros **em ambos**.

```
entonação = 100 · max(0, r)
```

Correlação negativa não ganha crédito: a melodia foi ao contrário.

Cobertura = fração dos quadros sonoros da referência que também são sonoros no usuário:
`< 0.40` → `limited`; `< 0.15` → `unavailable`.

### 3.5 ENERGIA — a dinâmica bateu?

1. RMS em dB por quadro.
2. Normalização por elocução: subtrai o percentil 95 (dinâmica **relativa**, não volume absoluto).
3. Alinhamento pelo caminho DTW.
4. Pearson `r` sobre quadros com fala em qualquer um dos lados → `100 · max(0, r)`.

Se `track.getSettings().autoGainControl === true` (o navegador ignorou a constraint), o AGC comprimiu
a dinâmica: status `limited`, motivo declarado. Ver `AUDIO_PIPELINE.md` §2.

### 3.6 OCUPAÇÃO — modo Paródia

Fração da duração de cada segmento de referência preenchida com fala do usuário, saturada em 1.0.
Mede "você ocupou o espaço da fala" sem olhar o conteúdo. É a métrica que substitui articulação e
entonação quando o texto é intencionalmente diferente (§13).

---

## 4. Score geral

```
disponíveis = métricas com status ≠ 'unavailable'
pesoTotal   = Σ peso(m) para m em disponíveis
geral       = Σ (peso(m)/pesoTotal · valor(m))
confiança   = Σ (peso(m)/pesoTotal · confiança(m))
```

Se `pesoTotal / pesoOriginalTotal < 0.5`, o próprio geral recebe `status: 'limited'` e a UI explica
quais métricas faltaram e por quê.

### Pesos padrão (`scoring.config.json`, versionado — nunca hardcoded, §11)

| Modo | sincronia | articulação | ritmo | entonação | energia | ocupação |
|---|---|---|---|---|---|---|
| original | 30 | 30 | 20 | 12 | 8 | — |
| paródia | 45 | — | 35 | — | — | 20 |

---

## 5. Versionamento (§52)

Toda análise persiste `engineVersion` (`packages/scoring/package.json`) e `configVersion`
(`scoring.config.json`). Scores de versões diferentes **nunca** são comparados nem agregados. A UI
marca visualmente uma tentativa antiga calculada por outra versão.

---

## 6. O que este sistema NÃO afirma

Declarado no produto, não escondido:

- **Não** identifica palavras. Não há transcrição. Alta articulação significa "os sons se parecem",
  não "você disse o texto certo".
- **Não** mede qualidade atoral, emoção ou interpretação.
- **Não** oferece precisão de milissegundos no atraso absoluto — a latência de hardware é inobservável.
  Só o atraso **relativo entre as suas falas** é confiável.
- **Não** funciona bem com ruído de fundo alto, música ou mais de uma pessoa falando. Nesses casos
  degrada explicitamente para `limited`/`unavailable` em vez de devolver um número bonito e falso.

---

## 7. Testes obrigatórios (§75)

`packages/scoring/src/__tests__/fixtures.test.ts` — sinais sintetizados, faixas esperadas:

| Caso | Asserção |
|---|---|
| idêntico à referência | sincronia ≥ 98 · articulação ≥ 95 · ritmo ≥ 95 · geral `ok` |
| idêntico, uma oitava acima | articulação ≥ 60 e sincronia ≥ 95 — **a nota mede a dublagem, não as cordas vocais** |
| deslocado +50 ms | sincronia ≥ 95 |
| deslocado +300 ms (global) | sincronia ≥ 90 **e** `globalOffsetMs` ≥ 240 reportado à parte |
| atraso de 500 ms só na 2ª fala | sincronia cai ≥ 15 pontos · 2ª fala marcada `late` · as outras seguem `perfect` |
| adiantamento de 450 ms | fala marcada `early`, com `onsetDeltaMs` negativo |
| 0,6× (mais rápido) | ritmo ≤ 75 e `tempoRatio` < 1 no segmento |
| 1,6× (mais lento) | ritmo ≤ 75 |
| fala não relacionada | articulação ≤ 35 **e** sincronia ≥ 90 (encaixe e conteúdo são eixos independentes) |
| silêncio / quase inaudível | todas as métricas `unavailable`, geral `unavailable`, motivo declarado |
| ruído branco | articulação `unavailable` ou `limited`, com motivo |
| aba suspensa | sincronia rebaixada para `limited` |
| AGC ativo | energia rebaixada para `limited` |
| modo paródia com texto trocado | articulação e entonação `unavailable` por decisão, geral > 60, **e melhor que o modo original** |

Além dos casos acima:

- **Renormalização exata**: com uma métrica indisponível, o geral bate com a
  média ponderada analítica das restantes (comparação numérica, não aproximada).
- **Configuração respeitada**: trocar os pesos move o geral na direção esperada.
- **Âncoras válidas**: `dChance > dFloor` — sem isso a articulação não tem régua.
- **Determinismo**: duas execuções sobre a mesma entrada produzem JSON idêntico.
- **Offset de gravação**: uma gravação que começou 1 s depois do vídeo, com
  `recordingOffsetMs = 1000`, ainda classifica as falas como `perfect`.
