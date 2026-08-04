import type { AvailabilityRow } from '@fsm/shared';

/** e.g. `SOFT_UNAVAILABLE` -> "Soft Unavailable". */
export function formatAvailabilityStatusLabel(status: string): string {
  return status
    .split('_')
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}

/** `listWindows` returns every row, most recent `windowStart` first, not just the active one — the
 *  client derives "current" the same way `SeAvailabilityService.currentStatus` does server-side:
 *  the latest `windowStart` row whose window actually contains `now`. `null` (no active window) is
 *  the same as an explicit AVAILABLE row. */
export function currentAvailabilityRow(items: AvailabilityRow[], now: Date = new Date()): AvailabilityRow | null {
  const nowMs = now.getTime();
  return (
    items.find((r) => {
      const start = new Date(r.windowStart).getTime();
      const end = r.windowEnd ? new Date(r.windowEnd).getTime() : null;
      return start <= nowMs && (end === null || end > nowMs);
    }) ?? null
  );
}
