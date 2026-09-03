import type { $Enums } from '../generated/prisma/client';

/**
 * The ticket statuses that mean the work on that ticket is over — successfully or not.
 *
 * **Why this file exists.** The same seven statuses were already written out three times, in three
 * modules, under two names: `RESOLVED_TICKET_STATUSES` in `schedule-closure-scheduler.service.ts`
 * (identical set), `CLOSED_TICKET_STATUSES` in `dashboard.service.ts` (identical set), and a
 * **four-member** `CLOSED_TICKET_STATUSES` in `entity-mapping-export.service.ts` that silently omits
 * `FAILED_VERIFICATION`, `FAILED_ACTIVATION` and `RECEIVED_AT_WAREHOUSE`. Whether that omission is a
 * deliberate export-scoping choice or a drift bug is not answerable from the code, which is precisely
 * the problem with a definition that lives in three places.
 *
 * #178 needed a fourth reader to agree with the closure paths, so this file became the canonical set,
 * and #308 is the deliberate slice that folded the copies in. Every consumer now imports from here.
 * `test/terminal-status-vocabulary.e2e-spec.ts` fails if a second spelling reappears — including in
 * raw SQL, where `device.service.ts` had a sixth one the original finding did not count.
 *
 * ## The one judgement call, decided (#308)
 *
 * `FAILED_VERIFICATION`, `FAILED_ACTIVATION` and `RECEIVED_AT_WAREHOUSE` used to be **absent** from the
 * departure / deactivation / export copies, which is what made those three divergent rather than merely
 * duplicated. They are terminal, and they belong here:
 *
 * - Nothing treats them as live work. `device.service.ts`'s open-ticket lateral, the dashboard's
 *   assignment counts and the schedule-closure sweep all already excluded them.
 * - Repeat-escalation — the consumer that might have needed one of them to stay "open" — keys on
 *   `failure_cycles.state`, never on `tickets.status`, so widening this set cannot affect it.
 *
 * **What the departure/deactivation paths actually needed from those tickets was never the ticket: it
 * was the CYCLE.** A `FAILED_VERIFICATION` ticket is terminal while its failure cycle stays live
 * (`finalize` closes the cycle only on `CLOSED`), so re-closing the ticket was an incidental way of
 * reaching the cycle — at the cost of overwriting `closure_type`/`closed_at` and appending a second
 * closure event to work that was already over. Those paths now terminate the live cycle directly and
 * leave the terminal ticket alone.
 */
export const RESOLVED_TICKET_STATUSES = [
  'CLOSED',
  'CLOSED_AUTO_RECOVERY',
  'CLOSED_NON_OPERATIONAL',
  'FAILED_VERIFICATION',
  'FAILED_ACTIVATION',
  'FAILED_RECOVERY',
  'RECEIVED_AT_WAREHOUSE',
] as const satisfies readonly $Enums.TicketStatus[];

/**
 * Failure-cycle states that are still live — the complement of the two terminal ones (`VERIFIED`,
 * `FAILED`). Named here beside {@link RESOLVED_TICKET_STATUSES} because #308's ruling above pairs
 * them: once a terminal ticket is no longer re-closed, "does this device still have a live episode?"
 * has to be asked of the cycle directly, and the departure and deactivation paths must ask it the
 * same way.
 */
export const LIVE_FAILURE_CYCLE_STATES = [
  'OPEN',
  'WAITING_COMPONENT',
  'SUBMITTED',
  'REPEAT',
  'ESCALATED',
] as const satisfies readonly $Enums.FailureCycleState[];
