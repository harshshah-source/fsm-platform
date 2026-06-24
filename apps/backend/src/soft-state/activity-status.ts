import { type SoftStateType } from '../generated/prisma/enums';

/**
 * SE Activity Status (ADR-0023) — a render-time display label, NEVER stored. Distinct from the stored
 * planning flag `SE_AVAILABILITY.status`. Computed from three sources in precedence order:
 *   1. availability status — if not AVAILABLE it wins (ON_LEAVE / OFF_SHIFT / WEEKLY_OFF / …)
 *   2. active ticket soft states — TROUBLESHOOT_STARTED → BUSY; VIEWED / ON_SITE → ON_SITE
 *   3. shift schedule + activity ping — within 1 h of shift end → SHIFT_ENDING; last ping > 1 h old →
 *      OFFLINE ("app not recently used", NOT "not working"); else AVAILABLE.
 *
 * A soft state outranks the heartbeat so a stale ping never hides active field work (CONTEXT §SE
 * Activity Status: interpreting OFFLINE as "SE is not working" is the documented anti-pattern).
 */
export type ActivityStatus =
  | 'AVAILABLE'
  | 'ON_SITE'
  | 'BUSY'
  | 'SHIFT_ENDING'
  | 'OFFLINE'
  | 'ON_LEAVE'
  | 'OFF_SHIFT'
  | 'WEEKLY_OFF'
  | 'SOFT_UNAVAILABLE';

const HEARTBEAT_STALE_MS = 60 * 60 * 1000; // last ping older than 1 h ⇒ OFFLINE
const SHIFT_ENDING_WINDOW_MS = 60 * 60 * 1000; // within 1 h of shift end ⇒ SHIFT_ENDING

export interface ActivityStatusInputs {
  /** The stored SE_AVAILABILITY.status; pass 'AVAILABLE' when there is no record. */
  availabilityStatus: string;
  /** Types of the SE's currently-active (unresolved) soft states, across all their tickets. */
  activeSoftStateTypes: readonly SoftStateType[];
  /** `engineer_master.last_activity_at` (the activity ping); null = never pinged. */
  lastActivityAt: Date | null;
  /** Today's resolved shift-end datetime (see resolveShiftEnd), or null if unknown. */
  shiftEnd: Date | null;
  now: Date;
}

export function deriveActivityStatus(input: ActivityStatusInputs): ActivityStatus {
  // 1. A non-AVAILABLE planning flag takes precedence.
  if (input.availabilityStatus && input.availabilityStatus !== 'AVAILABLE') {
    return input.availabilityStatus as ActivityStatus;
  }
  // 2. Active soft states (BUSY outranks ON_SITE).
  if (input.activeSoftStateTypes.includes('TROUBLESHOOT_STARTED')) return 'BUSY';
  if (input.activeSoftStateTypes.includes('ON_SITE') || input.activeSoftStateTypes.includes('VIEWED')) {
    return 'ON_SITE';
  }
  // 3. Shift schedule + heartbeat.
  if (input.shiftEnd) {
    const windowStart = input.shiftEnd.getTime() - SHIFT_ENDING_WINDOW_MS;
    if (input.now.getTime() >= windowStart && input.now.getTime() <= input.shiftEnd.getTime()) {
      return 'SHIFT_ENDING';
    }
  }
  if (!input.lastActivityAt || input.lastActivityAt.getTime() < input.now.getTime() - HEARTBEAT_STALE_MS) {
    return 'OFFLINE';
  }
  return 'AVAILABLE';
}

/** Project a time-of-day shift end (stored as a TIME column → 1970-epoch Date) onto `now`'s date. */
export function resolveShiftEnd(shiftEnd: Date | null, now: Date): Date | null {
  if (!shiftEnd) return null;
  const d = new Date(now);
  d.setUTCHours(shiftEnd.getUTCHours(), shiftEnd.getUTCMinutes(), shiftEnd.getUTCSeconds(), 0);
  return d;
}
