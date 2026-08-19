# #248 — return-date priority as one comparator key below CRITICAL+

**Done 2026-08-19**, commit `4a54a3f`. Backend only; ordering surfaces through the existing dispatch
transparency traces unchanged.

## What this closes

Decision 15, Option C: **Critical/Severe → return-date → normal backlog.** A ticket whose vehicle is
back today had no standing at all in the processing order — it re-entered the pool (#246) and then
queued behind everything, so the work that was ready *now* was the work least likely to be dispatched.

## The shape, and why the placement is the safety property

Key **2b — after Device Bucket, gated to buckets below CRITICAL+**, per
`docs/audits/four-decisions-readiness-2026-08-18.md` §9. Two consequences follow from the placement
and both are pinned:

- Step 2 has already ordered a CRITICAL+ ticket ahead before 2b is ever consulted, so the flag cannot
  promote work past SLA severity — including when the returning ticket is *itself* the CRITICAL+ one,
  in which case the key is never read at all.
- Because step 2 returns whenever the buckets differ, 2b decides only between tickets **sharing** a
  sub-CRITICAL bucket. There it outranks Company Priority Rank; nothing else moves.

That second point is the one place the issue's own AC wording could be read two ways, so it is recorded
in the issue file in place. "Among sub-CRITICAL work, return-due sorts ahead of normal backlog" means
*within a shared bucket*: a return-due WARNING still sorts behind a normal RISK. Reading it as a
cross-bucket tier would require evaluating the key *before* Device Bucket, which changes dispatch order
materially and contradicts §9's explicit "because step 2 already ran". Both directions are pinned.

The comparator stays a total order under the gate. Because CRITICAL+ always outranks sub-CRITICAL by
bucket, the flag can never leapfrog across the boundary, so no cycle is constructible — a gated key
generally *can* break transitivity, and this one does not for a reason rather than by luck.

## The rejected alternative, pinned rather than merely rejected

Promoting `sla_bucket` to express priority. It is a stored enum feeding Fleet Uptime, the Soft Inactive
Count that zones are **graded** on, SLA reporting and `dispatch_decision_traces`; every one of those
would be corrupted by a bucket that means "priority" in one place and "age band" everywhere else. AC4
is asserted on the stored column after a real run, so the temptation is caught at the data, not in
review.

## `CRITICAL_PLUS`, derived rather than written down

Now one definition, in `device-state/sla-bucket.ts`, **derived from `SLA_BANDS`** — every band whose
lower bound is at or above CRITICAL's, reversed into CONTEXT's severity order. Adding a band above
CRITICAL joins it automatically; moving CRITICAL's boundary cannot leave it stale.

It existed twice before (`cross-zone-escalation.service.ts` for a `.includes` test,
`dashboard.service.ts` for a raw `IN (…)`), and this slice was about to add the third. That third copy
is the one that would have mattered most: a drift in a comparator gate changes what the dispatcher
*does*, not what a report says. `isCriticalPlus(null)` is deliberately `false` — a missing bucket is
ordinary work, not shielded work.

## `returnDueToday`: derived per run, stored nowhere

True when the ticket has an OPEN vehicle-unavailability report whose **authoritative** `expected_from`
has reached the run's IST day — the #245 date, not the SE's proposal, so a manager's override moves the
priority with it. The bound is #247's shared `returnDateArrivedBefore`.

A stored flag would need four writers — filing, a manager's date change, dispatch, supersession — for a
fact that is a pure function of one column and today's date, and any one going missing leaves a ticket
jumping the queue forever. Nothing clears it on dispatch either: assignment removes the ticket from the
selectable set, so the question stops being asked rather than needing a different answer.

One batched read per run, pinned by a query-count test rather than asserted in a comment. Evaluated
against the run's `asOf`, not `now`, so a #250 D+1 preview asks about the day it is previewing —
matching `notDeferredOn(targetDay)` immediately above it.

## AC6 — a stale docstring that was an invitation

`canonical-sort.ts` claimed "the live query mirrors it as a stable SQL ORDER BY". It does not and never
did: the selection read carries no `orderBy` and the sort is applied once, in process. Corrected in
place, because believing a mirror exists invites someone to "restore" one — and a second ordering
written in SQL is exactly the divergence `deferral.ts` exists to prevent. The rank expressions in
`device.service.ts` / `ticket-query.service.ts` are unrelated display sorts.

## Test sensitivity

Twelve tests: a comparator matrix (`return-date-priority.spec.ts`) and a real run
(`recommender-return-date-priority.e2e-spec.ts`). RED before GREEN. Three probes:

| Probe | Went red |
|---|---|
| never set the flag on candidates | the produced-order e2e |
| drop the `status: 'OPEN'` filter from the run's read | the produced-order e2e (a RESOLVED report earned the flag) |
| remove the CRITICAL+ gate from the comparator | the aged-into-CRITICAL+ unit case |

The e2e's control tickets carry the proof rather than decorate it: the RESOLVED-report ticket is the
**oldest** RISK ticket in the fixture and still sorts behind the return-due one, which is only possible
if it did not earn the flag.

Regression run unchanged and green: the ADR-0017 pins, `tiers-spec-pin`, fifteen recommender suites,
both dashboards, cross-zone, fleet-uptime, device-state recompute and the SLA rules surface.

## #244 AC-6 cross-pin

Special contributes nothing to ordering — asserted **structurally** here (the comparator's candidate
type has no Special input at all), which is stronger than a behavioural pin and cannot rot. #244's own
API-level ordering pin is untouched and still green.

## Files

- `src/device-state/sla-bucket.ts` (the consolidated constant + `isCriticalPlus`)
- `src/recommender/canonical-sort.ts` (key 2b, the docstring correction)
- `src/recommender/recommender.service.ts` (the batched `returnDueTickets` read)
- `src/cross-zone/cross-zone-escalation.service.ts`, `src/dashboard/dashboard.service.ts` (consume it)
- `test/return-date-priority.spec.ts`, `test/recommender-return-date-priority.e2e-spec.ts` (new)

No migration, no schema change.
