import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * The strip that runs along the top of a table card, holding that table's own controls — search,
 * filter selects, sort, download.
 *
 * It is **inside** the table's card, not a floating card of its own. The previous arrangement put the
 * filters in a separate panel with its own border, shadow and margin, which cost a band of empty page
 * for every table and visually divorced a control from the thing it controlled. Here the tools sit
 * directly on the table they filter, sharing one border.
 *
 * Layout: `title` then the controls flow from the left as individual flex items — deliberately *not*
 * as one right-aligned group, which forced the download button onto a third line as soon as the
 * controls filled a row. `trailing` takes `ml-auto` so the download stays pinned to the right edge of
 * whatever the last line turns out to be.
 */
export function TableToolbar({
  title,
  children,
  trailing,
  className,
}: {
  /** Caps label for the table, when the table needs naming inside its own card. */
  title?: ReactNode;
  /** Filter controls — `SearchInput`, `FilterSelect`, chips. */
  children?: ReactNode;
  /** Pinned to the far right after the controls (the download button). */
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-2 gap-y-2 border-b border-line bg-surface-raised/70 px-2.5 py-2',
        className,
      )}
    >
      {title && (
        <span className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-ink-caps">
          {title}
        </span>
      )}
      {children}
      {trailing && <div className="ml-auto flex shrink-0 items-center gap-2">{trailing}</div>}
    </div>
  );
}
