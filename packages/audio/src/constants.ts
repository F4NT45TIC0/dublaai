/** Caminho do worklet servido estaticamente pela app. */
export const CAPTURE_WORKLET_URL = '/audio-worklet/capture-processor.js'
export const CAPTURE_PROCESSOR_NAME = 'capture-processor'

/** Precisa bater com o worklet. Ver ADR 0003 para por que não é SharedArrayBuffer. */
export const CHUNK_FRAMES = 4096

/** Duração do countdown, em passos de 1 s. */
export const COUNTDOWN_STEPS = 3

/**
 * Janela do vídeo que precisa estar em buffer antes do countdown começar (§59).
 *
 * Dez segundos, e não a cena inteira: exigir o download completo faria cenas
 * longas parecerem quebradas em conexões lentas, e dez segundos de folga são
 * suficientes para o resto chegar durante a gravação.
 */
export const REQUIRED_BUFFER_MS = 10_000

/** Margem entre o fim do countdown e o t=0 oficial, para agendar sem correria. */
export const COUNTDOWN_LEAD_MS = 120
