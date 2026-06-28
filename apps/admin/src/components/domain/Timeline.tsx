import type { ReactNode } from 'react';

export interface TimelineItem {
  title: ReactNode;
  meta?: ReactNode;
}

/** Vertical event list for lifecycle / assignment / audit history (reference ticket detail). */
export function Timeline({ items, empty = 'No transitions yet.' }: { items: TimelineItem[]; empty?: ReactNode }) {
  if (items.length === 0) {
    return <p className="text-sm text-ink-muted">{empty}</p>;
  }
  return (
    <ol className="flex flex-col gap-3">
      {items.map((it, i) => (
        <li key={i} className="border-l-2 border-line pl-3">
          <div className="text-sm font-medium text-ink-strong">{it.title}</div>
          {it.meta && <div className="text-xs text-ink-muted">{it.meta}</div>}
        </li>
      ))}
    </ol>
  );
}
