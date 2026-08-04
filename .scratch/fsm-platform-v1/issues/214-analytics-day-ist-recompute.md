# 214 — Move the analytics day to IST and recompute the affected cubes

Status: ready-for-agent — the ruling is made (CONTEXT.md Decisions §19 addendum, operator 2026-08-04);
this issue is its implementation and holds no opinion on the decision itself.
Type: AFK · Backend (+ any report surface that labels a day)
Parent: [#197](./197-mobile-pilot-readiness-remediation-epic.md) · Filed 2026-08-04
Origin: discovered while building [#204](./204-time-semantics-day-boundary-implementation.md) — outside
its ACs, so it was left alone and raised rather than folded in.

## Root cause

#204 moved every **operational** read to the `Asia/Kolkata` day. The **reporting** cubes were never part
of that sweep, because they do not use the shared helper — `business-sweep-scheduler.service.ts:89`
defines its **own** `previousUtcDayStart` (a different symbol, which is exactly why the #204 migration
did not catch it) and passes it to `SystemEfficiencyAggregationService.computeDay` at `:189`.

So a ticket closed at 02:00 IST now sits on **today's** Day Plan and in **yesterday's** efficiency cube.
The two surfaces disagree for 5h30m of every day, and the disagreement is invisible until someone
compares a report against the floor.

## The ruling being implemented

Analytics moves to the **same IST day**, and the affected cubes are **recomputed** so the series is
consistent end to end — explicitly accepting that recompute rewrites already-recorded rows for the
affected range. Leaving analytics on UTC and a cutover-date seam were both considered and rejected;
the reasoning is on CONTEXT.md §19's addendum and does not need re-deriving here.

## Evidence — verified 2026-08-04

- `business-sweep-scheduler.service.ts:89` — `previousUtcDayStart`, the only surviving UTC day boundary
  in the codebase after #204 deleted `utc-day.ts`.
- `:189` — `runGuarded('system-efficiency', () => this.systemEfficiency.computeDay(previousUtcDayStart(now), now))`.
- `system_efficiency_summary_daily` **already holds rows computed on UTC boundaries** — this is the fact
  that makes the change not like-for-like, and the reason recompute is part of the ruling rather than
  an optional extra.
- `apps/backend/src/common/ist-day.ts` (#204) is the helper to adopt — `istDate` for `@db.Date`
  comparisons, `istDayStartInstant` for `@db.Timestamptz`. Picking the wrong one shifts a window by
  5h30m with nothing failing loudly, which is the failure mode #204 documented.

## Scope

**In:** the day boundary used by every report cube, and a recompute of the affected rows.

**Audit first, before changing or recomputing anything.** Only the system-efficiency cube was examined.
These four were **not**, and each needs its boundary and its stored-row semantics established before it
is touched:

| Cube | Table |
|---|---|
| System efficiency | `system_efficiency_summary_daily` |
| Fleet uptime | `device_downtime_summary_monthly` |
| Root cause | `root_cause_summary_monthly` |
| ZM performance | `zm_performance_summary_monthly` |
| Soft inactive | `soft_inactive_count_history` |

The monthly cubes may or may not be affected — a month boundary moves by 5h30m too, so a month's first
and last day can gain or lose rows — but that is a question to answer per cube, not to assume.

**Out:** the operational day boundary (#204 owns it, done). Changing what the cubes *measure* — this is
a bucketing change only. The recompute's operational choreography (when it runs, whether the reports are
readable while it does) is worth a line in the plan but is not a redesign of the aggregation services.

## Acceptance criteria

- [ ] Every report cube's day (and month) boundary is the IST one, via `common/ist-day.ts`; no aggregation
      service defines its own day boundary — `previousUtcDayStart` is **deleted**, not left beside the
      new call
- [ ] The four unaudited cubes have a written finding each: affected or not, and why — recorded on this
      issue before any recompute runs
- [ ] Affected historical rows are recomputed, and the range recomputed is **recorded** (which cubes,
      which dates, when, by whom) so a later reader can tell which rows were rewritten
- [ ] A recompute is idempotent and re-runnable — running it twice produces the same rows
- [ ] A regression test pins a boundary case per affected cube: an event at 02:00 IST lands in **that**
      IST day's row, not the previous one. `#183`'s frozen-clock fixture pattern applies
- [ ] Any report surface that labels a day states which day it means, so the 5h30m question cannot be
      re-asked from the UI

## Verification

```bash
cd apps/backend && node scripts/run-tests.mjs test/system-efficiency-report.e2e-spec.ts \
  test/fleet-uptime-report.e2e-spec.ts test/root-cause-report.e2e-spec.ts
node scripts/run-tests.mjs   # full — the cubes are read by several report surfaces
```

## Risk if deferred

The window is open right now: operations moved to IST with #204 and analytics did not. Every day that
passes writes more rows on the old boundary, so the recompute range only grows. The failure mode is also
the expensive kind — nobody reports it as a bug, they report that "the numbers look wrong", and the
5h30m offset is not the first thing anyone checks.

## Size estimate

M. The boundary change itself is small and mechanical; the audit of four cubes and a recorded,
re-runnable recompute are the bulk.
