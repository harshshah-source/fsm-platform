import { CHART } from './colors';

export interface BarListItem {
  label: string;
  value: number;
  color?: string;
  /**
   * Stable identity for the row, when `label` is not unique. Two different entities can format to the
   * same display string (two plants sharing a name prefix, for instance) — keying on the label alone
   * then collides in React and silently renders one row for two entities.
   */
  id?: string;
}

/**
 * Label — bar — count rows (reference "Work type mix" / "Verification outcomes" panels). Pure CSS,
 * scaled to the largest value, so it renders identically in tests and the browser — no chart library.
 *
 * `labelWidth` widens the label gutter for long entity names. Truncation is still possible, so a
 * caller with long labels should put the DISTINGUISHING part first — a name that truncates to the
 * same string as its neighbour is worse than no label.
 */
export function BarList({
  items,
  color = CHART.info,
  labelWidth = 'w-32',
}: {
  items: BarListItem[];
  color?: string;
  labelWidth?: string;
}) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <ul className="space-y-2.5">
      {items.map((item, i) => (
        <li key={item.id ?? `${item.label}-${i}`} className="flex items-center gap-3 text-sm">
          <span className={`${labelWidth} shrink-0 truncate text-xs text-ink-muted`} title={item.label}>
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
