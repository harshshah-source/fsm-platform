import { useState } from 'react';
import { cn } from '../../lib/cn';

const RANGES = ['1D', '7D', '14D', '1M', '3M', '6M', '12M', 'YTD'] as const;
export type DateRange = (typeof RANGES)[number];

/**
 * The `BEST · 1D 7D 14D 1M 3M 6M 12M YTD` toolbar seen across reports/analytics/settings (reference
 * 04/21/26). Controlled (`value`/`onChange`) or self-contained.
 */
export function DateRangeChips({
  value,
  onChange,
  className,
}: {
  value?: DateRange;
  onChange?: (v: DateRange) => void;
  className?: string;
}) {
  const [internal, setInternal] = useState<DateRange>('7D');
  const active = value ?? internal;
  const set = (v: DateRange) => (onChange ? onChange(v) : setInternal(v));

  return (
    <div className={cn('flex flex-wrap items-center gap-1 rounded-full border border-line bg-surface-card p-1 text-[11px] shadow-sm', className)}>
      <span className="mx-1 font-semibold uppercase tracking-wider text-ink-caps">Best</span>
      {RANGES.map((r) => (
        <button
          key={r}
          type="button"
          aria-pressed={active === r}
          onClick={() => set(r)}
          className={cn(
            'rounded-full px-2.5 py-1 font-semibold transition-colors focus-ring',
            active === r
              ? 'bg-brand-600 text-white'
              : 'text-ink-muted hover:bg-surface-sunken hover:text-ink-strong',
          )}
        >
          {r}
        </button>
      ))}
    </div>
  );
}

