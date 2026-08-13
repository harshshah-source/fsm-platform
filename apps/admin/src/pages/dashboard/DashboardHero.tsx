import type { ReactNode } from 'react';
import { MetricCard, type Metric } from '../../components/data';
import { cn } from '../../lib/cn';
import truckImage from '../../assets/truck.png';

/* Explicit grid placement per side-column slot (xl hero layout). Literal strings so Tailwind's
 * content scanner sees them (same pitfall as the MetricStrip cols safelist). Max 3 cards per side. */
const ROW_START: Record<number, string> = {
  1: 'xl:row-start-1',
  2: 'xl:row-start-2',
  3: 'xl:row-start-3',
};

/**
 * The tiles that stay cards inside the hero. `hero` is the inverted black headline tile (Fleet
 * Uptime on every manager dashboard); `keepCard` is the Ops-Head Fleet-directory composite, whose
 * value slot holds its own two-up panel. Every other KPI here renders flat.
 */
const isCard = (m: Metric) => Boolean(m.hero || m.keepCard);

/**
 * Dashboard hero (docs/ui/hero-ref.jpg): the truck asset as a background layer with the KPI figures
 * in columns on both sides of it, and an optional bottom strip (Auto-Dispatch efficiency) riding
 * over the truck's lower edge. Purely presentational — the tiles are the same `MetricCard`s the
 * strip renders (testIds, RollingNumbers and click-through included), now in their flat form:
 * label · value · supporting line, with no panel around them. The Fleet-Uptime hero tile and the
 * Fleet-directory composite keep their glass cards.
 *
 * Below `xl` the truck hides and every card falls back to the classic 1-col / 2-col metric grid,
 * so narrow screens see exactly the pre-hero stacking.
 */
export function DashboardHero({
  title,
  actions,
  left,
  right,
  bottom,
  bottomHeading,
  bottomHeadingId = 'hero-bottom-strip-heading',
  centerBelow,
}: {
  title: ReactNode;
  /** Header-row extras (Snapshot Healthy pill, period selector) — right-aligned over the hero. */
  actions?: ReactNode;
  /** Cards for the left column beside the truck (max 3). */
  left: Metric[];
  /** Cards for the right column beside the truck (max 3). */
  right: Metric[];
  /** Optional 4-up strip overlapping the truck's lower edge (Ops-Head efficiency row). */
  bottom?: Metric[];
  bottomHeading?: ReactNode;
  bottomHeadingId?: string;
  centerBelow?: ReactNode;
}) {
  const sideRows = Math.max(left.length, right.length);
  return (
    <section className="relative mb-8">
      {/* Title is screen-reader-only, matching `PageHeader`: the breadcrumb already names the page,
          and on the one screen where the hero itself is the headline a second text title just
          pushed the KPI cards down. Actions keep their slim right-aligned row. */}
      <h2 className="sr-only">{title}</h2>
      {actions && (
        <div className="relative z-10 mb-3 flex flex-wrap items-center justify-end gap-2">{actions}</div>
      )}

      <div className="relative">
        {/* Truck backdrop (-z layer). The asset ships a baked-in studio-gray background, so a radial
            mask fades it into the page canvas; the hue-rotate pulls its purple cargo panels to the
            brand red. Decorative only — hidden from AT and from every viewport below xl. */}
        <img
          src={truckImage}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-[47%] z-0 hidden w-[64%] max-w-[860px] -translate-x-1/2 -translate-y-1/2 select-none opacity-95 xl:block [filter:hue-rotate(95deg)_saturate(0.85)] [mask-image:radial-gradient(ellipse_72%_68%_at_50%_50%,black_52%,transparent_76%)]"
        />

        {/* One grid, two behaviours: below xl it is the classic metric grid (1-col / sm 2-col, cards
            in reading order); at xl each card is pinned into a side column flanking the truck. */}
        <div className="relative grid grid-cols-1 gap-3 sm:grid-cols-2 xl:min-h-[564px] xl:grid-cols-[minmax(230px,300px)_minmax(0,1fr)_minmax(230px,300px)] xl:content-start xl:gap-x-4 xl:gap-y-20">
          {left.map((m, i) => (
            <div key={`l-${i}`} className={cn('xl:col-start-1', ROW_START[i + 1])}>
              <MetricCard {...m} flat glass={isCard(m)} />
            </div>
          ))}
          {right.map((m, i) => (
            <div key={`r-${i}`} className={cn('xl:col-start-3', ROW_START[i + 1])}>
              {/* Right column hangs off its right edge from `xl` up — see `FlatMetric`: the truck
                  reaches into this column, and without a card behind them the figures would sit on
                  its rear. Mirrored, the two columns frame the truck. */}
              <MetricCard {...m} flat flatAlign="right-xl" glass={isCard(m)} />
            </div>
          ))}
          {bottom && (
            <section
              aria-labelledby={bottomHeadingId}
              className={cn('sm:col-span-2 xl:col-span-1 xl:col-start-2 xl:self-end xl:px-2', ROW_START[sideRows])}
            >
              {bottomHeading && (
                <h3
                  id={bottomHeadingId}
                  className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-caps"
                >
                  {bottomHeading}
                </h3>
              )}
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {bottom.map((m, i) => (
                  <MetricCard key={`b-${i}`} {...m} flat glass={isCard(m)} />
                ))}
              </div>
            </section>
          )}
          {centerBelow && (
            <div className="sm:col-span-2 xl:absolute xl:-bottom-6 xl:left-[25%] xl:right-[25%] xl:z-10">
              {centerBelow}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}



