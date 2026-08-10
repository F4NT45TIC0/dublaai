import { assign, setup } from 'xstate'
import type { DubMode, DublaErrorCode, RecordingClockInfo } from '@dubla/shared'
import { COUNTDOWN_STEPS } from '../constants'

/**
 * Máquina de estados da gravação (§55).
 *
 * Estados impossíveis são impossíveis por construção: não existem
 * `isRecording`, `isLoading` e `isStopping` soltos para entrar em desacordo.
 *
 * As race conditions do §56 morrem aqui, sem flags: um evento que a máquina
 * não espera no estado atual é simplesmente ignorado. Clicar em DUBLAR duas
 * vezes não faz nada na segunda porque só `idle` aceita `REQUEST_DUB`.
 */

export interface PreflightGuards {
  /** A janela necessária do vídeo já está em buffer (§59). */
  readonly videoBuffered: boolean
  /** Existe uma track de áudio viva. */
  readonly micLive: boolean
  /** O worklet está instanciado e recebendo blocos. */
  readonly workletReady: boolean
  /** `AudioContext.state === 'running'`. */
  readonly contextRunning: boolean
  /** A aba está visível. */
  readonly visible: boolean
}

export const INITIAL_GUARDS: PreflightGuards = {
  videoBuffered: false,
  micLive: false,
  workletReady: false,
  contextRunning: false,
  visible: true,
}

export interface RecordingContext {
  readonly mode: DubMode
  readonly attempt: number
  readonly countdown: number
  readonly errorCode: DublaErrorCode | null
  readonly guards: PreflightGuards
  readonly clock: RecordingClockInfo | null
  /** `false` quando a aba foi suspensa: a tentativa fica marcada como suspeita. */
  readonly continuityOk: boolean
  readonly autoGainControlActive: boolean
}

export type RecordingEvent =
  | { type: 'SET_MODE'; mode: DubMode }
  | { type: 'REQUEST_DUB' }
  | { type: 'PERMISSION_GRANTED'; autoGainControlActive: boolean }
  | { type: 'FAIL'; code: DublaErrorCode }
  | { type: 'GUARDS'; guards: Partial<PreflightGuards> }
  | { type: 'TICK' }
  | { type: 'CANCEL' }
  | { type: 'STOP' }
  | { type: 'VIDEO_ENDED' }
  | { type: 'TRACK_ENDED' }
  | { type: 'TAB_HIDDEN' }
  | { type: 'CAPTURED'; clock: RecordingClockInfo; continuityOk: boolean }
  | { type: 'TOO_QUIET' }
  | { type: 'ANALYZED' }
  | { type: 'ANALYSIS_FAILED' }
  | { type: 'RETRY' }
  | { type: 'RESET' }

