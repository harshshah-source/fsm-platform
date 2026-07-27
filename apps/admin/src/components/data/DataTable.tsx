import { Fragment, useMemo, useRef, useState, type ReactNode } from 'react';
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
  /** Column width for `tableLayout="fixed"` (e.g. `'10%'`, `'120px'`). Ignored in the default auto layout. */
  width?: string;
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
  /**
   * Marks the row that is "open" elsewhere on the page (e.g. the detail drawer's ticket). The row is
   * tinted, carries `aria-current="true"`, and is scrolled into view once when it becomes active.
   */
  rowActive?: (row: T) => boolean;
  /**
   * Visual treatment for the active row. `'info'` (default) is the subtle blue tint; `'danger'` paints
   * it solid red with white text — used on the Tickets list so the open ticket's row reads as selected.
   */
  activeVariant?: 'info' | 'danger';
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
  /**
   * Fixed table layout. `'fixed'` pins the table to 100% of its container so a wide, many-column table
   * never forces a horizontal scroll — columns take their `width` (or divide the space evenly) and long
   * cell text wraps instead of pushing the table wider. Headers stop being nowrap and padding tightens.
   * Default `'auto'` preserves the original content-sized behaviour for every existing table.
   */
  tableLayout?: 'auto' | 'fixed';
  /**
   * Disclosure: when supplied and it returns non-null for a row, that row becomes expandable — a
   * trailing chevron toggles a full-width panel (rendered below the row) holding the returned content.
   * Row click toggles the panel (takes over from `onRowClick`, which expandable tables don't use).
   * Rows for which this returns null render normally with no chevron.
   */
  renderExpanded?: (row: T) => ReactNode;
  /** Leading "S.No." column numbering the current sorted/filtered view from 1. Default `true`. */
  serialNumbers?: boolean;
  /**
   * Added to the 1-based row index before display — for the one table that pages server-side, so
   * page 2 reads 101..200 instead of re-starting at 1. Default `0`; every other table leaves it unset.
   */
  snoOffset?: number;
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
  rowActive,
  activeVariant = 'info',
  loading,
  error,
  onRetry,
  empty,
  stickyHeader = false,
  maxBodyHeight = '70vh',
  tableLayout = 'auto',
  renderExpanded,
  serialNumbers = true,
  snoOffset = 0,
}: DataTableProps<T>) {
  const isFixed = tableLayout === 'fixed';
  // Fixed layout tightens padding and (below) lets headers/cells wrap so many columns fit the width.
  const cellPad = isFixed ? 'px-2.5 py-2.5' : 'px-4 py-3';
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  // Total column count including the S.No. and trailing chevron cells — used for full-width
  // state/expansion rows.
  const totalCols = columns.length + (serialNumbers ? 1 : 0) + (renderExpanded ? 1 : 0);
  const stickyHeaderCellClass =
    stickyHeader && 'sticky top-0 z-10 bg-chrome-900 shadow-[inset_0_-1px_0_var(--color-chrome-700)]';
  // The active row auto-scrolls into view exactly once per row key — not on every re-render, or the
  // table would fight the user's own scrolling on each data refresh.
  const scrolledActiveKey = useRef<string | null>(null);

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
        <table
          aria-label={ariaLabel}
          className={cn('w-full border-collapse text-sm', isFixed && 'table-fixed')}
        >
          {isFixed && (
            <colgroup>
              {serialNumbers && <col style={{ width: '3.5rem' }} />}
              {columns.map((c) => (
                <col key={c.key} style={c.width ? { width: c.width } : undefined} />
              ))}
              {renderExpanded && <col style={{ width: '2.5rem' }} />}
            </colgroup>
          )}
          <thead>
            <tr className="border-b border-chrome-700 bg-chrome-900 text-left">
              {serialNumbers && (
                <th
                  className={cn(
                    cellPad,
                    'w-14 text-right text-[11px] font-bold uppercase tracking-wider text-white tabular-nums',
                    isFixed ? 'align-bottom' : 'whitespace-nowrap',
                    stickyHeaderCellClass,
                  )}
                >
                  S.No.
                </th>
              )}
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
                    cellPad,
                    'text-[11px] font-bold uppercase tracking-wider text-white',
                    isFixed ? 'align-bottom' : 'whitespace-nowrap',
                    c.align === 'right' && 'text-right tabular-nums',
                    c.sortable && 'cursor-pointer select-none hover:text-white/75',
                    // Sticky header: each cell carries its own opaque bg + hairline so it paints cleanly
                    // over scrolling rows (a tr background does not reliably back a sticky th).
                    stickyHeader &&
                      'sticky top-0 z-10 bg-chrome-900 shadow-[inset_0_-1px_0_var(--color-chrome-700)]',
                    c.className,
                  )}
                >
                  {c.header}
                  {c.sortable && sort?.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
              {renderExpanded && (
                <th
                  aria-hidden
                  className={cn(
                    'w-10 px-2 py-3',
                    stickyHeader && 'sticky top-0 z-10 bg-chrome-900 shadow-[inset_0_-1px_0_var(--color-chrome-700)]',
                  )}
                />
              )}
            </tr>
          </thead>
          <tbody>
            {loading &&
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={`sk-${i}`} className="border-b border-line/80 last:border-b-0">
                  {serialNumbers && (
                    // Match the real row's padding exactly so there is no jump on loading → loaded.
                    <td className={cn(cellPad, 'text-right')}>
                      <Skeleton className="ml-auto h-4 w-6" />
                    </td>
                  )}
                  {columns.map((c) => (
                    <td key={c.key} className={cn(cellPad, c.align === 'right' && 'text-right')}>
                      <Skeleton className={cn('h-4 w-24', c.align === 'right' && 'ml-auto')} />
                    </td>
                  ))}
                </tr>
              ))}

            {!loading && error && (
              <tr>
                <td colSpan={totalCols} className="p-0">
                  <ErrorState message={error} onRetry={onRetry} />
                </td>
              </tr>
            )}

            {!loading && !error && sorted.length === 0 && (
              <tr>
                <td colSpan={totalCols} className="p-0">
                  {empty ?? <EmptyState />}
                </td>
              </tr>
            )}

            {!loading &&
              !error &&
              sorted.map((row, index) => {
                const key = rowKey(row);
                const accent = rowAccent?.(row);
                const active = rowActive?.(row) ?? false;
                // Expansion takes precedence over onRowClick: an expandable row toggles its panel.
                const expandedContent = renderExpanded?.(row);
                const canExpand = expandedContent != null;
                const isOpen = canExpand && expanded.has(key);
                const activate = canExpand ? () => toggleExpanded(key) : onRowClick ? () => onRowClick(row) : undefined;
                return (
                  <Fragment key={key}>
                    <tr
                      data-testid={rowTestId?.(row)}
                      aria-current={active ? 'true' : undefined}
                      aria-expanded={canExpand ? isOpen : undefined}
                      ref={
                        active
                          ? (el) => {
                              if (el && scrolledActiveKey.current !== key) {
                                scrolledActiveKey.current = key;
                                // Optional-chained: jsdom has no scrollIntoView.
                                el.scrollIntoView?.({ block: 'nearest' });
                              }
                            }
                          : undefined
                      }
                      onClick={activate}
                      // Keyboard parity for clickable rows: focusable + Enter/Space activate. The <tr> keeps
                      // its implicit `row` role (no role override) so table semantics/selectors stay intact.
                      tabIndex={activate ? 0 : undefined}
                      onKeyDown={
                        activate
                          ? (e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                activate();
                              }
                            }
                          : undefined
                      }
                      className={cn(
                        'border-b border-line/80 last:border-b-0 transition-colors',
                        activate &&
                          'cursor-pointer hover:bg-surface-sunken/70 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-600/50',
                        isOpen && 'bg-surface-sunken/50',
                        accent && `border-l-2 ${accent}`,
                        // Active tint wins over the hover wash; the inset bar marks it even when hovered.
                        // 'danger' paints the whole row red with white text (the `[&>td]:text-white`
                        // overrides each cell's default `text-ink`); coloured badges keep their own fill.
                        active &&
                          (activeVariant === 'danger'
                            ? 'bg-critical text-white hover:bg-critical shadow-[inset_3px_0_0_var(--color-critical)] [&>td]:text-white'
                            : 'bg-info-bg/60 hover:bg-info-bg/60 shadow-[inset_3px_0_0_var(--color-info)]'),
                      )}
                    >
                      {serialNumbers && (
                        <td
                          className={cn(cellPad, 'align-middle text-right text-ink tabular-nums')}
                        >
                          {snoOffset + index + 1}
                        </td>
                      )}
                      {columns.map((c) => (
                        <td
                          key={c.key}
                          className={cn(
                            cellPad,
                            'align-middle text-ink',
                            isFixed && 'break-words',
                            c.align === 'right' && 'text-right tabular-nums',
                            c.className,
                          )}
                        >
                          {c.render ? c.render(row) : null}
                        </td>
                      ))}
                      {renderExpanded && (
                        <td className="w-10 px-2 py-3 text-center align-middle text-ink-muted">
                          {canExpand && (
                            <span aria-hidden className="inline-block transition-transform">
                              {isOpen ? '▾' : '▸'}
                            </span>
                          )}
                        </td>
                      )}
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-line/80 last:border-b-0 bg-surface-sunken/40">
                        <td colSpan={totalCols} className="px-4 py-4 align-top text-ink">
                          {expandedContent}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

