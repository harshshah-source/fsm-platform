# 147 — SE day-plan date filter + work-schedule lifecycle closure

TDD completion report. Frozen once written — corrections go to INDEX/SYSTEM-STATE, not here.

Both slices landed. Slice 1 makes the *read* safe; Slice 2 makes the *state* honest.

## Slice 1 — the day-plan read is date-filtered

**RED** — `test/day-plan-date-filter.e2e-spec.ts`, the three-case truth table the issue specified, on
hand-built schedules so the dates and `dispatchedAt` stamps are exactly the ones under test:

| case | fixture | before | after |
|---|---|---|---|
| (a) | only a yesterday-dated live schedule | **served yesterday's plan** | empty plan |
| (b) | today's schedule | today's plan | today's plan (pins existing behaviour) |
| (c) | both, yesterday's carrying the **newer** `dispatchedAt` | **served yesterday's** | today's plan |

First run: `2 failed | 1 passed` — (a) and (c) red, (b) green, exactly as the issue predicted. The two
failures had different causes, which is the point of (c): (a) is the missing predicate, (c) is the
`orderBy: { dispatchedAt: 'desc' }` compensation picking the wrong row. A fix that only guarded the
empty case would have left (c) red.

**GREEN** — one predicate in `day-plan-query.service.ts`:
`dateFrom: { lte: today }, dateTo: { gte: today }`, with `today = utcDayStart(opts.now ?? new Date())`
reusing the shared `common/utc-day.ts` helper rather than growing a fourth private copy.

**One deliberate signature change.** `getDayPlan(seId)` → `getDayPlan(seId, { now? })`. The read is now
date-dependent, so a fixture that dispatches for a past day has to state its clock; production passes
nothing and gets the wall clock. Three existing specs with past-dated fixtures now pass `{ now: NOW }` —
`day-plan-query` (2026-06-21), `override-schedule-live` (2026-06-21), `override-defer-leaves-today`
(2026-06-24), seven call sites. That is each fixture declaring its own day, not an expectation weakened
to fit the code: what those suites assert (stop clustering, the #153 status widening, #146 defer
semantics) is unchanged. `schedules.controller.ts` is unchanged.

**Process note.** The two `override-*` specs were missed on the first pass: the grep for `getDayPlan`
callers was truncated at 20 lines and read as "no other callers", and they were only caught by the full
suite run. Corrected by re-running the search unbounded — 11 test call sites + 1 production caller, all
accounted for. Recorded because the failure mode is the reason for the AC that says *run the whole
suite*: a truncated search is indistinguishable from an empty one.

## Slice 2 — the closing transition

**RED** — `test/schedule-closure-scheduler.e2e-spec.ts` (6 tests) + `test/schedule-closure-wiring.e2e-spec.ts`.
First run failed on the missing module, then `1 failed | 5 passed`, then green.

**AC-by-AC:**

