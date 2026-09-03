import type { MeTicketWorkState } from '@fsm/shared';
import type { SemanticStatus } from '../theme/tokens';

/**
 * `SlaBucket` (`@fsm/shared`) is an 8-step green→red ramp (DESIGN-SYSTEM §1.6); the mobile kit's
 * `SemanticStatus` only has 6 slots. Collapsed 2-way rather than reusing 4+ slots for one severity
 * axis: WARNING/EARLY_RISK/RISK read as "keep an eye on it", CRITICAL and up read as "act now" — a
 * presentation simplification, not a business-rule call (the underlying ordering is untouched).
 */
export function slaBucketToStatus(bucket: string | null): SemanticStatus {
  switch (bucket) {
    case 'WARNING':
    case 'EARLY_RISK':
    case 'RISK':
      return 'warning';
    case 'CRITICAL':
    case 'HIGH_CRITICAL':
    case 'SEVERE':
    case 'VERY_SEVERE':
    case 'LONG_PENDING':
      return 'critical';
    default:
      return 'neutral';
  }
}

/** `null` is the 0-4h ACTIVE band — the absence of a bucket, never actually queued
 *  (`@fsm/shared`'s `SlaBucket` doc comment) — rendered as "Active", not the literal "null". */
export function formatSlaBucketLabel(bucket: string | null): string {
  if (bucket === null) {
    return 'Active';
  }
  return bucket
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

const WORK_STATE_LABEL: Record<MeTicketWorkState, string> = {
  VISIT_NOW: 'Visit Now',
  PLAN: 'Plan',
  IN_WORK: 'In Work',
  VERIFY: 'Verify',
  // #360 — the ticket the SE filed vehicle unavailability on. It used to disappear from their list
  // the moment they filed; it now stays, labelled with why it is waiting.
  VEHICLE_UNAVAILABLE: 'Vehicle Unavailable',
};

export function workStateLabel(workState: MeTicketWorkState): string {
  return WORK_STATE_LABEL[workState];
}
