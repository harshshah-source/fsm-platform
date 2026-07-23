# 155 — The one-schedule-per-(SE, zone, day) unique index does not cover overridden schedules
Status: needs-triage
Type: AFK

> Found 2026-07-22 while fixing [#153](./153-override-blanks-day-plan-and-capacity.md) slice 2. #153
> closed the **code** path; this issue closes the **database backstop** behind it. #153 stays accepted.

## Background

`work_schedules_one_active_per_se_zone_day` is the invariant that an SE has at most one day plan per
zone per day — the backstop #126/#127 were built around. It is a **partial** index
(`migration 20260708120000_dispatch_idempotency_backstops:19-20`):

```sql
CREATE UNIQUE INDEX "work_schedules_one_active_per_se_zone_day"
  ON "work_schedules" ("se_id", "zone_id", "date_from") WHERE "status" = 'ACTIVE';
```

`batch-assignment.service.ts:117-119` describes it as "the final safety net" behind the APPEND lookup.

## Problem

The predicate is `status = 'ACTIVE'`, so **an `OVERRIDDEN` schedule is invisible to the index**. Since
every ZM override flips the schedule to `OVERRIDDEN`, the safety net has a hole exactly where the
system is most active.

Pre-#153 this was not theoretical: the APPEND lookup also matched `ACTIVE` only, so after any override
dispatch created a **second** schedule for the same (SE, zone, day) — and the index let it through.
No P2002, no rollback, no `SCHEDULE_CONFLICT` skip, nothing on the dispatch ledger. Reproduced as
#153's RED (`dispatch-same-day-append.e2e-spec.ts`): 2 schedules where the regression asserts 1.

#153 fixed the lookup, so the duplicate is no longer created **by that path**. But the invariant is now
enforced only in application code. Any other writer — `override.service.ts:440` (`ensureSchedule`
create), a future intraday path, a manual fix-up, a concurrent racer between the lookup and the create —
can still produce a duplicate day plan with the database declining to object.

## Root Cause

The index predicate encodes the *old*, narrower notion of "live". #153 widened that notion in code
(`LIVE_SCHEDULE_STATUSES`) but a migration was deliberately out of scope, so the schema now trails the
code by exactly one enum value.

## Evidence

- Migration `20260708120000_dispatch_idempotency_backstops:19-20` — the partial predicate.
- `schedule-status.ts` — `UNIQUE_ACTIVE_SCHEDULE_INDEX_STATUS`, added by #153 precisely to name the
  divergence rather than hide it, and used by `conflictingScheduleSeIds`.
- `docs/progress/153-overridden-schedule-is-live.md` §"Deviations" item 2.

## What to build

Widen the index predicate to the live set so the database enforces what the code believes:

```sql
WHERE "status" IN ('ACTIVE', 'OVERRIDDEN')
```

**This is not a drop-and-recreate to be done casually.** Duplicates created by the pre-#153 bug may
already exist; the index cannot be created while they do.

## Acceptance criteria

- [ ] Probe first: count existing (se_id, zone_id, date_from) groups with >1 row in the live set, on dev **and** on any environment that has run dispatch. Record the number in this issue — do not assume zero.
- [ ] Any duplicates found are reconciled (merge stops onto the oldest schedule, matching #153's oldest-first reuse rule) **before** the index is created, in the same migration or a documented prior step.
- [ ] The index predicate covers `ACTIVE` and `OVERRIDDEN`; `COMPLETED`/`PARTIAL` stay out (a finished plan must not block tomorrow's).
- [ ] `conflictingScheduleSeIds` and `UNIQUE_ACTIVE_SCHEDULE_INDEX_STATUS` are updated together with the migration — they exist to mirror this predicate, so they must not be left behind.
- [ ] A regression proves the backstop: insert a second live schedule for the same (SE, zone, day) directly via Prisma → P2002.
- [ ] From-zero migrate reports no drift.
- [ ] #153's and #127's regressions stay green.

## TDD Strategy

**RED:** a spec that creates an `OVERRIDDEN` schedule then creates a second schedule for the same
(SE, zone, day) directly through Prisma — bypassing `dispatchForZone` so the application-level fix
cannot mask the missing constraint. Today that insert succeeds; it must P2002.

This is the assertion #153 could not make, and is the whole point of the issue: #153's tests prove the
*code* no longer creates duplicates, not that duplicates are *impossible*.

## Rollback Plan

Revert the index to the `status = 'ACTIVE'` predicate. Any reconciliation of pre-existing duplicates is
**not** reversible — capture the affected rows before merging them.

## Dependencies

Blocked by [#153](./153-override-blanks-day-plan-and-capacity.md) (done) — the code path must already
be correct, or creating the index will simply start failing live dispatch runs.

Note [#107](./107-ci-concurrency-guard-migration-tests.md) covers from-zero migrate in CI; this issue's
drift check rides on that once it runs.

## Estimated Effort

S/M — the migration is small; the duplicate probe and any reconciliation are the real work.
**Priority: P2.**

## UI surfaces

None. Pure data-integrity constraint.

## Reference
n/a (schema constraint)

## Blocked by
- [#153](./153-override-blanks-day-plan-and-capacity.md) — done
