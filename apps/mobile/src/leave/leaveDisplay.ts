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

/** `windowStart`/`windowEnd` are ISO instants at UTC midnight (date-only semantics) — render just
 *  the date part, not a time that would misleadingly imply a specific hour. */
export function formatLeaveDate(iso: string): string {
  return iso.slice(0, 10);
}
