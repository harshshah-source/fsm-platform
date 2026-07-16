# 127 — Per-SE isolation in dispatchForZone (one SE's conflict must not fail the whole zone)
Status: ready-for-agent
Type: AFK

> Source: #126 fix-design review (2026-07-16). Split out so #126 stays scoped to the no-wedge
> guarantee; this is the fast-follow that removes the whole-zone blast.

## Problem

`dispatchForZone` (`scheduling/batch-assignment.service.ts:54-143`) creates every SE's schedule,
batches and ticket flips for a zone in **one** `$transaction`. A single failure — most concretely a
P2002 when one SE already holds an `ACTIVE` `work_schedule` for that zone/day (a ZM manual schedule via
`override.ensureSchedule`, `override.service.ts:440-450`) — rolls back the **entire zone**.

After [#126](./126-dispatch-zone-wedge-orphaned-suggested-recs.md) that is no longer a permanent wedge
(it becomes a clean, reason-annotated skip with orphan cleanup), **but the operational consequence
stands:**

> Until this lands, any zone where a ZM created a manual schedule for an SE that day yields a
> **whole-zone** clean skip for that day's auto-dispatch — every *other* SE in the zone goes
> undispatched because of one SE's pre-existing schedule.

ZM overrides are daily-normal, so this is a fast-follow, not a someday — it sits on Next-up directly
after #126.

## What to build

Make one SE's conflict skip **only that SE**, so the rest of the zone still dispatches. Implementer's
choice of shape:
- **Per-SE sub-transaction / savepoint** — each SE's schedule + batches + ticket flips commit or skip
  independently within the run; or
- **Pre-filter** — before the write loop, drop SEs who already hold an `ACTIVE` schedule for the
  zone/day (record the skip reason), keeping a single tx for the remainder.

Preserve the #126 guarantees (no wedge, orphan cleanup, no silent skips). Observe-only on
selection/scoring/ordering.

## Acceptance criteria

- [ ] One SE with a pre-existing `ACTIVE` zone/day schedule is skipped (recorded reason) while **every
      other SE in the zone dispatches normally** — asserted by test (the exact scenario that today
      zeroes the whole zone).
- [ ] The skipped SE's tickets are handled per #126 — no orphan `SUGGESTED` left; fresh re-evaluation
      next run.
- [ ] Per-SE skips are visible in `dispatch_run_zones` (count + which SE(s)), never silent.
- [ ] Existing dispatch / transparency suites green; tsc + build clean both apps.

## Blocked by
[#126](./126-dispatch-zone-wedge-orphaned-suggested-recs.md) — the no-wedge + cleanup layer lands
first (this builds on the reason-annotated skip it introduces).
