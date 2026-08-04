import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { KpiInfo } from './KpiInfo';

export type MetricTone = 'brand' | 'info' | 'success' | 'warning' | 'critical' | 'neutral' | 'verified';

export interface Metric {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: MetricTone;
  /**
   * A `lib/kpiCatalog` key. Renders the info affordance beside the label, so every KPI carries its own
   * definition, exclusions, source and formula (Part 10 transparency). Omit only for cards that are
   * not a metric (e.g. the Fleet-directory composite card).
   */
  kpi?: string;
  /** Optional stable hook for tests / analytics to target a specific KPI card. */
  testId?: string;
  /** When set, the whole card is a click-through (rendered as a button with hover affordance). */
  onClick?: () => void;
  /**
   * Inverted black hero card (uiDashboardRef reference) — visual only. Each dashboard marks its
   * headline KPI; content, testId and click behaviour are identical to a regular card.
   */
  hero?: boolean;
  /**
   * This metric's share of its own whole, 0–1. Renders a thin proportion bar under the value in the
   * card's tone — the reference point a bare count cannot give you ("874 inactive" means nothing
   * until you can see it is a third of the fleet). Supply it only where a share is actually
   * meaningful: a count against the population it came out of. Omit for rates (already a share of
   * something) and for counts with no natural denominator.
   */
  share?: number | null;
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

/* Fill for the optional share bar — the same tone the card's left accent already carries, so the two
 * cannot disagree about what kind of number this is. */
const SHARE_FILL: Record<MetricTone, string> = {
  brand: 'bg-brand-600',
  info: 'bg-info',
  success: 'bg-success',
  warning: 'bg-warning',
  critical: 'bg-critical',
  verified: 'bg-verified',
  neutral: 'bg-neutral',
};

/* Frosted-glass tint per tone (DashboardHero cards floating over the truck imagery) — a translucent
 * tone wash fading into the card surface, over a backdrop blur. Token-routed via opacity modifiers. */
const GLASS: Record<MetricTone, string> = {
  brand: 'from-brand-600/15 to-surface-card/75',
  info: 'from-info/15 to-surface-card/75',
  success: 'from-success/15 to-surface-card/75',
  warning: 'from-warning/20 to-surface-card/75',
  critical: 'from-critical/15 to-surface-card/75',
  verified: 'from-verified/15 to-surface-card/75',
  neutral: 'from-neutral/10 to-surface-card/75',
};

/** Single KPI card — big numeral, caps label, optional hint, left tone accent. Clickable when
 *  `onClick` is set (renders as a real button so keyboard/AT get the affordance for free).
 *  `hero` inverts the card to the black reference hero with a red accent. `glass` (visual only)
 *  renders the translucent tone-tinted treatment used by the dashboard hero layout. */
export function MetricCard({
  label,
  value,
  hint,
  tone = 'neutral',
  kpi,
  testId,
  onClick,
  hero = false,
  glass = false,
  share = null,
}: Metric & { glass?: boolean }) {
  const className = cn(
    'group relative block w-full overflow-hidden rounded-card border p-4 text-left shadow-card transition-all hover:-translate-y-0.5 hover:shadow-card-hover',
    'before:absolute before:inset-y-0 before:left-0 before:w-1 before:rounded-l-card',
    hero
      ? [glass ? 'border-chrome-700/70 bg-chrome-900/85 backdrop-blur-md' : 'border-chrome-700 bg-chrome-900', 'before:bg-brand-600']
      // The glass edge is a token, not `white/60`: on the dark canvas a white hairline reads as a
      // stray highlight, whereas `line-strong` stays the "slightly brighter than the fill" edge.
      : [ACCENT[tone], glass ? ['border-line-strong/60 bg-gradient-to-br backdrop-blur-md', GLASS[tone]] : 'border-line bg-surface-card'],
    onClick && 'cursor-pointer focus-ring',
    onClick && !hero && 'hover:border-line-strong',
  );
  // The number leads. A KPI card is read by scanning values down a row and stopping at the one that
  // looks wrong — a caps label above the figure puts the least distinctive thing in the scan path, so
  // the value now comes first at a size that reads at arm's length, with the label secondary beneath
  // it. `tabular-nums` keeps digits column-aligned so two cards' values can be compared by width.
  const body = (
    <div className="pl-1.5">
      <div
        className={cn(
          'text-[28px] font-bold leading-none tracking-tight tabular-nums',
          hero ? 'text-white' : 'text-ink-strong',
        )}
      >
        {value}
      </div>
      <div
        className={cn(
          'mt-1.5 text-[11px] font-semibold uppercase tracking-wider',
          hero ? 'text-white/55' : 'text-ink-caps',
        )}
      >
        {label}
      </div>
      {share != null && Number.isFinite(share) && (
        <div
          className={cn('mt-2 h-1 w-full overflow-hidden rounded-full', hero ? 'bg-white/15' : 'bg-surface-sunken')}
          // The bar restates the value's share of its own whole; the hint below names the whole, so
          // the pair is self-describing and the bar is never decoration.
          aria-hidden
        >
          <span
            className={cn('block h-full rounded-full', hero ? 'bg-white/70' : SHARE_FILL[tone])}
            style={{ width: `${Math.max(0, Math.min(1, share)) * 100}%` }}
          />
        </div>
      )}
      {hint && <div className={cn('mt-1 text-xs', hero ? 'text-white/45' : 'text-ink-muted')}>{hint}</div>}
    </div>
  );
  const card = onClick ? (
    <button type="button" data-testid={testId} onClick={onClick} className={className}>
      {body}
    </button>
  ) : (
    <div data-testid={testId} className={className}>
      {body}
    </div>
  );
  if (!kpi) return card;
  // The info trigger is a SIBLING of the card, not a child: a clickable card renders as a <button>,
  // and a button inside a button is invalid HTML (React warns, and the inner click target is
  // unreliable). Overlaying it in the corner keeps both affordances real.
  return (
    <div className="relative">
      {card}
      <span className="absolute right-2.5 top-3 z-20">
        <KpiInfo kpi={kpi} tone={hero ? 'muted' : 'default'} />
      </span>
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

