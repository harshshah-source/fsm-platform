import type { Prisma } from '../generated/prisma/client';

/**
 * #177 — the one definition of "this ticket is waiting on a part and cannot be worked".
 *
 * A component-blocked ticket stays `OPEN` by design (ADR-0008). The failure cycle moves to
 * `WAITING_COMPONENT`, the primary SLA pauses, the part goes on order, and the ticket waits for it —
 * the ticket is not closed, because the failure is still there. That is correct, and it is also why
 * `status = OPEN` has never been enough to decide whether work can be handed out: the moment such a
 * ticket is also `UNASSIGNED` (a ZM `REMOVE_TICKET`, a deferral lapsing, an overnight recycle) every
 * automatic pool treats it as ordinary work.
 *
 * The cost is not abstract. The SE is given a job they cannot finish, drives to site, and submits
 * `componentUnavailable` a second time — the submit gate is `status === 'OPEN'`, which this ticket
 * still satisfies — opening a **second live `component_request`**. The only unique on that table is
 * `submission_id`; there is no one-active-per-ticket guard. So the outcome is a burned capacity slot,
 * a wasted visit, and two live part requests against one failure for the warehouse to reconcile.
 *
 * **Keyed on the live cycle state, and on nothing else.** Not on `sla_paused`, not on the pause
 * reason, not on the existence of a component request — because the normal way blocked work resumes is
 * `confirmResubmit`'s floating-SE `RETURN_TO_POOL` (`component-request.service.ts`), which unassigns
 * the ticket *after* the part has landed and the cycle is back to `OPEN`. That re-dispatch is the
 * feature working. A predicate keyed on pause history or on "has a component request" would strand
 * exactly the tickets whose parts have arrived, which is a worse bug than the one being fixed.
 *
 * **Why the explicit `OR` and not `NOT: { failureCycle: { is: … } }`.** `recommender.service.ts`
 * carries a measured warning — for `device.state`, the same shape — that Prisma renders a negated
 * to-one relation filter such that a row whose relation is NULL matches **neither the filter nor its
 * negation**, so every cycle-less ticket would be dropped in silence. On the morning pool that class
 * is currently empty: `tickets_troubleshoot_requires_cycle` (migration `20260620124718`) is
 * `work_type <> 'TROUBLESHOOT' OR failure_cycle_id IS NOT NULL`, and that pool selects TROUBLESHOOT.
 * But `failure_cycle_id` is nullable in general, and the intraday sweep that spreads this same
 * predicate has **no `workType` clause at all** — today it is saved only by RECOVERY and INSTALL
 * tickets being created `REQUESTED` rather than `OPEN`, which is an emergent property of two unrelated
 * facts and not something this filter owns or states. One spelling that is correct in both places
 * costs nothing; two spellings, one of which silently drops rows, is the #153 failure mode.
 *
 * **Compose it under `AND`, never by flat spread.** This predicate expresses itself as a top-level
 * `OR`, and so does {@link notDeferredOn} — the other filter every one of these pools already spreads
 * in. Two `OR` keys spread into one object leave only the last, so `{ ...notComponentBlocked(),
 * ...notDeferredOn(day) }` silently drops this exclusion entirely and the query looks untouched. That
 * is measured, not theoretical: it is what the first green attempt did, and the run read as though the
 * filter had never been added. Every call site writes `AND: [notComponentBlocked()]`.
 *
 * @see componentBlockedTickets — the exact complement, so the excluded work is counted and reported
 *   rather than inferred by subtraction.
 */
export function notComponentBlocked(): Prisma.TicketWhereInput {
  return {
    OR: [{ failureCycleId: null }, { failureCycle: { state: { not: 'WAITING_COMPONENT' } } }],
  };
}

/**
 * The complement of {@link notComponentBlocked} — the work an automatic pool deliberately left alone.
 *
 * Reported as its own figure rather than folded into `unassignable`, following the distinction the run
 * ledger already draws twice: `unassignable` means the engine looked and found nobody, which is a
 * coverage or capacity failure somebody must act on in Ops; `withheldBelowThreshold` (#238) means it
 * deliberately did not look yet, which is policy working as intended and needs no action. This is the
 * second kind. Merging it into the first would file every part-on-order into the coverage-gap queue
 * and make a warehouse delay read as a dispatch outage.
 */
export function componentBlockedTickets(): Prisma.TicketWhereInput {
  return { failureCycle: { state: 'WAITING_COMPONENT' } };
}
