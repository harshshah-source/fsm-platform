# 147 — SE day plan has no date filter; `work_schedules` are never closed
Status: ready-for-agent
Type: AFK

> Source: `docs/audits/2026-07-22-full-project-audit.md` §5 B3, re-verified still-open by
> `docs/audits/2026-07-22-adversarial-review-admin-backend.md` §2. Follow-up to
> [#11](./11-batch-auto-dispatch-se-day-plan.md) — parent stays **accepted**.

## Background

`DayPlanQueryService.getDayPlan` is the single read behind the SE mobile Day Plan — the screen an SE
opens each morning to learn what work they have.

## Problem

The read selects the most recent `ACTIVE` schedule with **no date predicate**, and nothing anywhere
writes a terminal `work_schedules.status`. An SE with no dispatched work today is served **yesterday's
day plan as today's**, with no indication that it is stale.

## Root Cause

The schedule lifecycle was never given a closing transition. The read compensated with
`orderBy: { dispatchedAt: 'desc' }`, which was adequate only while every SE received a fresh schedule
every day.

**[#127](./127-dispatch-per-se-isolation.md)'s APPEND change made the compensation worse**: appending
to an existing schedule does not refresh `dispatchedAt`, so the ordering key no longer tracks
last-modification — the tiebreak is now on a stamp that can be arbitrarily old.

## Evidence

`apps/backend/src/scheduling/day-plan-query.service.ts:40-43` (re-read 2026-07-22):

```ts
const schedule = await this.prisma.workSchedule.findFirst({
  where: { seId, status: 'ACTIVE' },
  orderBy: { dispatchedAt: 'desc' },
});
if (!schedule) return EMPTY;
```

No `dateFrom` / `dateTo` predicate. No code path writes a terminal status — the prior audit found
**50 schedules dated 2026-07-21 still `ACTIVE` on 2026-07-22** (*measured by that audit; not re-probed
this session*).

This is the one structural dead end on the platform: the audit's Gate-3 pass found no other one-way
state in the reviewed surface.

## Current Behaviour

An SE whose zone produced no dispatch today opens the app and sees yesterday's stops presented as
today's work, indistinguishable from a fresh plan. Under APPEND, an SE with both an old and a current
schedule can be served the wrong one because `dispatchedAt` no longer tracks modification.

Dormant today — the SE mobile client ([#54](./54-mobile-foundation.md)) is unbuilt, so nothing
consumes this read in production.

## Expected Behaviour

The day-plan read returns **today's** schedule or an explicit empty plan. Never yesterday's. Schedules
reach a terminal state rather than accumulating as permanently `ACTIVE`.

Staleness becomes impossible **by construction**, not by UI copy warning the SE that their plan might
be old.

## What to build

1. A date predicate on the day-plan read (one line, no schema change).
2. A schedule-lifecycle closer that cannot race an in-flight APPEND.

## Acceptance criteria

- [ ] `getDayPlan` filters `dateFrom <= today <= dateTo`; an SE with no schedule for today receives the explicit empty plan, never yesterday's.
- [ ] Under APPEND, the correct (today's) schedule is returned **even when `dispatchedAt` is stale** — the date predicate, not the ordering, decides.
- [ ] Schedules reach a terminal status; the closer **cannot** close a schedule while an APPEND is in flight.
- [ ] No `work_schedules` row remains `ACTIVE` past its `dateTo` — asserted against a seeded past-dated row.
- [ ] #127 APPEND and #126 zone-wedge regressions stay green.
- [ ] Backend suite green.

## TDD Strategy

Strict TDD. Slice 1 is a one-line predicate with a clean three-case truth table — an ideal RED.

**Slice 1 RED:**

- **Test:** three cases against `getDayPlan(seId)` —
  (a) SE has only a **yesterday-dated** `ACTIVE` schedule → **empty plan**;
  (b) SE has today's → today's plan;
  (c) SE has **both**, with the yesterday row carrying the *newer* `dispatchedAt` → **today's plan**.
- **What fails today:** (a) and (c). (b) passes and pins existing behaviour.
- **Why it fails:** the query has no `dateFrom`/`dateTo` predicate, so (a) returns the stale schedule;
  and because ordering is by `dispatchedAt` alone, (c) returns the wrong one — the exact regression
  APPEND introduced.
- **What makes it pass:** adding `dateFrom: { lte: today }, dateTo: { gte: today }` to the `where`.

Case (c) is the assertion worth writing first: it fails for a *different* reason than (a) and would
survive a naive fix that only guarded the empty case.

**Slice 2 RED:** a past-dated `ACTIVE` schedule is closed by the closer; today's is untouched; a
schedule being APPENDed to is not closed mid-flight.

## Implementation Slices

### Slice 1 — Date-filter the day-plan read

- **Objective:** an SE is never served a stale plan.
- **Files:** `apps/backend/src/scheduling/day-plan-query.service.ts`
- **Services:** `scheduling`.
- **Database:** none.
- **Frontend:** none.
- **Tests:** the three-case truth table above.
- **Acceptance criteria:** AC 1, 2.
- **Definition of Done:** scheduling suite green; one-line diff in `where`.
- **Independently mergeable and worth landing alone** — it closes the SE-facing dead end without
  touching the lifecycle.

### Slice 2 — Schedule lifecycle closure

- **Objective:** schedules stop accumulating as permanently `ACTIVE`.
- **Files:** new closer under `apps/backend/src/scheduling/`, following the
  `PlantEligibilityRefreshScheduler` precedent established by #138 Slice 3 (a periodic backstop placed
  beside `DispatchScheduler`).
- **Services:** `scheduling`.
- **Database:** terminal status value if one is not already available on the enum.
- **Frontend:** none.
- **Tests:** past-dated `ACTIVE` → closed; today's → untouched; APPEND-in-flight → not closed.
- **Acceptance criteria:** AC 3, 4, 5.
- **Definition of Done:** no `ACTIVE` row past `dateTo`; #127 APPEND regression green.

## Rollback Plan

Slice 1 is a one-line predicate revert — trivially safe.
Slice 2's closer is a separately registered scheduled job; unregistering it fully reverts the
behaviour without touching data. Any terminal-status enum addition is additive and safe to leave.

## Dependencies

**Blocked by [#144](./144-commit-dispatch-correctness-layer.md)** — `batch-assignment.service.ts` is
dirty and #127's APPEND semantics (which Slice 2 must not race) are uncommitted.

Sequence after [#146](./146-zm-override-integrity-defer-remove.md) to avoid `scheduling` merge
conflicts (no hard dependency between them).

Impact is **amplified by [#54](./54-mobile-foundation.md)** — until the SE mobile client exists, this
defect is real but dormant.

## Estimated Effort

0.5 day. **Priority: P2** — medium production risk, dormant until mobile lands, but Slice 1 is a
one-line fix that removes a structural dead end.

## UI surfaces

n/a — backend read correctness. The SE Day Plan screen is [#54](./54-mobile-foundation.md)/M-series;
**nothing is deferred here**: this issue makes the read correct so that the screen, whenever built,
cannot render a stale plan. No admin surface is affected.

## Reference
n/a

## Blocked by
- [#144](./144-commit-dispatch-correctness-layer.md)
