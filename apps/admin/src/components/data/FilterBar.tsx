import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { IconSearch } from '../ui/icons';

/**
 * Inline group of filter controls.
 *
 * No longer a card. Filters belong to a table, so they now ride inside that table's card via
 * `TableToolbar` (or `DataTable`'s `toolbar` prop) — this stays only as a plain flex group for the
 * few places that need to cluster controls somewhere other than a table header.
 */
export function FilterBar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center gap-2', className)}>{children}</div>;
}

/** Rounded search input with a leading icon. */
export function SearchInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="relative">
      <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" />
      <input
        className={cn(
          'h-8 w-52 rounded-md border border-line bg-surface-card pl-8 pr-2.5 text-[13px] text-ink-strong shadow-sm transition-colors',
          'placeholder:text-ink-muted hover:border-line-strong focus-visible:border-brand-600 focus-ring',
          className,
        )}
        {...rest}
      />
    </div>
  );
}

/**
 * Styled native select for filters. Fixed-width rather than content-sized: a toolbar of seven
 * self-sizing selects ("All assignment states" being far wider than "Zone") wrapped onto three lines
 * and read as ragged. At this width the long labels ellipsize, which the open dropdown resolves.
 */
export function FilterSelect({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'h-8 w-[8.75rem] rounded-md border border-line bg-surface-card px-2 text-[13px] text-ink-strong shadow-sm transition-colors',
        'hover:border-line-strong focus-visible:border-brand-600 focus-ring',
        className,
      )}
      {...rest}
    />
  );
}
