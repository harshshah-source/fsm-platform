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
  /** When set, the whole card is a click-through (rendered as a button with hover affordance). */
  onClick?: () => void;
  /**
   * Inverted black hero card (uiDashboardRef reference) — visual only. Each dashboard marks its
   * headline KPI; content, testId and click behaviour are identical to a regular card.
   */
  hero?: boolean;
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

/** Single KPI card — big numeral, caps label, optional hint, left tone accent. Clickable when
 *  `onClick` is set (renders as a real button so keyboard/AT get the affordance for free).
 *  `hero` inverts the card to the black reference hero with a red accent. */
export function MetricCard({ label, value, hint, tone = 'neutral', testId, onClick, hero = false }: Metric) {
  const className = cn(
    'group relative block w-full overflow-hidden rounded-card border p-4 text-left shadow-card transition-all hover:-translate-y-0.5 hover:shadow-card-hover',
    'before:absolute before:inset-y-0 before:left-0 before:w-1 before:rounded-l-card',
    hero ? 'border-chrome-700 bg-chrome-900 before:bg-brand-600' : ['border-line bg-surface-card', ACCENT[tone]],
    onClick && 'cursor-pointer focus-ring',
    onClick && !hero && 'hover:border-line-strong',
  );
  const body = (
    <div className="pl-1.5">
      <div className={cn('text-[11px] font-semibold uppercase tracking-wider', hero ? 'text-white/55' : 'text-ink-caps')}>{label}</div>
      <div className={cn('mt-1 text-2xl font-bold tracking-tight', hero ? 'text-white' : 'text-ink-strong')}>{value}</div>
      {hint && <div className={cn('mt-0.5 text-xs', hero ? 'text-white/45' : 'text-ink-muted')}>{hint}</div>}
    </div>
  );
  if (onClick) {
    return (
      <button type="button" data-testid={testId} onClick={onClick} className={className}>
        {body}
      </button>
    );
  }
  return (
    <div data-testid={testId} className={className}>
      {body}
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

