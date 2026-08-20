/**
 * Why a `batch_assignment_tickets` row stopped being live (#241).
 *
 * **The problem this replaces.** The row carried only `removed_at` / `removed_by`, and `removed_by IS
 * NULL` was already taken: auto-recovery removes rows with a NULL actor (`auto-recovery.service.ts`),
 * 1,092 of them in the dev mirror. So the column that looks like "was this a human or the system?"
 * answers only "was it *that* system path", and every later question — did this assignment end because
 * the ZM withdrew it, because the plan expired, because the vehicle was gone, because the device left
 * the fleet — had no place to be recorded at all. #242 (recycling), #243 (cleanup) and #244 (Special
 * attempt counting) each need that distinction, and none of them can infer it after the fact.
 *
 * **Why a closed vocabulary and not free text.** The reason is read as a *predicate*, not shown as a
 * label: #244 counts an attempt only for windows that ended in specific ways, so a typo silently
 * changes an operational classification rather than producing a visible mistake. `removal_reason` is
 * TEXT in the database rather than a Postgres enum deliberately — later slices add members without a
 * schema migration, and the discipline lives here, in one importable set every writer uses.
 *
 * **Storage note.** The column is nullable and means exactly one thing when NULL: the row is still
 * live (`removed_at IS NULL`). Every removed row carries a reason — the migration backfills history,
 * and `removal-reason.e2e-spec.ts` pins that no writer can reintroduce a NULL.
 */
export const REMOVAL_REASONS = {
  /** ZM withdrew the ticket from the batch (`OverrideService.removeTicket`). */
  ZM_WITHDRAWN: 'ZM_WITHDRAWN',
  /** ZM deferred the ticket to a later date (`OverrideService.deferTicket`); `deferred_to_date` is set. */
  ZM_DEFERRED: 'ZM_DEFERRED',
  /** Source row of a REASSIGN / SPLIT_BATCH move — a new row opens on the destination batch. */
  REASSIGNED: 'REASSIGNED',
  /** Cleared by an admin bulk-unassign run (`BulkUnassignService`). */
  BULK_UNASSIGNED: 'BULK_UNASSIGNED',
  /** The device recovered on its own and the ticket auto-closed (`AutoRecoveryService`); actor is NULL. */
  AUTO_RECOVERY: 'AUTO_RECOVERY',
  /** The ticket was cancelled out from under the assignment — device departure or plant deactivation. */
  TICKET_CANCELLED: 'TICKET_CANCELLED',
  /**
   * The ticket reached a terminal state and its assignment ended with it — verification decided,
   * warehouse receipt, install closed or failed, marked non-operational, manual auto-recovery (#178).
   *
   * Distinct from `TICKET_CANCELLED`, where the work was called off from outside: here the work
   * genuinely finished, successfully or not. Both are excluded from #244's attempt counting for the
   * same reason — an ended attempt is only evidence the ticket *resists repair* when it ran out
   * (`PLAN_EXPIRED` / `VEHICLE_UNAVAILABLE`), never when it concluded.
   */
  TICKET_RESOLVED: 'TICKET_RESOLVED',
  /** Returned to the pool waiting on a component (`ComponentRequestService.confirmResubmit`). */
  COMPONENT_WAIT: 'COMPONENT_WAIT',
  /** Unresolved at schedule closure — the nightly recycle. Written by #242; no writer yet. */
  PLAN_EXPIRED: 'PLAN_EXPIRED',
  /** The SE found the vehicle absent and filed a return date. Written by #246; no writer yet. */
  VEHICLE_UNAVAILABLE: 'VEHICLE_UNAVAILABLE',
  /** Closure backstop for a row still live on an already-resolved ticket. Written by #242; no writer yet. */
  RESOLVED_AT_CLOSURE: 'RESOLVED_AT_CLOSURE',
  /** The one-off development-data cleanup marker — also its rollback handle. Written by #243. */
  DEV_CLEANUP: 'DEV_CLEANUP',
  /**
   * Backfill only. Pre-#241 human removals are not retroactively separable into withdraw / reassign /
   * bulk, and do not need to be: every one of those is excluded from attempt counting anyway (#244),
   * so the distinction would carry no decision. Never written by live code.
   */
  HUMAN_REMOVED: 'HUMAN_REMOVED',
} as const;

/** The reason vocabulary as a type — every writer's `removalReason` is one of these. */
export type RemovalReason = (typeof REMOVAL_REASONS)[keyof typeof REMOVAL_REASONS];

/** Every member, for the tests and queries that need to assert over the closed set. */
export const ALL_REMOVAL_REASONS = Object.values(REMOVAL_REASONS) as readonly RemovalReason[];
