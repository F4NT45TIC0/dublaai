# SECURITY

## 1. Superfície atual

`/enviar` continua local-first: não exige conta e não envia vídeo ou voz. `/multiplayer` é a exceção
deliberada: usa Route Handlers para o estado da sala e um Vercel Blob **privado** para vídeo e tomadas.
Não há conta nem banco; o código aleatório de 12 caracteres funciona como convite/capability da sala.
Uma URL direta ainda é baixada do host de origem pelo próprio navegador, sem proxy arbitrário.

## 2. Controles ativos hoje

| Controle             | Implementação                                                                                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CSP                  | `next.config.ts`: `default-src 'self'`, `worker-src 'self' blob:`, `media-src 'self' blob:`; `connect-src` libera HTTPS e localhost somente para o fetch explícito de uma URL direta; nenhum script remoto é permitido |
| Fontes               | auto-hospedadas via `next/font` — nenhuma requisição a terceiros                                                                                                                                                       |
| XSS em legendas      | legendas renderizadas como texto React; `dangerouslySetInnerHTML` é proibido por regra de lint                                                                                                                         |
| Validação de entrada | zod em `scene.json` e dados do IndexedDB; parser defensivo para features binárias; validação dedicada para arquivo, URL, MIME, tamanho, duração e dimensões — §80                                                      |
| Cabeçalhos           | `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: microphone=(self)`                                                                                         |
| Env vars             | validadas com zod no boot; cliente e servidor separados; `.env.example` sem segredos (§90)                                                                                                                             |
| Logs                 | logger estruturado tipado que só aceita `{ requestId, sceneId, recordingId, attemptId, errorCode, durationMs }`. Não existe caminho de código que aceite áudio, token ou dado pessoal (§71)                            |
| Multiplayer          | estado mutável com ETag/CAS, duas vagas, heartbeat, turnos e `ready` validados no servidor; mídia em chaves imutáveis de Blob privado; uploads grandes vão direto do navegador ao Blob                                 |

### URL direta e mídia fornecida pela pessoa

O mesmo limite é aplicado a arquivo e URL: **5 minutos e 1 GB**. O tamanho do arquivo local é
verificado antes do decode. Na URL, `Content-Length` permite a recusa antecipada quando disponível e o
total recebido é contado durante o streaming, portanto omitir ou falsificar esse cabeçalho não remove o
limite. Metadados reais do elemento de vídeo validam duração e dimensões depois do download.

A URL aceita HTTPS e, para desenvolvimento local, HTTP apenas em `localhost`, `127.0.0.1` ou `[::1]`.
Usuário/senha embutidos, páginas conhecidas do YouTube/TikTok/Instagram e playlists HLS/DASH são
recusados. O download usa `mode: 'cors'`, `credentials: 'omit'`, `cache: 'no-store'`,
`referrerPolicy: 'no-referrer'`, timeout de 30 segundos e rejeição explícita de HTML, JSON e MIME
incompatível. Google Drive e outros links de compartilhamento também não funcionam quando devolvem
uma página em vez dos bytes do vídeo.

Depois de recebido, o conteúdo vira um `blob:` criado pela origem da aplicação. O player e o canvas de
exportação nunca consomem diretamente a URL externa, evitando que mídia sem aprovação CORS contamine
o canvas. Toda object URL é revogada ao trocar de vídeo ou desmontar a tela; fetches e workers pendentes
são abortados.

Não existe fallback por `no-cors` — uma resposta opaca não pode ser validada, analisada ou exportada.
Também não existe endpoint `/api/proxy`: além de contrariar o processamento local, um proxy de URL
abriria uma superfície de SSRF que hoje não está presente no servidor.

### Referência acústica arbitrária

Quando o contêiner possui áudio decodificável, um `OfflineAudioContext` faz o downmix para mono e um
worker calcula VAD, features de score e waveform. O binário da referência fica em
memória e não é enviado para rede. Vídeos sem áudio ou com codec que o navegador não decodifica seguem
disponíveis para gravação e exportação, mas sem forma de onda e sem score — não existe nota substituta.

Uma referência arbitrária não possui o corpus necessário para calibrar `dFloor`/`dChance`. Por isso as
âncoras de articulação são gravadas como não calculáveis e essa métrica aparece como `unavailable`; as
outras métricas mantêm seus próprios status e confiança. Música, efeitos e múltiplas vozes na faixa de
origem ainda podem reduzir a qualidade da comparação e não são tratados como uma referência vocal
curada.

### Por que validar `scene.json` e o arquivo de features

