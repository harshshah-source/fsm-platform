import { uniqueViolationModel } from '../common/unique-violation';

/**
 * #262 — one SE's transaction that did not commit, and why.
 *
 * The unit of failure used to be the zone: any conflict rolled back every SE's plan and was labelled
 * `SCHEDULE_CONFLICT` whatever had actually happened. Now a failure costs exactly the SE it belongs to
 * and is named on the ledger, which is the difference between "the zone did not dispatch" and "four of
 * five engineers have their day and this one is blocked by a manual schedule".
 */
export interface SeSkip {
  seId: string;
  /** Operator-facing sentence, discriminated by cause. */
  reason: string;
  /**
   * The Prisma model whose unique constraint was violated, when that is what happened — `WorkSchedule`
   * or `BatchAssignmentTicket`. `null` for any other failure (lock timeout, deadlock, statement
   * timeout).
   */
  constraint: string | null;
}

/**
 * Turn one SE's failure into a ledger sentence (#262 items 3 and 5).
 *
 * A pure function with its own module because the label is the AC: `SCHEDULE_CONFLICT` must appear
 * **only** for the schedule unique, and testing that through a live dispatch would mean staging four
 * different database failures to assert four strings.
 *
 * **The discriminator is `uniqueViolationModel`, not `e.meta.target`.** #262's issue text specifies
 * `meta.target` — the field every Prisma example keys on — and it does not exist under this repo's
 * driver adapter; #265 measured its absence and established `meta.modelName` as what actually arrives.
 * That indirection is exact here only because `work_schedules` and `batch_assignment_tickets` each
 * carry exactly one unique constraint; see `unique-violation.ts` for the caveat if either gains a
 * second.
 */
export function describeSeSkip(seId: string, e: unknown): SeSkip {
  const model = uniqueViolationModel(e);
  if (model === 'WorkSchedule') {
    return {
      seId,
      constraint: model,
      reason: 'SCHEDULE_CONFLICT: this SE already holds an ACTIVE schedule for this zone/day',
    };
  }
  if (model === 'BatchAssignmentTicket') {
    return {
      seId,
      constraint: model,
      reason: 'TICKET_CONFLICT: one of this SE’s tickets was put on a live batch by someone else mid-dispatch',
    };
  }
  const message = e instanceof Error ? e.message : String(e);
  // The expected non-unique failure here: closure or bulk-unassign held the zone longer than
  // `ZONE_LOCK_TIMEOUT_MS`. "Could not get the zone lock in time" and "the database threw" call for
  // very different responses from whoever reads the ledger, so they are different sentences.
  if (/lock timeout/i.test(message)) {
    return { seId, constraint: null, reason: 'ZONE_LOCK_TIMEOUT: another zone-wide operation held the lock' };
  }
  return { seId, constraint: null, reason: message };
}
