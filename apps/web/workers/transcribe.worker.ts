/// <reference lib="webworker" />

/**
 * Transcrição local das falas do vídeo enviado.
 *
 * O modelo roda dentro do navegador (Whisper tiny via onnxruntime-web). O áudio
 * não sai do aparelho em momento nenhum — o que viaja pela rede é o download do
 * modelo, uma vez, do CDN do Hugging Face. A Web Speech API foi descartada
 * justamente pelo contrário: ela sobe o áudio para servidor de terceiro e nem
 * sequer transcreve arquivo, só microfone ao vivo.
 *
 * O texto daqui é um APOIO DE LEITURA, não um dado de avaliação. A pontuação do
 * Dubla Aí é acústica e nunca leu texto (§12) — se o Whisper errar uma palavra,
 * ninguém perde ponto por isso, e o campo continua editável na tela.
 */

export interface TranscribeRequest {
  readonly requestId: string
  /** Mono, na taxa que o navegador decodificou. O worker reamostra. */
  readonly samples: Float32Array
  readonly sampleRate: number
}

export interface TranscribedChunk {
  readonly startMs: number
  readonly endMs: number
  readonly text: string
}

export type TranscribeResponse =
  | { readonly requestId: string; readonly kind: 'progress'; readonly loadedRatio: number }
  | {
      readonly requestId: string
      readonly kind: 'done'
      readonly ok: true
      readonly chunks: readonly TranscribedChunk[]
    }
  | {
      readonly requestId: string
      readonly kind: 'done'
      readonly ok: false
      readonly message: string
    }

/**
 * O Whisper só aceita 16 kHz. É a mesma taxa que o resto do pipeline já usa
 * para análise, então nada aqui é exclusivo da transcrição.
 */
const WHISPER_SAMPLE_RATE = 16_000

/**
 * `tiny` é o menor multilíngue que ainda acerta o suficiente para servir de
 * guia de leitura (~40 MB quantizado). Modelos maiores multiplicam o download
 * por 5 para ganhar precisão que este uso não precisa.
 */
const MODEL_ID = 'onnx-community/whisper-tiny'

/**
 * Encoder em fp32, decoder em fp16 — a única combinação que este runtime
 * consegue carregar. Foi medida, não escolhida:
 *
 * - decoder q8/int8: `TransposeDQWeightsForMatMulNBits ... Missing required
 *   scale` ao montar a sessão;
 * - encoder fp16: `SimplifiedLayerNormFusion` quebra na fusão do grafo;
 * - tudo em fp32: funciona, mas o decoder sozinho passa de 110 MB.
 *
 * Resultado: ~90 MB no primeiro uso (31 MB de encoder + 57 MB de decoder +
 * tokenizer), depois fica no cache do navegador. Antes de "otimizar" para uma
 * quantização menor, confirme carregando de verdade — as três variantes acima
 * baixam sem erro e só falham na hora de criar a sessão.
 */
const MODEL_DTYPE = { encoder_model: 'fp32', decoder_model_merged: 'fp16' } as const

/** Só para avisar antes do download; o valor real varia com a versão do modelo. */
export const APPROXIMATE_MODEL_MB = 90

const scope = self as unknown as DedicatedWorkerGlobalScope

/**
 * O retorno é `unknown` de propósito: a forma exata muda entre versões da
 * transformers.js, e `toChunks` já valida campo a campo. Confiar no tipo
 * declarado pela biblioteca só adiaria o erro para o runtime.
 */
type TranscriberPipeline = (
  input: Float32Array,
  options: Record<string, unknown>,
) => Promise<unknown>

let transcriberPromise: Promise<TranscriberPipeline> | null = null

