import { describe, expect, it } from 'vitest'
import { createActor, type Actor } from 'xstate'
import type { RecordingClockInfo } from '@dubla/shared'
import { INITIAL_GUARDS, recordingMachine } from '../machine/recording-machine'
import { checkContinuity, RecordingBuffer } from '../capture/recording-buffer'

const ALL_GUARDS_OK = {
  videoBuffered: true,
  micLive: true,
  workletReady: true,
  contextRunning: true,
  visible: true,
}

const CLOCK: RecordingClockInfo = {
  sampleRate: 48_000,
  startFrame: 1_000,
  videoStartMediaTime: 0,
  mediaStartOffsetMs: -3_000,
  estimatedInputLatencyMs: 12,
  clockConfidence: 0.98,
  sampleContinuityOk: true,
}

function start(): Actor<typeof recordingMachine> {
  const actor = createActor(recordingMachine, { input: { mode: 'original' } })
  actor.start()
  return actor
}

function stateOf(actor: Actor<typeof recordingMachine>): string {
  const { value } = actor.getSnapshot()
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** Leva a máquina até `recording` pelo caminho normal. */
function driveToRecording(actor: Actor<typeof recordingMachine>): void {
  actor.send({ type: 'REQUEST_DUB' })
  actor.send({ type: 'PERMISSION_GRANTED', autoGainControlActive: false })
  actor.send({ type: 'GUARDS', guards: ALL_GUARDS_OK })
  actor.send({ type: 'TICK' })
  actor.send({ type: 'TICK' })
  actor.send({ type: 'TICK' })
}

describe('máquina de gravação — caminho feliz', () => {
  it('percorre idle → gravação → resultado', () => {
    const actor = start()
    expect(stateOf(actor)).toBe('idle')

    actor.send({ type: 'REQUEST_DUB' })
    expect(stateOf(actor)).toBe('requestingPermission')

    actor.send({ type: 'PERMISSION_GRANTED', autoGainControlActive: false })
    expect(stateOf(actor)).toBe('preparing')

    actor.send({ type: 'GUARDS', guards: ALL_GUARDS_OK })
    expect(stateOf(actor)).toBe('countdown')
    expect(actor.getSnapshot().context.countdown).toBe(3)

    actor.send({ type: 'TICK' })
    expect(actor.getSnapshot().context.countdown).toBe(2)
    actor.send({ type: 'TICK' })
    actor.send({ type: 'TICK' })
    expect(stateOf(actor)).toBe('recording')

    actor.send({ type: 'VIDEO_ENDED' })
    expect(stateOf(actor)).toBe('stopping')

    actor.send({ type: 'CAPTURED', clock: CLOCK, continuityOk: true })
    expect(stateOf(actor)).toBe('analyzing')

    actor.send({ type: 'ANALYZED' })
    expect(stateOf(actor)).toBe('preview')
    expect(actor.getSnapshot().context.clock?.mediaStartOffsetMs).toBe(-3_000)
  })
})

describe('guards de pré-voo (§19, §59)', () => {
  it('não começa o countdown com o vídeo ainda em buffer', () => {
    const actor = start()
    actor.send({ type: 'REQUEST_DUB' })
    actor.send({ type: 'PERMISSION_GRANTED', autoGainControlActive: false })

    actor.send({ type: 'GUARDS', guards: { ...ALL_GUARDS_OK, videoBuffered: false } })
    expect(stateOf(actor)).toBe('preparing')

    actor.send({ type: 'GUARDS', guards: { videoBuffered: true } })
    expect(stateOf(actor)).toBe('countdown')
  })

  it.each(['micLive', 'workletReady', 'contextRunning', 'visible'] as const)(
    'não começa sem %s',
    (guard) => {
      const actor = start()
      actor.send({ type: 'REQUEST_DUB' })
      actor.send({ type: 'PERMISSION_GRANTED', autoGainControlActive: false })
      actor.send({ type: 'GUARDS', guards: { ...ALL_GUARDS_OK, [guard]: false } })

      expect(stateOf(actor)).toBe('preparing')
    },
  )

  it('parte de todos os guards falsos', () => {
    const actor = start()
    expect(actor.getSnapshot().context.guards).toEqual(INITIAL_GUARDS)
  })
})

describe('race conditions do §56', () => {
  it('ignora um segundo clique em DUBLAR', () => {
    const actor = start()
    actor.send({ type: 'REQUEST_DUB' })
    const first = stateOf(actor)

    // O segundo clique não pode reiniciar o pedido de permissão.
    actor.send({ type: 'REQUEST_DUB' })
    expect(stateOf(actor)).toBe(first)
  })

  it('cancelar durante o countdown volta para idle sem gravar', () => {
    const actor = start()
    actor.send({ type: 'REQUEST_DUB' })
    actor.send({ type: 'PERMISSION_GRANTED', autoGainControlActive: false })
    actor.send({ type: 'GUARDS', guards: ALL_GUARDS_OK })
    actor.send({ type: 'TICK' })

    actor.send({ type: 'CANCEL' })
    expect(stateOf(actor)).toBe('idle')
    // §103 — o countdown volta ao início, não fica pela metade.
    expect(actor.getSnapshot().context.countdown).toBe(3)
  })

  it('STOP fora da gravação não faz nada', () => {
    const actor = start()
    actor.send({ type: 'STOP' })
    expect(stateOf(actor)).toBe('idle')
  })

  it('a track morrer no meio para a gravação preservando o áudio', () => {
    const actor = start()
    driveToRecording(actor)

    actor.send({ type: 'TRACK_ENDED' })
    expect(stateOf(actor)).toBe('stopping')
    expect(actor.getSnapshot().context.guards.micLive).toBe(false)

    // O que foi capturado ainda chega ao resultado.
    actor.send({ type: 'CAPTURED', clock: CLOCK, continuityOk: true })
    actor.send({ type: 'ANALYZED' })
    expect(stateOf(actor)).toBe('preview')

    actor.send({ type: 'RETRY' })
    expect(stateOf(actor)).toBe('requestingPermission')
  })

  it('aba escondida interrompe a gravação (§104)', () => {
    const actor = start()
    driveToRecording(actor)

    actor.send({ type: 'TAB_HIDDEN' })
    expect(stateOf(actor)).toBe('stopping')

    actor.send({ type: 'CAPTURED', clock: CLOCK, continuityOk: false })
    expect(actor.getSnapshot().context.continuityOk).toBe(false)
  })

  it('falha de análise não custa a gravação', () => {
    const actor = start()
    driveToRecording(actor)
    actor.send({ type: 'VIDEO_ENDED' })
    actor.send({ type: 'CAPTURED', clock: CLOCK, continuityOk: true })

    actor.send({ type: 'ANALYSIS_FAILED' })
    expect(stateOf(actor)).toBe('preview')
    expect(actor.getSnapshot().context.errorCode).toBe('ANALYSIS_FAILED')
  })

  it('eventos tardios da tentativa anterior não afetam a nova', () => {
    const actor = start()
    driveToRecording(actor)
    actor.send({ type: 'VIDEO_ENDED' })
    actor.send({ type: 'CAPTURED', clock: CLOCK, continuityOk: true })
    actor.send({ type: 'ANALYZED' })

    actor.send({ type: 'RETRY' })
    expect(actor.getSnapshot().context.attempt).toBe(1)
    // Os guards continuam satisfeitos, então a nova tentativa já está no
    // countdown — não há motivo para esperar por um vídeo que já está em buffer.
    expect(stateOf(actor)).toBe('countdown')

    // Um CAPTURED atrasado, da tentativa anterior, chega agora.
    actor.send({ type: 'CAPTURED', clock: CLOCK, continuityOk: false })

    // O evento é ignorado: a nova tentativa segue seu curso e o contexto não é
    // contaminado pelo resultado velho.
    expect(stateOf(actor)).toBe('countdown')
    expect(actor.getSnapshot().context.continuityOk).toBe(true)
  })
})

describe('permissão e erros', () => {
  it('permissão negada leva a um estado de falha com código', () => {
    const actor = start()
    actor.send({ type: 'REQUEST_DUB' })
    actor.send({ type: 'FAIL', code: 'MIC_PERMISSION_DENIED' })

    expect(stateOf(actor)).toBe('failed')
    expect(actor.getSnapshot().context.errorCode).toBe('MIC_PERMISSION_DENIED')
  })

  it('tentar novamente depois da falha volta a pedir permissão e limpa o erro', () => {
    const actor = start()
    actor.send({ type: 'REQUEST_DUB' })
    actor.send({ type: 'FAIL', code: 'MIC_BUSY' })

    actor.send({ type: 'RETRY' })
    expect(stateOf(actor)).toBe('requestingPermission')
    expect(actor.getSnapshot().context.errorCode).toBeNull()
  })

  it('gravação inaudível não vira resultado (§100)', () => {
    const actor = start()
    driveToRecording(actor)
    actor.send({ type: 'STOP' })

    actor.send({ type: 'TOO_QUIET' })
    expect(stateOf(actor)).toBe('failed')
    expect(actor.getSnapshot().context.errorCode).toBe('RECORDING_TOO_QUIET')
  })

  it('guarda que o navegador aplicou AGC contra a nossa constraint', () => {
    const actor = start()
    actor.send({ type: 'REQUEST_DUB' })
    actor.send({ type: 'PERMISSION_GRANTED', autoGainControlActive: true })
    expect(actor.getSnapshot().context.autoGainControlActive).toBe(true)
  })
})

describe('modo', () => {
  it('pode ser trocado fora da gravação', () => {
    const actor = start()
    actor.send({ type: 'SET_MODE', mode: 'parody' })
    expect(actor.getSnapshot().context.mode).toBe('parody')
  })

  it('não muda no meio da gravação', () => {
    const actor = start()
    driveToRecording(actor)

    actor.send({ type: 'SET_MODE', mode: 'parody' })
    expect(actor.getSnapshot().context.mode).toBe('original')
  })
})

describe('RecordingBuffer', () => {
  it('concatena os blocos na ordem em que chegaram', () => {
    const buffer = new RecordingBuffer()
    buffer.append(Float32Array.from([0.1, 0.2]))
    buffer.append(Float32Array.from([0.3]))
    buffer.append(Float32Array.from([0.4, 0.5]))

    expect(buffer.sampleCount).toBe(5)
    expect(Array.from(buffer.toFloat32Array()).map((v) => +v.toFixed(2))).toEqual([
      0.1, 0.2, 0.3, 0.4, 0.5,
    ])
  })

  it('limpa para a próxima tentativa', () => {
    const buffer = new RecordingBuffer()
    buffer.append(Float32Array.from([1, 2, 3]))
    buffer.clear()
    expect(buffer.sampleCount).toBe(0)
    expect(buffer.toFloat32Array()).toHaveLength(0)
  })
})

describe('checkContinuity (§104)', () => {
  it('aceita uma gravação completa', () => {
    // 2 s a 48 kHz = 96000 amostras.
    const check = checkContinuity(96_000, 10, 12, 48_000)
    expect(check.ok).toBe(true)
    expect(check.missingRatio).toBe(0)
  })

  it('tolera a variação normal de blocos', () => {
    expect(checkContinuity(95_000, 10, 12, 48_000).ok).toBe(true)
  })

  it('detecta o buraco deixado por uma aba suspensa', () => {
    // O relógio andou 2 s, mas só chegou 1 s de áudio.
    const check = checkContinuity(48_000, 10, 12, 48_000)
    expect(check.ok).toBe(false)
    expect(check.missingRatio).toBeCloseTo(0.5, 2)
  })

  it('não divide por zero quando nada foi gravado', () => {
    const check = checkContinuity(0, 10, 10, 48_000)
    expect(check.ok).toBe(true)
    expect(check.expectedSamples).toBe(0)
  })
})
