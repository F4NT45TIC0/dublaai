# Prompt de continuidade

Copie e cole o texto abaixo na outra IA:

```text
Você vai continuar o projeto Dubla Aí localizado em G:\Dublaai.

Regra principal: preserve a arquitetura e a estrutura existentes. Não faça refatoração ampla, não
troque o stack e não crie backend. Faça alterações pequenas, isoladas e compatíveis com o estilo e
os componentes atuais. Preserve também todas as mudanças já presentes no workspace.

Estado atual já implementado e funcional:

- A sobreposição do título “Dubla Aí” da home foi corrigida localmente com `leading-none` no h1.
- Existe uma rota `/enviar`, acessível pelo menu “Meu vídeo” e pelo CTA da home.
- A pessoa pode escolher um arquivo MP4/WebM/MOV ou colar uma URL direta. Arquivo e URL têm os mesmos
  limites: no máximo 60.000 ms e 250 MB.
- URLs precisam usar HTTPS; HTTP só é aceito em localhost. O cliente recusa credenciais embutidas,
  páginas conhecidas do YouTube/TikTok/Instagram e playlists HLS/DASH. Links de compartilhamento como
  Google Drive também falham quando devolvem HTML em vez dos bytes do vídeo.
- O download remoto acontece diretamente no navegador com CORS, `credentials: 'omit'`, sem referrer,
  sem cache, timeout de 30 segundos e contagem dos bytes durante o streaming. Não existe backend nem
  proxy de URL. A URL original não é usada pelo player: o resultado vira um `File` e uma URL `blob:`.
- A duração e as dimensões reais são lidas pelo elemento de vídeo depois do download. O limite de
  250 MB é verificado antes do decode para arquivo local e durante o download para URL.
- Quando existe uma faixa de áudio compatível, `OfflineAudioContext` decodifica o contêiner e faz
  downmix para mono. Um worker extrai features, waveform e regiões de fala por VAD. A tela usa a
  mesma forma de onda do catálogo e sobrepõe em verde o PCM real do microfone, posicionado pelo
  MediaClock do vídeo; o pré-roll do countdown é descartado dessa camada visual.
- As regiões de VAD viram segmentos genéricos da referência. O binário DAF1 fica em memória e é
  passado ao `useRecorder`; a captura preserva countdown, MediaClock e alinhamento por
  `mediaStartOffsetMs`.
- Uma cena arbitrária não possui o corpus necessário para calibrar articulação. O worker grava
  `dFloor`/`dChance` como `NaN`, então ARTICULAÇÃO aparece honestamente como `unavailable`; as demais
  métricas continuam pelo mesmo motor determinístico, cada uma com status e confiança.
- Música, efeitos e várias pessoas no áudio original podem reduzir a precisão. Isso é avisado na UI;
  o áudio completo é usado como referência, sem separação vocal.
- Se o vídeo não tiver áudio ou o navegador não conseguir decodificá-lo, o fluxo continua disponível
  para gravar, ouvir e exportar, mas sem forma de onda e sem pontuação. Nenhuma nota é inventada.
- A gravação para automaticamente quando o vídeo termina.
- Depois da gravação, é possível ouvir a voz sincronizada, baixar o WAV ou gerar o vídeo final.
- O vídeo final é renderizado inteiramente no browser com um player oculto + canvas.captureStream +
  AudioContext + MediaRecorder. A faixa de áudio original é removida e entra apenas a voz gravada.
- A exportação prefere MP4 quando o navegador oferece e usa WebM como fallback.
- A CSP mantém `media-src 'self' blob:` e libera em `connect-src` HTTPS e localhost para o fetch
  explícito da URL. Nenhum script remoto é permitido.
- Fetches, workers, object URLs, tracks, AudioContext, callbacks e exportações canceladas possuem
  cleanup dentro dos respectivos ciclos de vida.

Arquivos principais:

- apps/web/app/enviar/page.tsx
- apps/web/components/upload/local-video-dubber.tsx
- apps/web/components/upload/dubbed-video-export.tsx
- apps/web/components/scene/waveform.tsx
- apps/web/lib/local-video.ts
- apps/web/lib/remote-video.ts
- apps/web/lib/live-waveform.ts
- apps/web/lib/prepare-video-reference.ts
- apps/web/lib/export-dubbed-video.ts
- apps/web/lib/use-recorder.ts
- apps/web/workers/reference.worker.ts
- apps/web/workers/analysis.worker.ts
- packages/dsp/src/spectrogram.ts
- apps/web/next.config.ts
- tests/e2e/upload-flow.spec.ts
- tests/e2e/dub-flow.spec.ts
- apps/web/lib/__tests__/remote-video.test.ts
- apps/web/lib/__tests__/live-waveform.test.ts
- apps/web/lib/__tests__/attempt-playback.test.ts
- apps/web/lib/__tests__/export-dubbed-video.test.ts
- scripts/build-e2e-fixtures.ts

Testes atuais relevantes:

- Os testes unitários de URL cobrem validação de HTTPS/localhost, URL assinada, credenciais embutidas,
  páginas conhecidas, HLS/DASH, download sem credenciais e recusa de HTML.
- Os testes da camada ao vivo cobrem pico real, descarte de pré-roll, posicionamento pelo tempo do
  vídeo e limpeza entre tentativas.
- Os testes de sincronia cobrem pausa sem avanço residual, TTS junto do vídeo, seek/restart,
  MediaClock parado, conversão histórica de offset, drift suave de 100 ms, correção de 500 ms,
  trimming de pré-roll e offsets positivos/negativos na exportação.
- `tests/e2e/upload-flow.spec.ts` contém quatro cenários: arquivo H.264/AAC com waveform, voz ao vivo, score e
  download verificado por ffprobe; URL direta com CORS percorrendo o score; vídeo sem áudio sem score
  inventado; e vídeo real acima de 60 segundos recusado.
- `scripts/build-e2e-fixtures.ts` gera o MP4 de 10 segundos com H.264 + AAC, o MP4 de 61+ segundos e os
  WAVs usados pelo microfone falso.

Validação registrada em 09/08/2026:

- `pnpm verify` passou: ESLint, typecheck dos 6 pacotes, 142 testes em 13 arquivos e build de produção.
- As fixtures E2E foram regeneradas com FFmpeg.
- `tests/e2e/dub-flow.spec.ts` e `tests/e2e/upload-flow.spec.ts` passaram juntos com 15/15 cenários
  no Chromium contra o build de produção (1,5 min). A rodada validou play/pause/seek/restart do TTS,
  drift forçado, offset real do microfone, voz ao vivo no Canvas, score e download final com streams
  de vídeo e áudio confirmadas por ffprobe.

Esses resultados descrevem este estado exato do workspace. Depois de qualquer alteração, execute os
comandos novamente em vez de assumir que continuam verdes.

Limitação pré-existente que não deve ser escondida: no Chromium do teste anterior, o fallback WebM
gerado pelo MediaRecorder tem VP9 + Opus e toca normalmente, mas não traz `format.duration` no
contêiner. Alguns players podem não oferecer seek até remuxar o arquivo. Se a próxima tarefa for
melhorar isso, priorize uma correção pequena e totalmente local (metadado EBML/remux no navegador),
com teste real via ffprobe. Não adicione ffmpeg.wasm, backend ou dependência grande sem explicar antes
o impacto.

Antes de editar, leia os arquivos atuais. Depois de qualquer mudança, rode `pnpm verify`, gere as
fixtures e execute `tests/e2e/dub-flow.spec.ts` e `tests/e2e/upload-flow.spec.ts` contra o build de
produção. Não desfaça o fluxo de
arquivo local nem transforme a URL em proxy de backend para contornar CORS.
```