São dados carregados de fora do processo. O binário de features é lido com `DataView` e alimenta laços
que alocam buffers a partir de valores do cabeçalho. Um `frameCount` corrompido vira alocação absurda
ou leitura fora do buffer. O parser valida magic, versão, coerência entre `frameCount` e o tamanho real
do arquivo, e limites máximos — antes de alocar qualquer coisa.

## 3. Nunca confiar no frontend (§78)

O score calculado no cliente é conveniência de UX, não fonte da verdade. Quando o servidor existir
(Fase 5) ele **recomputa** com o mesmo engine determinístico e ignora qualquer score enviado. Uma
divergência entre os dois é registrada como anomalia (tentativa de fraude ou bug de versão).

## 4. Privacidade da voz (§42)

Gravação de voz é dado biométrico do ponto de vista de produto.

- Em **Meu vídeo**, a voz não é enviada pelo Dubla Aí. Não há upload nem telemetria de áudio. Quando a
  pessoa cola uma URL, o host informado recebe a requisição direta do navegador e o IP, como em qualquer
  download; a gravação do microfone não participa dessa requisição.
- No **Multiplayer**, a tela avisa antes da criação: vídeo e tomadas são enviados ao Blob privado para
  a outra pessoa da sala. As rotas deixam de servir a partida depois de 24 horas.
- Sem uso para treinamento, identificação, clonagem ou perfil vocal — hoje não existe, e quando
  existir exigirá consentimento explícito e política própria.
- O usuário pode excluir uma gravação a qualquer momento; a exclusão remove o arquivo do OPFS e a
  linha do IndexedDB, não só a referência da UI.
- Retenção local configurável, com opção de apagar tudo.

## 5. Controles escritos, ativados na Fase 5

| Área             | Controle                                                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Upload (§43)     | validar por **conteúdo** (magic bytes + `ffprobe`), nunca por extensão, mime ou filename; nome interno gerado (`uuid`), jamais o filename do usuário; limites de tamanho, duração, codec e dimensão; recusa de arquivos multi-stream inesperados |
| Path traversal   | chaves de storage montadas só a partir de UUIDs validados; nenhuma concatenação com entrada do usuário                                                                                                                                           |
| Upload bombs     | limite de tamanho **antes** do decode; timeout no `ffprobe`; recusa de arquivos com razão de compressão anômala                                                                                                                                  |
| FFmpeg           | processo isolado, sem rede, filesystem restrito, `-nostdin`, timeout rígido; nunca dentro de request serverless (§112)                                                                                                                           |
| Autenticação     | cookies `HttpOnly` + `Secure` + `SameSite=Lax`; CSRF por double-submit nas rotas mutantes                                                                                                                                                        |
| Autorização      | RLS no Postgres como camada final; nenhuma decisão de acesso confiada ao cliente (§81)                                                                                                                                                           |
| Rate limit (§79) | login, upload, análise, render e report — por IP e por usuário                                                                                                                                                                                   |
| Cotas (§102)     | limite configurável de análises e renders por janela de tempo                                                                                                                                                                                    |
| Admin (§82)      | verificação no servidor por claim/role; `isAdmin` no frontend não concede nada                                                                                                                                                                   |

## 6. Riscos aceitos e declarados

| Risco                                             | Por que é aceito agora                                                                                                                    | Quando muda                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Gravações locais não são criptografadas           | Ficam no perfil do navegador do próprio usuário, sob a mesma proteção que qualquer dado de site                                           | Se houver sincronização entre dispositivos                                     |
| Host de uma URL vê a requisição e o IP            | É uma transferência explícita iniciada pela pessoa, sem cookies, referrer ou proxy do Dubla Aí                                            | Se a ingestão migrar para infraestrutura própria                               |
| Decode de mídia não confiável ocorre no navegador | Há limites de 1 GB/5 min e o projeto usa os decodificadores isolados do browser, sem executar ffmpeg sobre entrada arbitrária no servidor | Se existir ingestão no worker da Fase 5                                        |
| Áudio misturado pode limitar o score              | O produto sinaliza métricas indisponíveis/limitadas e nunca fabrica a calibração de articulação                                           | Se houver separação vocal e calibração próprias                                |
| Sem autenticação por conta                        | O código de 60 bits é o segredo de acesso à sala; IDs locais não são identidade forte. Blob privado impede acesso direto às URLs          | Se houver partidas públicas, histórico permanente ou adversários desconhecidos |
| Catálogo estático é totalmente legível            | Todo o conteúdo é autoral e destinado a ser público                                                                                       | Ao existir conteúdo licenciado                                                 |
