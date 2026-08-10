import {
  formatScore,
  type Metric,
  type MetricKey,
  METRIC_DESCRIPTIONS,
  METRIC_LABELS,
  type ScoreResult,
} from '@dubla/shared'
import { cn } from '../lib/cn'

export interface ScoreCardProps {
  readonly result: ScoreResult
  readonly className?: string
}

const BAR_SEGMENTS = 10

/**
 * Apresentação do resultado.
 *
 * A regra estrutural: **nenhum número aparece sem o seu status**. Uma métrica
 * indisponível mostra "—" e o motivo, jamais um zero disfarçado de nota (§12).
 */
export function ScoreCard({ result, className }: ScoreCardProps) {
  const order: MetricKey[] =
    result.mode === 'parody'
      ? ['sync', 'rhythm', 'occupancy']
      : ['sync', 'articulation', 'rhythm', 'pitch', 'energy']

  return (
    <section className={cn('flex flex-col gap-6', className)} aria-label="Resultado da dublagem">
      <header className="border-b-2 border-current pb-4">
        <p className="font-body text-xs font-bold uppercase tracking-[0.2em] opacity-60">
          {result.overall.status === 'unavailable' ? 'Sem resultado' : 'Resultado'}
        </p>
        <p className="font-display text-mega leading-none">{formatScore(result.overall.value)}</p>
        <StatusNote metric={result.overall} />
      </header>

      <ul className="flex flex-col gap-5">
        {order.map((key) => (
          <MetricRow key={key} metricKey={key} metric={result.metrics[key]} />
        ))}
      </ul>

      {result.globalOffsetMs !== 0 ? (
        <p className="border-2 border-current px-4 py-3 text-sm">
          <strong className="font-display uppercase">Atraso do seu setup: </strong>
          {Math.round(result.globalOffsetMs)}&nbsp;ms. Descontamos isso das notas — esse atraso é do
          seu microfone ou fone, não da sua dublagem.
        </p>
      ) : null}
    </section>
  )
}

function MetricRow({ metricKey, metric }: { metricKey: MetricKey; metric: Metric }) {
  const filled =
    metric.value === null ? 0 : Math.round((metric.value / 100) * BAR_SEGMENTS)

  return (
    <li>
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="font-display text-lg uppercase tracking-wide">{METRIC_LABELS[metricKey]}</h3>
        <span className="font-display text-3xl leading-none">{formatScore(metric.value)}</span>
      </div>

      <div
        className="mt-2 flex gap-1"
        role="img"
        aria-label={
          metric.value === null
            ? `${METRIC_LABELS[metricKey]}: indisponível`
            : `${METRIC_LABELS[metricKey]}: ${String(Math.round(metric.value))} de 100`
        }
      >
        {Array.from({ length: BAR_SEGMENTS }, (_, index) => (
          <span
            key={index}
            className={cn(
              'h-3 flex-1 border-2 border-current',
              index < filled && (metric.status === 'ok' ? 'bg-accent' : 'bg-warn'),
            )}
          />
        ))}
      </div>

      <p className="mt-2 text-sm opacity-70">{METRIC_DESCRIPTIONS[metricKey]}</p>
      <StatusNote metric={metric} />
    </li>
  )
}

/** O chip que impede um número de circular sem a sua ressalva. */
function StatusNote({ metric }: { metric: Metric }) {
  if (metric.status === 'ok') return null

  return (
    <p
      className={cn(
        'mt-2 inline-flex flex-wrap items-center gap-2 border-2 px-2 py-1 text-xs',
        metric.status === 'unavailable' ? 'border-muted text-muted' : 'border-warn text-warn',
      )}
    >
      <span className="font-display uppercase tracking-widest">
        {metric.status === 'unavailable' ? 'Indisponível' : 'Precisão limitada'}
      </span>
      {metric.reason ? <span className="opacity-90">— {metric.reason}</span> : null}
    </p>
  )
}
