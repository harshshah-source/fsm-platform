import { Link } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { formatInactiveOfTotal } from '../../lib/inactiveDuration';

/**
 * The `inactive / total` count as a click-through into the Device Detail list, pre-filtered to exactly
 * the inactive devices the count represents. `scope` carries the entity params the Device Detail page
 * already reads from the query string (`zoneId`, `companyId`, `plantId`, …); `status=INACTIVE` is added
 * here so the destination opens showing only those devices — the same deep-link contract the Zone
 * Scorecard's Critical count uses.
 *
 * The whole `N / M` string is one link (never split across nodes) so it reads as a single affordance
 * and existing text assertions keep matching. A zero inactive count is not a link — there is nothing to
 * drill into — it renders as muted plain text. `stopPropagation` keeps a row-level click handler (row
 * expand / row navigate) from also firing when the count itself is clicked.
 */
export function InactiveCountLink({
  inactive,
  total,
  scope,
  className,
}: {
  inactive: number;
  total: number | null | undefined;
  /** Device Detail query params identifying the scope, e.g. `{ zoneId }`, `{ companyId }`, `{ plantId }`. */
  scope: Record<string, string>;
  className?: string;
}) {
  const label = formatInactiveOfTotal(inactive, total);
  if (inactive <= 0) {
    return <span className={cn('tabular-nums text-ink-muted', className)}>{label}</span>;
  }
  const params = new URLSearchParams({ ...scope, status: 'INACTIVE' });
  return (
    <Link
      to={`/reports/device?${params.toString()}`}
      onClick={(e) => e.stopPropagation()}
      title="View these inactive devices"
      className={cn(
        'tabular-nums font-semibold text-link underline-offset-2 hover:underline',
        className,
      )}
    >
      {label}
    </Link>
  );
}
