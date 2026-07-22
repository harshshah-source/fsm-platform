# 153 — Any ZM override blanks the SE's day plan and zeroes their capacity accounting
Status: needs-triage
Type: AFK

> **Found 2026-07-22 while writing the RED test for [#146](./146-zm-override-integrity-defer-remove.md)
> slice 1.** In neither audit — the full-project audit reasoned about `deferred_to_date` readers from
> source and never executed the path; running it surfaced a larger defect underneath.
> **More severe than the B1/B2 defects #146 was filed for, and #146 is blocked on it.**

## Background

`WorkScheduleStatus` has four values: `ACTIVE`, `OVERRIDDEN`, `COMPLETED`, `PARTIAL`
(`schema.prisma:457-463`). The business workflow makes `OVERRIDDEN` a **live, non-terminal** state —
`fsm-business-technical-workflow.md:1913`:

> *"**Transitions:** `AUTO_ASSIGNED` (dispatched directly to the SE on generation — no approval) →
> `COMPLETED` (all Tickets resolved) | `PARTIAL` | **`OVERRIDDEN` (ZM swap/split/remove/defer/reassign)
> → `COMPLETED` | `PARTIAL`**."*

An overridden schedule is still today's work. The SE still has to do it.

## Problem

Every ZM override flips the **schedule** to `OVERRIDDEN` (`override.service.ts:487-490`), and at least
five read/write paths treat anything that is not `ACTIVE` as non-existent. So the moment a Zonal
Manager touches a day plan — swap SE, split batch, remove ticket, **defer ticket**, reorder, reassign:

1. **The SE's entire day plan goes blank.** `DayPlanQueryService.getDayPlan` filters
   `{ seId, status: 'ACTIVE' }` (`day-plan-query.service.ts:41`) and returns `EMPTY`.
2. **The SE's committed load resets to zero.** `RecommenderService.committedDayLoad` filters
   `batch: { schedule: { status: 'ACTIVE', … } }` (`recommender.service.ts:552`), so the next dispatch
   run believes the SE is entirely free and can assign a full day's capacity **on top of** the work
   they already have.
3. **Same-day APPEND reuse breaks.** `batch-assignment.service.ts:121` looks up the reusable schedule
   with `status: 'ACTIVE'`; an overridden schedule is not found, so #127's APPEND path creates a
   *second* schedule for the same `(se, zone, day)` — reopening the collision class #126/#127 closed.
4. `batch-assignment.service.ts:247` and `override.service.ts:437,446` carry the same filter.

## Root Cause

`OVERRIDDEN` is being used as if it were terminal. It is not — it is "ACTIVE, and a human has
adjusted it". The status column conflates **lifecycle state** (is this schedule live today?) with
**provenance** (was it modified by a ZM?), and every reader assumes the first meaning while the
writer sets it for the second.

## Evidence

Reproduced with a probe inside `test/batch-override-defer-reorder.e2e-spec.ts`, whose existing
fixture dispatches two tickets to one SE and then applies `DEFER_TICKET` + `REORDER`:

```
PROBE schedules=    [{"id":"1303","status":"OVERRIDDEN"}]
PROBE batchTickets= [{"t":"0ce7c368","removed":false,"deferred":false},
                     {"t":"dafb69dc","removed":false,"deferred":true}]
```

Both batch tickets are still present and **not removed** — one merely deferred. Yet against that same
state:

- `getDayPlan(se)` returns **0 stops / 0 tickets** (should be the un-deferred sibling at minimum).
- `count(batchAssignmentTicket where removedAt: null, batch.schedule.status ACTIVE)` returns **0**
  (should be 2 pre-#146, 1 post-#146).

The writer: `override.service.ts:487-490`

```ts
await tx.workSchedule.update({
  where: { scheduleId },
  data: { status: 'OVERRIDDEN', lastOverriddenBy: actor.userId, lastOverriddenAt: now },
});
```

All `status: 'ACTIVE'` schedule filters in `src` (excluding unrelated user/role filters):
`day-plan-query.service.ts:41` · `recommender.service.ts:552` ·
`batch-assignment.service.ts:121,247` · `override.service.ts:437,446`.

**Live exposure: unknown — not probed.** Dev currently has 0 rows with `removed_at`/`deferred_to_date`
set, but that measures removals/defers only; **swap, split, reorder and reassign flip the same status
flag** and were not counted. Any zone whose ZM has used any override is affected.

## Current Behaviour

A ZM defers one ticket at 09:00. The SE opens the app and sees an **empty day plan** — not a plan
missing one stop, but no work at all. Simultaneously the engine believes that SE has zero committed
load, so the next run may hand them a full fresh day of capacity on top of the work still in their
(invisible) schedule.

## Expected Behaviour

`OVERRIDDEN` is treated as live, exactly as the workflow document specifies. The SE sees their plan
minus the overridden change; capacity accounting counts overridden schedules; APPEND reuses them.

## What to build

Treat `ACTIVE` and `OVERRIDDEN` as the same *lifecycle* state everywhere a schedule is read as "live",
via one shared predicate rather than six hand-written filters that can drift apart again.

> **Design note — worth a decision, not an assumption.** Two shapes:
> **(a)** widen every filter to `status: { in: ['ACTIVE', 'OVERRIDDEN'] }` behind one exported
> constant (e.g. `LIVE_SCHEDULE_STATUSES`); or **(b)** stop overloading `status` — keep it `ACTIVE`
> and record provenance in the `lastOverriddenBy` / `lastOverriddenAt` columns that **already exist**
> on the row, so "was it overridden?" is `lastOverriddenAt != null`.
> **(b) is cleaner** and removes the conflation permanently, but it changes the meaning of a persisted
> enum value that reports and the admin UI may read — needs a sweep of every `OVERRIDDEN` consumer
> before committing. **(a) is a 6-line change with no data implications.** Recommend (a) now to stop
> the bleeding, then (b) as a follow-up if the sweep is clean.

## Acceptance criteria

- [ ] After any override (swap / split / remove / defer / reorder / reassign), `getDayPlan` still returns the SE's remaining work for that day.
- [ ] `committedDayLoad` counts tickets on overridden schedules, so an overridden SE cannot be over-assigned on the next run.
- [ ] Same-day APPEND (#127) reuses an overridden schedule rather than creating a colliding second one — pinned by extending the #127 regression.
- [ ] Every "is this schedule live?" filter reads from **one** shared predicate; a grep for `status: 'ACTIVE'` on `workSchedule` returns only that constant.
- [ ] `COMPLETED` and `PARTIAL` remain excluded — this issue widens the live set by exactly one value.
- [ ] Full backend suite green.

## TDD Strategy

Strict TDD, and the RED is already written and reproducible — it is the probe above.

- **RED:** in `batch-override-defer-reorder.e2e-spec.ts` (whose fixture already dispatches 2 tickets
  to 1 SE and then overrides), assert `getDayPlan(se)` returns the un-overridden work and that the
  committed-load count is non-zero.
- **What fails today:** both — day plan is empty, count is 0.
- **Why:** the schedule is `OVERRIDDEN` and both readers filter `status: 'ACTIVE'`.
- **What makes it pass:** the shared live-status predicate.
- **Pin first:** a `COMPLETED` schedule must stay excluded, so the widening is provably exactly one
  value and not "any status".

## Implementation Slices

1. **Slice 1 — shared predicate + the two SE-facing readers** (`day-plan-query`, `committedDayLoad`).
   The user-visible half; independently mergeable.
2. **Slice 2 — dispatch/APPEND paths** (`batch-assignment.service.ts:121,247`,
   `override.service.ts:437,446`), with the #127 same-day-append regression extended to override a
   schedule first.
3. **Slice 3 — admin parity check**: confirm no admin surface depended on the old (broken) behaviour
   of an overridden schedule disappearing from these reads.

## Rollback Plan

Slices 1–2 are filter widenings behind one constant — revert the constant's value to `['ACTIVE']` to
restore current behaviour exactly. No schema change, no migration, no data change.

## Dependencies

None. **Blocks [#146](./146-zm-override-integrity-defer-remove.md)** — that issue's slice 1 ("a
deferred ticket leaves the day plan, the rest of the plan is untouched") cannot be observed while the
whole plan is blank, and its slice 2 capacity assertion cannot be observed while committed load is
already 0 for the wrong reason.

## Estimated Effort

S (½ day incl. the regression extension). **Priority: P1** — higher than #146. Unlike B1/B2 this is
not latent-on-zero-rows: it fires on **every** override action, including the four (swap, split,
reorder, reassign) that have no `removed_at`/`deferred_to_date` row to count, and it silently corrupts
capacity accounting on a hot path.

## UI surfaces

Mobile: **SE Day Plan** is the surface that goes blank — the defect is backend-side and needs no
mobile change; the client is [#54](./54-mobile-foundation.md).
Admin: none expected; slice 3 verifies that.

## Reference
n/a (backend read-model correctness)

## Blocked by
None.
