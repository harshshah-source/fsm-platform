import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type MetricTone = 'brand' | 'info' | 'success' | 'warning' | 'critical' | 'neutral' | 'verified';

export interface Metric {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: MetricTone;
  /** Optional stable hook for tests / analytics to target a specific KPI card. */
  testId?: string;
}

const ACCENT: Record<MetricTone, string> = {
  brand: 'before:bg-brand-600',
  info: 'before:bg-info',
  success: 'before:bg-success',
  warning: 'before:bg-warning',
  critical: 'before:bg-critical',
  verified: 'before:bg-verified',
  neutral: 'before:bg-neutral',
};

/** Single KPI card — big numeral, caps label, optional hint, left tone accent. */
export function MetricCard({ label, value, hint, tone = 'neutral', testId }: Metric) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'group relative overflow-hidden rounded-card border border-line bg-surface-card p-4 shadow-card transition-all hover:-translate-y-0.5 hover:shadow-card-hover',
        'before:absolute before:inset-y-0 before:left-0 before:w-1 before:rounded-l-card',
        ACCENT[tone],
      )}
    >
      <div className="pl-1.5">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-caps">{label}</div>
        <div className="mt-1 text-2xl font-bold tracking-tight text-ink-strong">{value}</div>
        {hint && <div className="mt-0.5 text-xs text-ink-muted">{hint}</div>}
      </div>
    </div>
  );
}

/** KPI row. `cols` controls the responsive grid (defaults to 4-up on large screens). */
export function MetricStrip({
  metrics,
  className,
  cols = 4,
}: {
  metrics: Metric[];
  className?: string;
  cols?: 3 | 4 | 5 | 6;
}) {
  const colClass: Record<number, string> = {
    3: 'lg:grid-cols-3',
    4: 'lg:grid-cols-4',
    5: 'lg:grid-cols-5',
    6: 'lg:grid-cols-6',
  };
  return (
    <div className={cn('mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:gap-4', colClass[cols], className)}>
      {metrics.map((m, i) => (
        <MetricCard key={i} {...m} />
      ))}
    </div>
  );
}

