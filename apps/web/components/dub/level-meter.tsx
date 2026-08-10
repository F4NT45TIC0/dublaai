'use client'

export interface LevelMeterProps {
  /** Pico linear 0..1 do último bloco. */
  readonly peak: number
  readonly recording: boolean
}

const SEGMENTS = 24

/**
 * Medidor de nível do microfone.
 *
 * Existe para responder, antes de gravar, a pergunta "ele está me ouvindo?".
 * Sem isso o usuário só descobre que o microfone estava mudo depois de dublar
 * a cena inteira — que é exatamente a frustração que o §25 quer evitar.
 *
 * A escala é logarítmica porque a linear passa quase toda a resolução para
 * volumes altos, e a fala normal ficaria espremida nos primeiros segmentos.
 */
export function LevelMeter({ peak, recording }: LevelMeterProps) {
  const db = peak <= 0 ? -60 : 20 * Math.log10(peak)
  const normalized = Math.min(1, Math.max(0, (db + 60) / 60))
  const filled = Math.round(normalized * SEGMENTS)
  const clipping = peak >= 0.99

  return (
    <div className="flex items-center gap-3">
      <span className="font-body text-[0.6875rem] font-bold uppercase tracking-[0.16em] text-muted">
        {recording ? 'Gravando' : 'Microfone'}
      </span>

      <div
        className="flex flex-1 gap-[2px]"
        role="meter"
        aria-label="Nível do microfone"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(normalized * 100)}
      >
        {Array.from({ length: SEGMENTS }, (_, index) => {
          const active = index < filled
          const hot = index >= SEGMENTS - 3
          return (
            <span
              key={index}
              className={`h-4 flex-1 border ${
                active
                  ? hot || clipping
                    ? 'border-danger bg-danger'
                    : 'border-ok bg-ok'
                  : 'border-ink-line'
              }`}
            />
          )
        })}
      </div>

      {clipping ? (
        <span className="font-display text-xs uppercase tracking-widest text-danger">Estourando</span>
      ) : null}
    </div>
  )
}
