# RISKS

Classificação: **critical** (mata o produto) · **high** (degrada muito) · **medium** (custa retrabalho) ·
**low** (incômodo).

---

## Critical

### R-01 · Sincronia percebida ruim no playback
Se a voz do usuário não encaixa no vídeo, nada mais importa — o momento de prazer do produto é
exatamente esse (§120).

*Mitigação:* `MediaClock` é prototipado e validado **antes** de qualquer UI de gravação; teste
automatizado de offset com claquete de referência (±30 ms); áudio como mestre no playback com correção
por `playbackRate` em vez de seek.
*Sinal de alerta:* `clockConfidence` < 0.8 em uso normal.

### R-02 · Score parecendo arbitrário
Um número que o usuário não entende, ou que pune algo fora do controle dele, destrói a confiança
inteira do produto — e é o que aconteceria com comparação espectral ingênua.

*Mitigação:* domínio normalizado (`SCORING.md` §0); âncoras `dFloor`/`dChance` por cena dando
significado absoluto ao número; status e confiança em toda métrica; espectrograma duplo mostrando o
que foi comparado; fixtures determinísticas.
*Sinal de alerta:* usuários repetindo a mesma performance e recebendo scores distantes.

### R-03 · Referência com tempos declarados errados
Se `startMs`/`endMs` do `scene.json` não correspondem ao áudio real, o score fica errado de forma
silenciosa e convincente — a pior classe de bug possível aqui.

*Mitigação:* verificação de ingestão que compara o VAD da referência com os segmentos declarados e
**falha a publicação** se divergir mais de 150 ms (`MEDIA_PIPELINE.md` §3).

---

## High

### R-04 · Safari iOS quebrar a captura
`AudioContext` suspenso, sample rate imposto, interrupções do sistema, autoplay.

*Mitigação:* feature-detect antes de pedir permissão; `resume()` sob gesto; nunca presumir 48 kHz;
`onstatechange` levando a parada limpa que preserva o Blob. Degradação explícita, nunca falha silenciosa.

### R-05 · Vazamento em uso repetido
`AudioContext`, `MediaStream`, object URLs e workers acumulam em 30–50 tentativas (§68).

*Mitigação:* um `AudioContext` por sessão; checklist de cleanup obrigatório (`AUDIO_PIPELINE.md` §7);
HUD de recursos em dev; `pnpm check:leaks` como gate.

### R-06 · Latência de Bluetooth
150–300 ms de atraso que nenhuma API expõe.

*Mitigação:* offset global estimado por correlação cruzada e **reportado separadamente**; nunca
prometer sincronia perfeita (§106); calibração manual prevista (§107).

### R-07 · Aba em segundo plano corrompendo a gravação
Timers estrangulados e possível descontinuidade de amostras.

*Mitigação:* `visibilitychange` + verificação de continuidade de amostras; tentativa marcada como
suspeita com métricas em `limited`; o áudio nunca é descartado sem o usuário saber.

---

## Medium

### R-08 · Bug numérico sutil no DSP próprio
Um erro de índice em MFCC ou YIN produz scores plausíveis e errados.

*Mitigação:* testes contra sinais de resposta conhecida (seno, silêncio, ruído), não snapshots;
partição de unidade do banco mel verificada; DTW validado contra deslocamento conhecido.

### R-09 · Conteúdo sintético não convencer
Cartelas tipográficas podem não sustentar a graça de dublar.

*Mitigação:* direção de arte editorial forte; diálogos escritos para serem engraçados; o formato de
cena aceita vídeo real assim que houver licença — nenhum retrabalho de código.

### R-10 · Bundle inflado
DSP, XState, worklet e espectrograma na home matariam a performance (§61).

*Mitigação:* `import()` dinâmico por rota; a home não importa nada de áudio; orçamento de bundle
verificado no build.

### R-11 · Divergência entre docs e código
Este repositório tem documentação normativa. Documentação que mente é pior que ausência de documentação.

*Mitigação:* as constantes de `SCORING.md` vivem em **um** arquivo de config lido pelo código; testes
referenciam as faixas do documento; ADRs registram mudanças de decisão.

---

## Low

### R-12 · Migração de local para Postgres na Fase 5
*Mitigação:* contrato de tipos único desde a Fase 0; nomes de coluna espelhando os campos TS; chaves de
storage idênticas nos dois mundos.

### R-13 · Voz TTS única para todos os personagens
A voz `Microsoft Maria` é a única pt-BR instalada; personagens diferentes soam parecidos.

*Mitigação:* variação de `rate` e `pitch` por personagem via SSML; personagens também se distinguem por
nome, cor e padrão visual (§63). Não afeta o score — a comparação é sempre contra a referência daquele
segmento.