export const recordingMachine = setup({
  types: {
    context: {} as RecordingContext,
    events: {} as RecordingEvent,
    input: {} as { mode: DubMode },
  },
  guards: {
    /** Os cinco pré-requisitos do §19/§59. Todos, sem exceção. */
    canStart: ({ context }) => {
      const { videoBuffered, micLive, workletReady, contextRunning, visible } = context.guards
      return videoBuffered && micLive && workletReady && contextRunning && visible
    },
    countdownFinished: ({ context }) => context.countdown <= 1,
    microphoneNeedsRestart: ({ context }) => !context.guards.micLive,
  },
  actions: {
    mergeGuards: assign({
      guards: ({ context, event }) =>
        event.type === 'GUARDS' ? { ...context.guards, ...event.guards } : context.guards,
    }),
    resetCountdown: assign({ countdown: COUNTDOWN_STEPS }),
    decrementCountdown: assign({
      countdown: ({ context }) => Math.max(0, context.countdown - 1),
    }),
    recordError: assign({
      errorCode: ({ event }) => (event.type === 'FAIL' ? event.code : null),
    }),
    markDisconnected: assign({
      errorCode: 'MIC_DISCONNECTED' as DublaErrorCode,
      guards: ({ context }) => ({ ...context.guards, micLive: false }),
    }),
    clearError: assign({ errorCode: null }),
    storeCapture: assign({
      clock: ({ context, event }) => (event.type === 'CAPTURED' ? event.clock : context.clock),
      continuityOk: ({ context, event }) =>
        event.type === 'CAPTURED' ? event.continuityOk : context.continuityOk,
    }),
    storePermission: assign({
      autoGainControlActive: ({ context, event }) =>
        event.type === 'PERMISSION_GRANTED' ? event.autoGainControlActive : context.autoGainControlActive,
    }),
    nextAttempt: assign({ attempt: ({ context }) => context.attempt + 1 }),
    setMode: assign({
      mode: ({ context, event }) => (event.type === 'SET_MODE' ? event.mode : context.mode),
    }),
  },
}).createMachine({
  id: 'recording',
  initial: 'idle',
  context: ({ input }) => ({
    mode: input.mode,
    attempt: 0,
    countdown: COUNTDOWN_STEPS,
    errorCode: null,
    guards: INITIAL_GUARDS,
    clock: null,
    continuityOk: true,
    autoGainControlActive: false,
  }),

  // Guardas de ambiente chegam a qualquer momento; o modo só muda fora da
  // gravação, o que é garantido pelo estado (só `idle` e `preview` o aceitam).
  on: {
    GUARDS: { actions: 'mergeGuards' },
  },

  states: {
    idle: {
      on: {
        REQUEST_DUB: { target: 'requestingPermission', actions: 'clearError' },
        SET_MODE: { actions: 'setMode' },
      },
    },

    /** Pedido de microfone. A resposta pode demorar: o usuário decide. */
    requestingPermission: {
      on: {
        PERMISSION_GRANTED: { target: 'preparing', actions: 'storePermission' },
        FAIL: { target: 'failed', actions: 'recordError' },
        CANCEL: 'idle',
      },
    },

    /**
     * Espera os cinco guards. Sem tempo limite: ficar aqui é informativo
     * ("Carregando a cena…"), enquanto começar o countdown e o vídeo travar
     * depois produz uma gravação inutilizável (§59).
     */
    preparing: {
      always: { guard: 'canStart', target: 'countdown', actions: 'resetCountdown' },
      on: {
        FAIL: { target: 'failed', actions: 'recordError' },
        CANCEL: 'idle',
      },
    },

    countdown: {
      on: {
        TICK: [
          { guard: 'countdownFinished', target: 'recording', actions: 'decrementCountdown' },
          { actions: 'decrementCountdown' },
        ],
        // §103 — cancelar no countdown não pode deixar gravação ativa.
        CANCEL: { target: 'idle', actions: 'resetCountdown' },
        FAIL: { target: 'failed', actions: 'recordError' },
      },
    },

    recording: {
      on: {
        STOP: 'stopping',
        VIDEO_ENDED: 'stopping',
        // A track morreu: para na hora, mas o que já foi capturado sobrevive.
        TRACK_ENDED: { target: 'stopping', actions: 'markDisconnected' },
        TAB_HIDDEN: 'stopping',
        FAIL: { target: 'failed', actions: 'recordError' },
      },
    },

    /** Finaliza a captura e resolve o offset contra a timeline do vídeo. */
    stopping: {
      on: {
        CAPTURED: { target: 'analyzing', actions: 'storeCapture' },
        TOO_QUIET: { target: 'failed', actions: assign({ errorCode: 'RECORDING_TOO_QUIET' }) },
        FAIL: { target: 'failed', actions: 'recordError' },
      },
    },

    analyzing: {
      on: {
        ANALYZED: 'preview',
        // Análise é conveniência: falhar nela não pode custar a gravação.
        ANALYSIS_FAILED: { target: 'preview', actions: assign({ errorCode: 'ANALYSIS_FAILED' }) },
      },
    },

    preview: {
      on: {
        RETRY: [
          {
            guard: 'microphoneNeedsRestart',
            target: 'requestingPermission',
            actions: ['nextAttempt', 'clearError', 'resetCountdown'],
          },
          { target: 'preparing', actions: ['nextAttempt', 'clearError', 'resetCountdown'] },
        ],
        SET_MODE: { actions: 'setMode' },
        RESET: 'idle',
      },
    },

    failed: {
      on: {
        RETRY: [
          { guard: 'microphoneNeedsRestart', target: 'requestingPermission', actions: 'clearError' },
          { target: 'preparing', actions: 'clearError' },
        ],
        RESET: { target: 'idle', actions: 'clearError' },
      },
    },
  },
})

export type RecordingStateValue =
  | 'idle'
  | 'requestingPermission'
  | 'preparing'
  | 'countdown'
  | 'recording'
  | 'stopping'
  | 'analyzing'
  | 'preview'
  | 'failed'