async function loadTranscriber(onProgress: (ratio: number) => void): Promise<TranscriberPipeline> {
  // O import é dinâmico de propósito: quem não pedir transcrição nunca baixa o
  // runtime do onnx junto do bundle da página (§61).
  const { pipeline, env } = await import('@huggingface/transformers')

  // Sem modelo local no servidor: o único caminho é o CDN, e é o que a CSP
  // permite via `connect-src https:`.
  env.allowLocalModels = false

  // O onnxruntime, por padrão, cria um worker próprio a partir de um blob: —
  // e a CSP bloqueia script vindo de blob, com razão. Aqui esse proxy não teria
  // serventia nenhuma: o objetivo dele é tirar a inferência da thread principal,
  // e este código JÁ roda num worker dedicado. Desligar resolve sem afrouxar a
  // política. Uma thread pela mesma razão: multithread em wasm depende de
  // cross-origin isolation, que a página não tem.
  const wasmBackend = env.backends.onnx.wasm
  if (wasmBackend) {
    wasmBackend.proxy = false
    wasmBackend.numThreads = 1

    // Runtime servido pela própria origem (copiado no build por
    // scripts/copy-onnx-runtime.mjs). Vindo de outro domínio, o onnxruntime
    // baixaria o `.mjs` e o importaria de um `blob:` — que a CSP barra.
    wasmBackend.wasmPaths = '/onnx/'
  }

  const transcriber: unknown = await pipeline('automatic-speech-recognition', MODEL_ID, {
    dtype: MODEL_DTYPE,
    progress_callback: (event: { status?: string; progress?: number }) => {
      if (event.status === 'progress' && typeof event.progress === 'number') {
        onProgress(Math.min(1, Math.max(0, event.progress / 100)))
      }
    },
  })
  return transcriber as TranscriberPipeline
}

/** Reamostragem linear. Suficiente: o Whisper trabalha sobre log-mel, não sobre a forma de onda. */
function resampleTo16k(samples: Float32Array, sampleRate: number): Float32Array {
  if (sampleRate === WHISPER_SAMPLE_RATE) return samples
  const ratio = sampleRate / WHISPER_SAMPLE_RATE
  const length = Math.max(1, Math.floor(samples.length / ratio))
  const output = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio
    const left = Math.floor(position)
    const right = Math.min(samples.length - 1, left + 1)
    const fraction = position - left
    output[index] = (samples[left] ?? 0) * (1 - fraction) + (samples[right] ?? 0) * fraction
  }
  return output
}

function toChunks(raw: unknown): readonly TranscribedChunk[] {
  if (typeof raw !== 'object' || raw === null) return []
  const candidate = (raw as { chunks?: unknown }).chunks
  if (!Array.isArray(candidate)) return []

  const chunks: TranscribedChunk[] = []
  for (const entry of candidate) {
    if (typeof entry !== 'object' || entry === null) continue
    const { timestamp, text } = entry as { timestamp?: unknown; text?: unknown }
    if (typeof text !== 'string' || !Array.isArray(timestamp)) continue

    const [start, end] = timestamp as [unknown, unknown]
    const trimmed = text.trim()
    if (trimmed === '') continue

    // O Whisper devolve `null` no fim quando corta a última janela. Um trecho
    // sem fim conhecido é inútil para casar com os segmentos, então cai fora.
    if (typeof start !== 'number' || typeof end !== 'number') continue

    chunks.push({ startMs: Math.round(start * 1_000), endMs: Math.round(end * 1_000), text: trimmed })
  }
  return chunks
}

scope.onmessage = (event: MessageEvent<TranscribeRequest>) => {
  const { requestId, samples, sampleRate } = event.data

  const run = async (): Promise<void> => {
    try {
      transcriberPromise ??= loadTranscriber((loadedRatio) => {
        scope.postMessage({ requestId, kind: 'progress', loadedRatio } satisfies TranscribeResponse)
      })
      const transcriber = await transcriberPromise

      const audio = resampleTo16k(samples, sampleRate)
      const raw = await transcriber(audio, {
        language: 'portuguese',
        task: 'transcribe',
        // Whisper enxerga 30s por vez; sem isso um vídeo de 5 min só devolveria
        // o começo. O passo com sobreposição evita cortar palavra na emenda.
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: true,
      })

      scope.postMessage({
        requestId,
        kind: 'done',
        ok: true,
        chunks: toChunks(raw),
      } satisfies TranscribeResponse)
    } catch (cause) {
      scope.postMessage({
        requestId,
        kind: 'done',
        ok: false,
        message:
          cause instanceof Error ? cause.message : 'Não conseguimos transcrever o áudio do vídeo.',
      } satisfies TranscribeResponse)
    }
  }

  void run()
}
