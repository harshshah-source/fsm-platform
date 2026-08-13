import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { KpiInfo } from './KpiInfo';

export type MetricTone = 'brand' | 'info' | 'success' | 'warning' | 'critical' | 'neutral' | 'verified';

/** Text alignment for a flat metric. `right-xl` = left-aligned below `xl`, right-aligned from `xl` up. */
export type FlatAlign = 'left' | 'right-xl';

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
  /**
   * Opt this metric OUT of the flat treatment its container asks for, so it keeps the card chrome.
   * Set only where the tile is not a plain KPI and the card *is* the design: the Ops-Head hero's
   * Fleet-directory composite (which carries its own two-up panel inside the value slot). `hero`
   * cards opt out implicitly — the inverted black tile is the whole point of them.
   */
  keepCard?: boolean;
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
 *  renders the translucent tone-tinted treatment used by the dashboard hero layout.
 *  `flat` (visual only) drops the card entirely — see `FlatMetric` below. */
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
  keepCard = false,
  flat = false,
  flatAlign = 'left',
}: Metric & { glass?: boolean; flat?: boolean; flatAlign?: FlatAlign }) {
  // A hero tile and the Fleet-directory composite are cards BY DESIGN, so they ignore a container's
  // request to flatten; everything else honours it.
  if (flat && !hero && !keepCard) {
    return (
      <FlatMetric
        label={label} value={value} hint={hint} tone={tone} kpi={kpi} testId={testId}
        onClick={onClick} share={share} align={flatAlign}
      />
    );
  }
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

/**
 * The same KPI, with the card taken away — no border, no surface, no shadow, no radius, no left
 * accent rail. Only type, spacing and alignment separate one figure from the next, so a row of them
 * reads as ONE section of numbers rather than a shelf of floating tiles.
 *
 * Reading order flips versus `MetricCard`: label, then value, then supporting line. A card gives the
 * value its own boundary, so the numeral can lead; strip the boundary and the label has to come
 * first, or a column of bare figures has nothing to say which is which until you have already read
 * past it.
 *
 * Everything else is deliberately identical to the card: same testId placement (on the element that
 * wraps label + value + hint), same click contract (a real `<button>` when `onClick` is set), same
 * `KpiInfo` sibling-not-child rule, same tone semantics. The tone survives as the dot beside the
 * label — the accent rail was the only thing carrying it, and losing it would have made a critical
 * count and a neutral one look alike.
 */
function FlatMetric({ label, value, hint, tone = 'neutral', kpi, testId, onClick, share = null, align = 'left' }: Metric & { align?: FlatAlign }) {
  // `right-xl` is the dashboard hero's right-hand column: the truck backdrop appears at `xl` and
  // reaches ~90px into that column, so from `xl` up the figures hang off the RIGHT edge and the
  // mirrored pair frames the truck instead of sitting on it. Below `xl` the truck is hidden and the
  // columns collapse into a plain stack, so alignment goes back to left with everything else.
  const endXl = align === 'right-xl';
  const className = cn(
    'group relative block w-full text-left',
    endXl && 'xl:text-right',
    // A halo in the PAGE CANVAS colour: invisible against the canvas (it is the canvas), and the one
    // thing keeping these legible where the dashboard hero's truck backdrop passes behind them now
    // that the card's frosted panel is gone. Token-routed, so it follows the theme into dark.
    '[text-shadow:0_0_10px_var(--color-surface-app)]',
    onClick && 'cursor-pointer focus-ring',
  );
  const body = (
    <>
      {/* `pr-6` only when the info affordance is overlaid, so a long label wraps before it rather
          than running underneath it. */}
      <div
        className={cn(
          // `items-start` + the dot's own offset, not `items-center`: a label that wraps to two or
          // three lines in a narrow column would otherwise float its dot down beside the middle line.
          'flex items-start gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-caps',
          kpi && 'pr-6',
          // `justify-end` rather than a reversed row: the dot stays on the label's leading edge, and
          // the info affordance keeps its `pr-6` lane at the far right, beside the label it explains.
          endXl && 'xl:justify-end',
        )}
      >
        <span aria-hidden className={cn('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', SHARE_FILL[tone])} />
        <span>{label}</span>
      </div>
      <div className="mt-2 text-[30px] font-bold leading-none tracking-tight tabular-nums text-ink-strong">
        {value}
      </div>
      {share != null && Number.isFinite(share) && (
        // Capped rather than full-bleed: with no card to bound it, a 100%-wide rule would read as a
        // section divider instead of as this metric's share of its own whole.
        <div className={cn('mt-2.5 h-1 w-full max-w-36 overflow-hidden rounded-full bg-surface-sunken', endXl && 'xl:ml-auto')} aria-hidden>
          <span
            className={cn('block h-full rounded-full', SHARE_FILL[tone])}
            style={{ width: `${Math.max(0, Math.min(1, share)) * 100}%` }}
          />
        </div>
      )}
      {hint && <div className="mt-1.5 text-xs text-ink-muted">{hint}</div>}
    </>
  );
  const metric = onClick ? (
    <button type="button" data-testid={testId} onClick={onClick} className={className}>
      {body}
    </button>
  ) : (
    <div data-testid={testId} className={className}>
      {body}
    </div>
  );
  if (!kpi) return metric;
  // Sibling, not child — same reason as the card: a clickable metric is a <button>, and KpiInfo is
  // one too. Pinned to the label's line, which is now the top of the block.
  return (
    <div className="relative">
      {metric}
      <span className="absolute right-0 top-0 z-20">
        <KpiInfo kpi={kpi} />
      </span>
    </div>
  );
}

/** KPI row. `cols` controls the responsive grid (defaults to 4-up on large screens). */
export function MetricStrip({
  metrics,
  className,
  cols = 4,
  flat = false,
}: {
  metrics: Metric[];
  className?: string;
  cols?: 3 | 4 | 5 | 6;
  /**
   * Render the metrics as one flat KPI grid instead of a row of cards: no per-metric card, columns
   * aligned across rows, and a hairline rule between rows so the whole thing reads as a single
   * section. Opt-in — every other strip in the app keeps the card recipe.
   */
  flat?: boolean;
}) {
  const colClass: Record<number, string> = {
    3: 'lg:grid-cols-3',
    4: 'lg:grid-cols-4',
    5: 'lg:grid-cols-5',
    6: 'lg:grid-cols-6',
  };
  if (flat) {
    // Chunked into explicit rows rather than left to the grid's own wrapping: the separator belongs
    // BETWEEN rows, and a single grid has no handle on "the first item of row 2". Below `lg` the
    // chunks stack (1-up / 2-up) and the rules simply mark where each group of four ends.
    const rows: Metric[][] = [];
    for (let i = 0; i < metrics.length; i += cols) rows.push(metrics.slice(i, i + cols));
    return (
      <div className={cn('mb-6', className)}>
        {rows.map((row, r) => (
          <div
            key={r}
            className={cn(
              'grid grid-cols-1 gap-x-6 gap-y-7 sm:grid-cols-2 xl:gap-x-10',
              colClass[cols],
              r > 0 && 'mt-7 border-t border-line pt-7',
            )}
          >
            {row.map((m, i) => (
              <MetricCard key={i} flat {...m} />
            ))}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className={cn('mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:gap-4', colClass[cols], className)}>
      {metrics.map((m, i) => (
        <MetricCard key={i} {...m} />
      ))}
    </div>
  );
}

