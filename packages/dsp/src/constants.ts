/**
 * Parâmetros de análise.
 *
 * Estes números são a especificação de docs/SCORING.md §1. Mudar qualquer um
 * deles invalida as âncoras de calibração gravadas nos arquivos de features
 * das cenas — exige regerar o conteúdo e subir `ENGINE_VERSION`.
 */

export const ANALYSIS_SAMPLE_RATE = 16_000

/** 25 ms — padrão em análise de fala. */
export const FRAME_SIZE = 400
/** 20 ms → 50 quadros por segundo. */
export const HOP_SIZE = 320
export const HOP_MS = 20
export const FRAMES_PER_SECOND = 50

/** Próxima potência de 2 acima da janela. */
export const FFT_SIZE = 512
export const SPECTRUM_BINS = FFT_SIZE / 2 + 1

/** Compensa a inclinação de −6 dB/oitava da voz. */
export const PRE_EMPHASIS = 0.97

export const MEL_BANDS = 26
export const MEL_MIN_HZ = 50
export const MEL_MAX_HZ = 8_000

/** Coeficientes 1..13. C0 é descartado — ele é o volume (SCORING.md §0). */
export const MFCC_COUNT = 13
/** Regressão de delta sobre ±2 quadros. */
export const DELTA_WINDOW = 2
/** 13 MFCC + 13 delta. */
export const FEATURE_DIM = MFCC_COUNT * 2

/**
 * Janela do F0 é maior que a do MFCC de propósito: a 16 kHz, 60 Hz tem período
 * de 266 amostras, e YIN precisa de mais de dois períodos para decidir. Uma
 * janela de 400 amostras não conseguiria detectar vozes graves.
 */
export const F0_WINDOW = 1024
export const F0_MIN_HZ = 60
export const F0_MAX_HZ = 400
export const YIN_THRESHOLD = 0.15
/** Acima disso, o quadro é considerado não sonoro. */
export const YIN_MAX_APERIODICITY = 0.45

/** Piso de ruído + este valor = limiar de fala. */
export const VAD_THRESHOLD_DB = 12
export const VAD_NOISE_PERCENTILE = 0.1
/** Histerese assimétrica: pausas curtas não devem quebrar uma frase. */
export const VAD_ONSET_FRAMES = 3
export const VAD_OFFSET_FRAMES = 8
export const VAD_MIN_SPEECH_FRAMES = 5

/** Banda de Sakoe-Chiba: ±1,5 s de variação humana plausível. */
export const DTW_BAND_FRAMES = 75

/** Offset global limitado a ±300 ms (SCORING.md §2.2). */
export const MAX_GLOBAL_OFFSET_FRAMES = 15

/** Abaixo disto a gravação é considerada inaudível e não é analisada (§100). */
export const SILENCE_PEAK_DB = -45
/** Amostras com |x| acima disso contam como estouro. */
export const CLIPPING_THRESHOLD = 0.99
export const CLIPPING_MAX_RATIO = 0.01

export const DB_FLOOR = -120
