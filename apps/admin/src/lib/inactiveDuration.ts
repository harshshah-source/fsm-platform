// Presentation helpers shared across every inactive-device surface (Issues 2 & 3). Kept in one place
// so the `inactive / total` count and the elapsed-inactivity duration read identically everywhere.

/**
 * `inactive / total` count string (Issue 2), e.g. `12 / 180`. When the total is unknown (a surface or
 * fixture that hasn't wired the denominator yet), degrades to just the inactive count — never `NaN`.
 */
export function formatInactiveOfTotal(inactive: number, total: number | null | undefined): string {
  return typeof total === 'number' && Number.isFinite(total) ? `${inactive} / ${total}` : `${inactive}`;
}

/**
 * Compact elapsed-inactivity duration since the device's last GPS ping (Issue 3), e.g. `20m`, `2h`,
 * `20h`, `1d`, `4d 6h`. Two-unit max, consistent with the existing `AgeChip` "Nd" style. Returns null
 * when there is no timestamp (device never seen) so callers can fall back to their own placeholder.
 */
export function formatInactiveDuration(
  latestGpsDatetime: string | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!latestGpsDatetime) return null;
  const then = new Date(latestGpsDatetime).getTime();
  if (Number.isNaN(then)) return null;
  const totalMinutes = Math.max(0, Math.floor((now.getTime() - then) / 60_000));

  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}
