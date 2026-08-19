import { istDate, istDayStartInstant } from '../common/ist-day';

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

/**
 * The in-memory twin of {@link notDeferredOn}, for the one caller that holds a Ticket in hand rather
 * than building a query (`se-ticket-access.ts`). It lived there as its own inline expression until
 * #246 folded it back here — which is the entire point of this file: #153 is the cautionary tale of
 * six copies of a liveness filter drifting apart and blanking every SE's day plan, and a seventh copy
 * of *this* filter would strand deferred tickets in exactly one read while the other six agreed.
 */
export function isNotDeferredOn(deferredUntil: Date | null, day: Date): boolean {
  return deferredUntil === null || deferredUntil <= day;
}

/**
 * The deferral a vehicle's return date implies — #246, Decision 14.
 *
 * The unit is an **IST calendar day**, not an instant, because that is the unit the whole scheduling
 * side already speaks: `deferred_until` is a `@db.Date`, dispatch plans a day at a time, and
 * {@link notDeferredOn} compares days. So a return that lands on *today* is not a short wait — it is
 * no wait at all, and the ticket is simply eligible again. Writing an hour-level deferral for it
 * would invent machinery nothing reads: no reader could honour "back at 4pm", and the ticket would
 * either be excluded for the whole day or included immediately regardless.
 *
 * `null` therefore means "nothing to wait for", and callers write it straight through — which is also
 * what makes a manager moving the date *backwards* onto today clear the wait instead of leaving a
 * stale future date stranding the ticket after the vehicle is provably back.
 *
 * There is deliberately no upper bound (Decision 10): a +90-day return is accepted, and consecutive
 * absences are not counted or capped here. Management approval is the control, and each cycle still
 * increments the Special attempt count, so a never-returning vehicle surfaces rather than disappears.
 */
export function deferralDateFor(authoritativeReturn: Date, now: Date): Date | null {
  const returnDay = istDate(authoritativeReturn);
  return returnDay.getTime() > istDate(now).getTime() ? returnDay : null;
}

/**
 * The exclusive upper bound an OPEN report's authoritative `expected_from` must fall under for its
 * return date to have **arrived** — #247's sweep and #248's ordering key, one definition.
 *
 * This is {@link deferralDateFor}'s complement, and it has to stay that way: a report has arrived
 * exactly when it no longer produces a deferral, i.e. `istDate(expectedFrom) <= istDate(now)`. Written
 * as one end-exclusive instant rather than the obvious `istDate(expectedFrom) <= istDate(now)` because
 * `expected_from` is a `@db.Timestamptz`, not a `@db.Date` — wrapping the column in a day-truncating
 * expression would compare the right thing and use none of `@@index([status, expectedFrom])`, on a
 * predicate that runs per dispatch run.
 *
 * The boundary is IST midnight, not UTC: 2026-06-25T19:00Z is already the 26th in IST, and bucketing
 * it by UTC day would hold a returned vehicle's ticket back a further day (the same trap #204 removed
 * from ~15 services and `vu-deferral-wiring.e2e-spec.ts` pins for filing).
 */
export function returnDateArrivedBefore(now: Date): Date {
  return new Date(istDayStartInstant(now).getTime() + 24 * 60 * 60 * 1000);
}
