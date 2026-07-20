import { CHART } from './colors';

export interface BarListItem {
  label: string;
  value: number;
  color?: string;
}

/**
 * Label — bar — count rows (reference "Work type mix" / "Verification outcomes" panels). Pure CSS,
 * scaled to the largest value, so it renders identically in tests and the browser — no chart library.
 */
export function BarList({ items, color = CHART.info }: { items: BarListItem[]; color?: string }) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <ul className="space-y-2.5">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-3 text-sm">
          <span className="w-32 shrink-0 truncate text-xs text-ink-muted" title={item.label}>
            {item.label}
          </span>
          <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-surface-sunken">
            <span
              className="block h-full rounded-full transition-[width] duration-300"
              style={{ width: `${(100 * item.value) / max}%`, background: item.color ?? color }}
            />
          </span>
          <span className="w-8 shrink-0 text-right text-xs font-semibold tabular-nums text-ink-strong">
            {item.value}
          </span>
        </li>
      ))}
    </ul>
  );
}
