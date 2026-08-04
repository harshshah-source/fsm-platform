import type { SemanticStatus } from '../theme/tokens';

/** e.g. `WEEKLY_OFF` -> "Weekly Off". */
export function formatLeaveTypeLabel(type: string): string {
  return type
    .split('_')
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}

/** Same word-split-capitalize as `formatLeaveTypeLabel` — `PENDING`/`APPROVED`/`REJECTED` all read
 *  fine through it (e.g. `PENDING` -> "Pending"), so one function covers both fields. */
export const leaveStatusLabel = formatLeaveTypeLabel;

export function leaveStatusSemantic(status: string): SemanticStatus {
  switch (status) {
    case 'APPROVED':
      return 'success';
    case 'REJECTED':
      return 'critical';
    default:
      return 'warning';
  }
}

/**
 * IST is a fixed +05:30 offset (India has never observed DST), so shifting the instant and reading the
 * UTC fields is exact — and, unlike `toLocaleDateString`, independent of the handset's own zone, which
 * a field engineer's phone will not always have set correctly. Mirrored in the admin app at
 * `src/lib/datetime.ts`; the server-side pair is `apps/backend/src/common/ist-day.ts`.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function istDate(iso: string, shiftMs: number): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '—' : new Date(t + shiftMs + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The IST calendar day a leave window starts on (#204). `windowStart`/`windowEnd` are real instants
 * bounding the IST days the leave covers — 10 Aug starts at `2026-08-09T18:30Z` — so the old
 * `iso.slice(0, 10)` rendered a start one day early. Only the date is shown, never a time: for a
 * date-only request there is no meaningful hour to imply.
 */
export function formatLeaveWindowStart(iso: string): string {
  return istDate(iso, 0);
}

/**
 * The last IST day a leave window actually covers. The window is **end-exclusive** server-side, so a
 * leave through 12 Aug ends at `2026-08-12T18:30Z` — IST midnight *opening* the 13th. Stepping back a
 * millisecond lands on the last covered day, and leaves a manager-set mid-day end on its own day.
 */
export function formatLeaveWindowEnd(iso: string): string {
  return istDate(iso, -1);
}