- **Schedules reach a terminal status** — a past-dated live schedule is closed, today's is untouched.
  No schema change was needed: `COMPLETED`/`PARTIAL` already existed on `work_schedule_status` and were
  already excluded from `LIVE_SCHEDULE_STATUSES` (#153), so writing them removes a row from the live set
  by construction.
- **`COMPLETED` vs `PARTIAL` is derived, not guessed** — a schedule is `PARTIAL` if any still-assigned
  ticket was left unresolved, `COMPLETED` otherwise. `removedAt` tickets are a ZM's withdrawal, not
  unfinished work, so they never hold a day open. Writing `COMPLETED` over a day the SE never finished
  would have reported work that did not happen; the workflow's terminal pair is `COMPLETED | PARTIAL`
  precisely because the distinction is load-bearing for reports.
- **Past-dated `OVERRIDDEN` closes too** — #153's liveness widening grew the stale-serveable population
  (a ZM-touched plan from last week was still "live"), so it is asserted separately from `ACTIVE`.
- **No live schedule past its `dateTo`** — asserted as an invariant (`count === 0` over the whole table
  after a tick), not as a per-row check on the fixture.
- **The closer cannot race an in-flight APPEND** — the case worth the most. Each zone is closed under
  the same `dispatch_zone_<id>` advisory lock #127's APPEND holds for the life of its transaction, taken
  with the `try` variant so a busy zone is skipped rather than waited on. The test holds the lock from a
  **second connection** (a real `pg_advisory_xact_lock` in an open transaction, not a simulation),
  observes the tick report `zonesSkipped: 1` and leave the schedule `ACTIVE`, then releases and confirms
  the next tick collects it. A skipped zone is deferred, never abandoned.

**One shared-key extraction.** The lock string was spelled inline in `batch-assignment.service.ts`.
Two hand-spelled keys that disagreed by a character would take *different* locks and contend with
nothing — a race no test would fail on — so both holders now name it from `dispatch-zone-lock.ts`.

**Wiring is its own test.** Every behavioural test constructs the scheduler by hand, so none of them
would notice a provider that was never registered — a closer that exists but never runs leaves the
defect exactly where it was. `schedule-closure-wiring.e2e-spec.ts` boots the real `SchedulingModule`
and asserts both that the provider resolves and that the `schedule-closure` cron is discovered. It was
RED (provider absent) before the module change.

## Recorded trade-off — lock contention runs both ways

The costly direction is the *other* one: a dispatch that finds the lock held records `LOCK_CONTENDED`
and skips the zone for that run, leaving its SEs with no plan for the day. Two things keep that off the
table rather than one — the crons are an hour apart (closure 04:00 UTC, eligibility refresh 04:30,
dispatch 05:00), and each zone is closed in its own short transaction, so the lock is held for a few
queries rather than for the length of the tick. Anything later added here that widens that window
trades a stale plan for a missing one. Written into the class doc, not just here.

## Posture

Same shape as `PlantEligibilityRefreshScheduler` (#138 slice 3), deliberately: master switch
(`BUSINESS_SWEEPS_ENABLED`, default OFF) re-checked every tick, single-in-flight guard turning an
overlapping tick into a logged skip, structured outcome instead of a throw, cron overridable via
`SCHEDULE_CLOSURE_CRON`. It sits beside `DispatchSchedulerService` rather than joining the #108 business
sweeps, for the same reason that scheduler does — a distinct concern kept separate beats an eleventh
collaborator threaded through `BusinessSweepSchedulerService`.

## Verification

- New specs: `day-plan-date-filter` (3), `schedule-closure-scheduler` (6), `schedule-closure-wiring` (1).
- Clock-stated fixtures, assertions unchanged: `day-plan-query` (3), `override-schedule-live` (5),
  `override-defer-leaves-today` (6).
- Named regressions (AC#5): `dispatch-same-day-append` (#127 APPEND), `dispatch-zone-wedge` (#126),
  `dispatch-uniques`, `dispatch-scheduler`, `dispatch-scheduler-tick`, `batch-dispatch`,
  `batch-dispatch-cadence`, `batch-dispatch-notify`, `batch-stop-order` — 9 files / 26 tests green.
- Full backend suite: see the INDEX session-log line for this commit. `tsc --noEmit` clean.

## Found, not fixed — filed as follow-up

Five sibling reads carry the *same* missing-date-predicate shape `getDayPlan` had —
`liveScheduleFilter()` + `orderBy: { dispatchedAt: 'desc' }`, no date bound:

| file | surface |
|---|---|
| `engineers-query.service.ts:186` | SE detail — "current" schedule + stops |
| `engineers-query.service.ts:260` | SE directory — today's day-plan ticket count |
| `me-tickets-query.service.ts:91` | **SE mobile** — which tickets count as assigned |
| `me-tickets/se-ticket-access.ts:42` | **SE mobile authorization** — may this SE read this ticket |
| `zm-schedule-query.service.ts:90,118` | ZM Schedules page — every live schedule |

Slice 2 fixes all five *by construction* once past-dated schedules are terminal, which is why they are
not patched here. But that holds only while the closer is enabled, and `BUSINESS_SWEEPS_ENABLED`
defaults OFF — so the read-side guard is still worth having, and `se-ticket-access.ts` additionally
needs a product answer (should an SE keep read access to a ticket they worked yesterday?) rather than a
predicate copied across. Filed as a follow-up in INDEX.md; not silently widened into this commit.
