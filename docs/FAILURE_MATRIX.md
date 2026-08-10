# FAILURE_MATRIX

Nenhuma falha pode terminar em "Something went wrong" (§20). Toda linha desta tabela tem um código, uma
mensagem em português, um caminho de recuperação e um log.

Códigos vivem em `packages/shared/src/errors.ts`. As mensagens vivem no mesmo lugar, ao lado do código
— separar as duas coisas é como mensagens genéricas nascem.

---

## Microfone

| Cenário | Detecção | Comportamento | Recuperação | Código |
|---|---|---|---|---|
| Permissão negada | `NotAllowedError` | Tela dedicada com instrução específica do navegador detectado | [TENTAR NOVAMENTE] + como reverter nas configurações | `MIC_PERMISSION_DENIED` |
| Permissão bloqueada permanentemente | `NotAllowedError` + `permissions.query` = `denied` | Explica que o botão do navegador não vai mais aparecer | Passo a passo do cadeado na barra de endereço | `MIC_PERMISSION_BLOCKED` |
| Nenhum microfone | `NotFoundError` ou `enumerateDevices` sem `audioinput` | "Nenhum microfone encontrado" | Reenumera automaticamente em `devicechange` | `MIC_NOT_FOUND` |
| Microfone ocupado | `NotReadableError` / `TrackStartError` | "Outro programa está usando seu microfone" | Retry sem recarregar a página | `MIC_BUSY` |
| Constraints impossíveis | `OverconstrainedError` | Refaz sem `deviceId` exato | Automático, silencioso | `MIC_OVERCONSTRAINED` |
| Track encerrada gravando | `track.onended` | Para imediatamente e **preserva o PCM já capturado** | Oferece ouvir o parcial ou regravar | `MIC_DISCONNECTED` |
| Troca de dispositivo | `devicechange` | Fora de gravação: atualiza a lista. Gravando: avisa e continua no dispositivo atual | — | `MIC_DEVICE_CHANGED` |

## Vídeo

| Cenário | Detecção | Comportamento | Recuperação | Código |
|---|---|---|---|---|
| Vídeo não carrega | `video.onerror` / `networkState = NO_SOURCE` | Bloqueia DUBLAR, cena marcada indisponível | Retry com backoff exponencial | `VIDEO_LOAD_FAILED` |
| Buffer insuficiente | `buffered` não cobre a janela necessária | **Countdown não inicia.** "Carregando a cena…" com progresso | Inicia sozinho quando completa | `VIDEO_BUFFERING` |
| Vídeo com faixa de áudio | verificação na ingestão (`ffprobe`) | Cena rejeitada na publicação | Corrigir o artefato | `VIDEO_HAS_AUDIO_TRACK` |

## Gravação

| Cenário | Detecção | Comportamento | Recuperação | Código |
|---|---|---|---|---|
| Gravação vazia | duração < 500 ms | "A gravação foi curta demais." | [TENTAR NOVAMENTE] | `RECORDING_EMPTY` |
| Voz quase inaudível | pico < −45 dBFS | "Quase não conseguimos ouvir sua voz." — **não analisa** (§100) | [TENTAR NOVAMENTE] + dica de posicionamento | `RECORDING_TOO_QUIET` |
| Clipping | > 1% das amostras em \|x\| ≥ 0.99 | Analisa, mas avisa e marca energia como `limited` | Sugere afastar o microfone | `RECORDING_CLIPPING` |
| Aba em segundo plano | `visibilitychange` + lacuna de amostras | Avisa e marca a tentativa como suspeita (§104) | Áudio preservado; métricas com `limited` | `TAB_SUSPENDED` |
| Contexto suspenso (mobile) | `AudioContext.onstatechange` | Parada limpa, sem perder o Blob | `resume()` no próximo gesto | `AUDIO_INTERRUPTED` |
| Worklet indisponível | feature-detect no boot | Tela explicativa **antes** de qualquer permissão | Lista navegadores suportados | `BROWSER_UNSUPPORTED` |

## Análise

| Cenário | Detecção | Comportamento | Recuperação | Código |
|---|---|---|---|---|
| Worker falha | exceção / `onerror` | Playback continua funcionando **sem** score | [CALCULAR DE NOVO] — determinístico, sem custo | `ANALYSIS_FAILED` |
| Features da referência ausentes | fetch 404 / magic inválido | Score indisponível, dublagem e playback seguem | Retry | `REFERENCE_FEATURES_MISSING` |
| Sinal insuficiente para uma métrica | regras do `SCORING.md` §3 | Métrica com `unavailable` + motivo. Nunca um número inventado | — | (não é erro) |

## Rede e armazenamento

| Cenário | Detecção | Comportamento | Recuperação | Código |
|---|---|---|---|---|
| Offline | `navigator.onLine` + falha de fetch | Gravação e análise locais seguem normalmente | Reconecta sozinho | `NETWORK_OFFLINE` |
| Sem espaço local | `QuotaExceededError` | "Sem espaço para salvar" + lista de gravações antigas | Blob mantido em memória na sessão atual | `STORAGE_QUOTA_EXCEEDED` |
| OPFS indisponível | feature-detect | Cai para Blob em IndexedDB, com aviso | Automático | `STORAGE_UNAVAILABLE` |

## Fase 5+ (definidos agora, ainda sem caminho de código)

| Cenário | Comportamento | Código |
|---|---|---|
| Upload interrompido | Retry com backoff, Blob preservado (§58) | `UPLOAD_FAILED` |
| URL assinada expirada | Renova e retoma | `UPLOAD_URL_EXPIRED` |
| Job duplicado | `idempotency_key` único → segundo é ignorado (§57) | `JOB_DUPLICATE` |
| Render falhou | Gravação intacta, render pode ser refeito | `RENDER_FAILED` |
| Sessão expirada | Preserva a gravação e reautentica (§54) | `AUTH_EXPIRED` |
| Cota de uso estourada | Explica o limite e quando reseta (§102) | `QUOTA_EXCEEDED` |

---

## Regra de ouro da UI

Toda tela de erro responde às seis perguntas do §117:

> Onde estou? · O que faço? · O que está acontecendo? · Deu errado? · Consigo voltar? · Vou perder
> minha gravação?

A última é a mais importante. Sempre que existir um Blob capturado, o erro **precisa** dizer
explicitamente se ele foi preservado.
