# PROJECT_SPEC — Dubla Aí

## 1. O que é

Plataforma onde o usuário dubla cenas curtas (10–45s) de conteúdo audiovisual e recebe um retorno
honesto sobre quão perto chegou da entrega original.

O produto não é o score. O produto é o **loop**:

```
assistir → gravar → ouvir a si mesmo encaixado no vídeo → rir → tentar de novo
```

O score existe para dar **direção** ("você entrou 300ms atrasado na segunda fala") e **motivo para
repetir**. Um score inventado destrói a confiança e transforma o produto em brinquedo descartável.

## 2. Modos

| Modo | Objetivo | Métricas ativas |
|---|---|---|
| **ORIGINAL** | Chegar o mais perto possível da entrega original | sincronia, articulação, ritmo, entonação, energia |
| **PARÓDIA** | Falar o que quiser, mantendo o encaixe na cena | sincronia, ritmo, ocupação |

Em Paródia, **articulação e entonação são desligadas** — não faz sentido comparar os sons produzidos
quando o texto é intencionalmente diferente. O usuário nunca é penalizado por improvisar.

## 3. Decisão de escopo: sem score de texto, sem STT

Definido com o usuário. O eixo de fidelidade é **acústico**: comparação do espectrograma da voz do
usuário com o da referência, em domínio normalizado. Nenhuma transcrição, nenhum modelo de linguagem,
nenhuma API paga, nenhuma chave. Toda a análise é DSP determinístico rodando no navegador.

Consequências positivas:

- feedback instantâneo, sem upload e sem espera;
- custo zero por análise (§101);
- funciona offline;
- reprodutível e testável com fixtures matemáticas;
- privacidade por construção — a voz não sai do dispositivo (§42).

## 4. Usuário-alvo e primeira sessão

O usuário chega por um link de cena, sem conta. Precisa entender o que fazer **sem tutorial** (§99).
A tela da cena responde sozinha às três perguntas: o que é isso, o que eu faço, o que acontece depois.

Gravar não exige login. Salvar, compartilhar e perfil exigem (§53). A gravação **nunca** é perdida ao
abrir a autenticação (§54).

## 5. Requisitos não-funcionais

| Requisito | Alvo |
|---|---|
| Sincronia percebida no playback | desvio imperceptível (< 40ms) na maior parte dos dispositivos |
| Erro de medição do offset de gravação | ±30ms contra claquete de referência |
| Tempo até a primeira cena tocar | < 2s em conexão doméstica |
| Bundle da home | sem DSP, sem worklet, sem espectrograma |
| Gravações consecutivas sem degradação | ≥ 30 (§68) |
| Cobertura de teste do ScoreEngine | 100% dos caminhos de decisão de status |
| Acessibilidade | WCAG AA: teclado, foco, contraste, leitor de tela, reduced-motion |

## 6. Restrições inegociáveis

1. O vídeo em modo de dublagem **não tem faixa de áudio** — não é `muted`, é um arquivo sem stream de
   áudio (§14).
2. `setInterval` nunca é relógio central (§112). O vídeo é a timeline mestre (§17).
3. Nenhuma métrica é exibida sem status e confiança (§12).
4. Nenhum conteúdo protegido no repositório. Toda mídia é autoral gerada (§39/§40).
5. `getUserMedia` só é chamado dentro de `AudioCaptureService` (§22).
6. Nenhum `Math.random()` no motor de score (§115).
7. UI em português; código, tipos e funções em inglês (§87).

## 7. Fora de escopo desta entrega

Login, upload, servidor, banco aplicado, worker de render, compartilhamento em vídeo, perfil, ranking,
conquistas, admin, pagamentos, multipersonagem, duetos. A arquitetura não impede nenhum deles —
ver `ARCHITECTURE.md`, seção "Pontos de extensão".
