/**
 * #146 B1 slice 3 — the one definition of "is this Ticket's deferral still holding it back?".
 *
 * A ZM deferring a Ticket (`fsm-business-technical-workflow.md:711`) means two things: it leaves the
 * current batch, and it comes back on a chosen future date. Slice 1 delivered the first. The second
 * requires the Ticket to return to `UNASSIGNED` — otherwise nothing can ever re-plan it, which is the
 * permanent-stranding bug — and that flip is only safe because of this predicate.
 *
 * Without it, "return to the pool" means "re-dispatchable within the hour": the recommender selects
 * `OPEN` + `UNASSIGNED` (`recommender.service.ts:103-108`), the Shared Pool offers the same set to the
 * SE as pickable secondary work, and the intraday and cross-zone sweeps read it too. A deferred Ticket
 * would come straight back the same day, which is the opposite of deferring it.
 *
 * So this is deliberately ONE exported predicate rather than six hand-written `OR` clauses. #153 is
 * the cautionary tale directly upstream of this file: six copies of a liveness filter drifted apart
 * and blanked every SE's day plan. Every reader of unassigned work spreads this in.
 *
 * `deferred_until` is a DATE and the argument is the run's UTC day start, so a deferral to 2026-06-27
 * is excluded on the 26th and included from the 27th onward — inclusive on the deferred date itself,
 * which is what "pushed to a specific future date" means.
 */
export function notDeferredOn(day: Date): {
  OR: [{ deferredUntil: null }, { deferredUntil: { lte: Date } }];
} {
  return { OR: [{ deferredUntil: null }, { deferredUntil: { lte: day } }] };
}
