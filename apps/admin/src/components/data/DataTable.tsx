import { useMemo, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { EmptyState, ErrorState, Skeleton } from './feedback';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render?: (row: T) => ReactNode;
  align?: 'left' | 'right';
  className?: string;
  /** Mark sortable + provide the comparable value. */
  sortable?: boolean;
  sortValue?: (row: T) => string | number;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  ariaLabel: string;
  onRowClick?: (row: T) => void;
  /** Per-row test id (applied as data-testid) — keeps existing selector contracts intact. */
  rowTestId?: (row: T) => string;
  /** Left accent colour class per row (e.g. severity), applied as a left border. */
  rowAccent?: (row: T) => string | undefined;
  loading?: boolean;
  error?: string | null;
  /** Retry handler surfaced by the built-in inline error state. */
  onRetry?: () => void;
  empty?: ReactNode;
  /**
   * Pin the header while the body scrolls. Constrains the table to `maxBodyHeight` (default `70vh`) with
   * internal vertical scroll and a sticky, opaque header row — the premium pattern for long lists.
   */
  stickyHeader?: boolean;
  maxBodyHeight?: string;
}

/**
 * Canonical dense data table (FE-03). Caps headers, hover rows, optional sort / row-accent, and built-in
 * loading / error / empty states. Replaces the bespoke `<table>` markup across the queue pages while
 * preserving each page's `aria-label`, row `data-testid`, and row-click behaviour.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  ariaLabel,
  onRowClick,
  rowTestId,
  rowAccent,
  loading,
  error,
  onRetry,
  empty,
  stickyHeader = false,
  maxBodyHeight = '70vh',
}: DataTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const sv = col.sortValue;
    const out = [...rows].sort((a, b) => {
      const x = sv(a);
      const y = sv(b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    return sort.dir === 'asc' ? out : out.reverse();
  }, [rows, sort, columns]);

  const toggleSort = (c: Column<T>) => {
    if (!c.sortable) return;
    setSort((s) =>
      s?.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: 'asc' },
    );
  };

  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface-card shadow-card">
      <div
        className={cn('overflow-x-auto', stickyHeader && 'overflow-y-auto')}
        style={stickyHeader ? { maxHeight: maxBodyHeight } : undefined}
      >
        <table aria-label={ariaLabel} className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-line bg-surface-raised text-left">
              {columns.map((c) => (
                <th
                  key={c.key}
                  onClick={() => toggleSort(c)}
                  aria-sort={
                    sort?.key === c.key
                      ? sort.dir === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : undefined
                  }
                  className={cn(
                    'whitespace-nowrap px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-ink-caps',
                    c.align === 'right' && 'text-right tabular-nums',
                    c.sortable && 'cursor-pointer select-none hover:text-ink-strong',
                    // Sticky header: each cell carries its own opaque bg + hairline so it paints cleanly
                    // over scrolling rows (a tr background does not reliably back a sticky th).
                    stickyHeader &&
                      'sticky top-0 z-10 bg-surface-raised shadow-[inset_0_-1px_0_var(--color-line)]',
                    c.className,
                  )}
                >
                  {c.header}
                  {c.sortable && sort?.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading &&
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={`sk-${i}`} className="border-b border-line/80 last:border-b-0">
                  {columns.map((c) => (
                    // Match the real row's px-4 py-3 exactly so there is no jump on loading → loaded.
                    <td key={c.key} className={cn('px-4 py-3', c.align === 'right' && 'text-right')}>
                      <Skeleton className={cn('h-4 w-24', c.align === 'right' && 'ml-auto')} />
                    </td>
                  ))}
                </tr>
              ))}

            {!loading && error && (
              <tr>
                <td colSpan={columns.length} className="p-0">
                  <ErrorState message={error} onRetry={onRetry} />
                </td>
              </tr>
            )}

            {!loading && !error && sorted.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="p-0">
                  {empty ?? <EmptyState />}
                </td>
              </tr>
            )}

            {!loading &&
              !error &&
              sorted.map((row) => {
                const accent = rowAccent?.(row);
                return (
                  <tr
                    key={rowKey(row)}
                    data-testid={rowTestId?.(row)}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    // Keyboard parity for clickable rows: focusable + Enter/Space activate. The <tr> keeps
                    // its implicit `row` role (no role override) so table semantics/selectors stay intact.
                    tabIndex={onRowClick ? 0 : undefined}
                    onKeyDown={
                      onRowClick
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onRowClick(row);
                            }
                          }
                        : undefined
                    }
                    className={cn(
                      'border-b border-line/80 last:border-b-0 transition-colors',
                      onRowClick &&
                        'cursor-pointer hover:bg-surface-sunken/70 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-600/50',
                      accent && `border-l-2 ${accent}`,
                    )}
                  >
                    {columns.map((c) => (
                      <td
                        key={c.key}
                        className={cn(
                          'px-4 py-3 align-middle text-ink',
                          c.align === 'right' && 'text-right tabular-nums',
                          c.className,
                        )}
                      >
                        {c.render ? c.render(row) : null}
                      </td>
                    ))}
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

