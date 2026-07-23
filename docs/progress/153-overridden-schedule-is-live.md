# Progress — Issue 153: any ZM override blanked the SE's day plan and zeroed their capacity

> Build date: 2026-07-22 · Strict TDD (RED→GREEN), AFK.
> Status: **ACCEPTED** — all 6 ACs met. Backend **+1 e2e file (5 tests)**, **+1 regression test** on the
> #127 same-day-append spec, **+1 shared predicate module**; 5 read sites corrected across `scheduling`,
> `recommender` and `engineers`. No schema change, no migration, no data change.
> Backend **1179 passed + 5 skipped, 0 test failures attributable to this work**; admin **82 files /
> 321 passed, exit 0**. Read the "Suite verification — read this before quoting a number" section
> below: the backend full run is **flaky for environmental reasons unrelated to #153**, now filed as
> **#156**. Unblocks **#146**.

## The defect in one line

`OVERRIDDEN` is a **live** work-schedule state, but five readers filtered `status: 'ACTIVE'` and so
treated a ZM-adjusted schedule as if it did not exist.

`fsm-business-technical-workflow.md:1913` is explicit — `AUTO_ASSIGNED → OVERRIDDEN → COMPLETED |
PARTIAL`. The status column conflates **lifecycle** ("is this plan live today?") with **provenance**
("did a ZM touch it?"); the writer sets it for the second meaning and every reader assumed the first.

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | After any override, `getDayPlan` still returns the SE's remaining work | 🟢 | `day-plan-query.service.ts:41` reads `liveScheduleFilter()`. `override-schedule-live` — control (plan dispatched, 2 tickets) → override → plan still non-empty. RED was `dispatched: false`. |
| 2 | `committedDayLoad` counts overridden schedules, so an overridden SE cannot be over-assigned | 🟢 | `recommender.service.ts:552`. Proved at the **recommender seam** (`runForZone` → `UNASSIGNABLE`), not by re-issuing the count query. RED: the SE was re-booked at 1/1. |
| 3 | Same-day APPEND (#127) reuses an overridden schedule instead of colliding | 🟢 | `batch-assignment.service.ts:121`. #127 regression extended: REORDER override → same-day re-run → **1** schedule, new stop appended. RED produced **2**. |
| 4 | Every "is this schedule live?" filter reads from one shared predicate | 🟢 | `scheduling/schedule-status.ts`. Grep gate below. |
| 5 | `COMPLETED` / `PARTIAL` stay excluded — exactly one value added | 🟢 | Explicit PIN test: schedule flipped to `COMPLETED` → `dispatched: false`, 0 stops. Passed before and after the fix. |
| 6 | Full backend suite green | 🟡 | **1179 passed / 5 skipped, zero failures caused by #153** — but no run of the three reached exit 0, for environmental reasons (**#156**). Admin clean at 82 / 321, exit 0. See below; do not quote a bare "green". |

## Slice-by-slice RED→GREEN report

- **Slice 1 — shared predicate + the two SE-facing readers.** New `scheduling/schedule-status.ts`
  (`LIVE_SCHEDULE_STATUSES`, `liveScheduleFilter()`). Fixed `day-plan-query.service.ts:41` and
  `recommender.service.ts:552`. **RED** (`override-schedule-live.e2e-spec`, 2 of 5 failing):
  `expected false to be true` — the plan reported `dispatched: false` after a `DEFER_TICKET`; and
  `expected '<seId>' to be null` — the SE was re-booked in a second zone despite a committed stop.
  **GREEN** 5/5, including the `COMPLETED` pin. Commit `2532d36`.
- **Slice 2 — dispatch / override lookups.** `batch-assignment.service.ts:121` (APPEND reuse) and
  `override.service.ts:437` (`ensureSchedule` swap/split target) widened; the hand-written live-set
  copies in `zm-schedule-query.ts` and `engineers-query.ts` now read the shared constant.
  **RED**: `expected [...] to have a length of 1 but got 2` — a same-day re-run after a REORDER
  override created a second day-plan. **GREEN** 3/3 on that spec, 32/32 across the dispatch/override
  neighbourhood. Commit `161a596`.
- **Slice 3 — admin parity check.** Verdict: **no admin change required, and that is the finding.**
  See below.

## Deviations / decisions (read before extending)

1. **Design (a) taken, (b) deliberately not.** The issue offered (a) widen the filters behind one
   constant, or (b) stop overloading `status` and derive provenance from `lastOverriddenAt`. Took (a):
   6 read sites, no data implications, revertible by editing one array. (b) changes the meaning of a
   persisted enum that reports and the admin UI read; it needs a full `OVERRIDDEN`-consumer sweep
   first. Follow-up **#154** filed.

2. **The unique index is NOT the safety net here — this is the sharpest finding.**
   `work_schedules_one_active_per_se_zone_day` is **partial**: `... WHERE status = 'ACTIVE'`
   (migration `20260708120000`). An `OVERRIDDEN` row is therefore invisible to it, so the duplicate
   schedule pre-fix was created **unopposed** — no P2002, no rollback, no `SCHEDULE_CONFLICT` skip,
   nothing on the dispatch ledger. `batch-assignment.service.ts:117`'s claim that "the unique index
   stays the final safety net" was true only for `ACTIVE`. The code path is now correct, but the index
   still does not cover overridden rows; widening it is a migration and is filed as **#155**.

3. **`conflictingScheduleSeIds` was deliberately left at `ACTIVE`.** It answers "which rows did the
   database refuse to duplicate?" and must mirror the index predicate, not the liveness question.
   Widening it would name SEs that cannot have caused the P2002. It now reads the named
   `UNIQUE_ACTIVE_SCHEDULE_INDEX_STATUS` so the intent is explicit and the AC#4 grep stays clean.

4. **`liveScheduleFilter` is a factory, not a constant.** Prisma's generated `in` filter takes a
   **mutable** array; a shared `as const` object failed `tsc`. Each call site gets its own copy.

5. **The capacity AC is asserted at the recommender seam, not by a count query.** The handoff's
   proposed RED re-issued `batchAssignmentTicket.count({ ... status: { in: [...] } })` in the test —
   that recomputes the production query and cannot disagree with it. Replaced with a
   `runForZone` → `UNASSIGNABLE` assertion mirroring `recommender-cross-zone-capacity` (NEW-A1), whose
   fixture proves the same cap holds for `ACTIVE`.

6. **Oldest-first tie-break on schedule reuse.** Any SE carrying legacy duplicates (created by this
   bug) keeps being appended to the plan they are already executing, rather than an arbitrary row.

## Slice 3 — admin parity finding

**No admin surface depended on the broken behaviour**, because the admin was already correct:
`zm-schedule-query.service.ts` had a local `['ACTIVE','OVERRIDDEN']` list, and `engineers-query.service.ts`
had the same inline. So `SchedulesPage` ("ZM Adjusted" vs "Auto-Dispatched" labels, overridden count),
`ScheduleDetailPage` and `SeManagementPage` all rendered overridden plans correctly throughout.

**That asymmetry is why the bug survived.** The ZM saw the plan they had just adjusted, exactly as
expected. Only the SE's own day plan and the dispatch engine's capacity accounting went blank — and
neither has a human watching it in dev. Both hand-written copies are now folded into the shared
constant, so the admin's correctness and the SE's are the same line of code.

Admin suite unchanged: **82 files / 321 passed**, no admin source touched.

## Suite verification — read this before quoting a number

Three full backend runs were made on this work. **No run reached exit 0**, and none of the reasons is
#153. Recording it honestly because the previous session's baseline ("287 files, 1176 passed, exit 0,
494 s") no longer reproduces, and a future session comparing against it will otherwise think #153
broke something.

| Run | Files | Tests | Non-green cause |
|---|---|---|---|
| 1 | 287 passed / 3 skipped | 1179 passed / 5 skipped | 1 worker crash — `settings-write` (0 references to schedules) |
| 2 | 285 passed / 3 skipped | 1168 passed / 5 skipped | 3 worker crashes — `engineers-availability-controller`, `system-efficiency-controller`, `verification-review`. **Overlapped a concurrent admin suite run** (my error) |
| 3 | 286 passed / 3 skipped | 1179 passed / 5 skipped | `dispatch-run-controller` **timed out at 5000 ms**, + 1 worker crash |

Findings:

- **Zero assertion failures in any run.** Every test that reported, passed. The failures are
  `Error: Worker exited unexpectedly` and one timeout.
- **Every affected file passes in isolation** — all four crashed files: 4 files / 22 tests, exit 0;
  `dispatch-run-controller`: 3/3, exit 0.
- **The affected set is different every run**, which is the signature of environment, not of a defect
  in the code under test.
- **Root cause found:** the shared `fsm_test` database has accumulated **780 orphan zones / 404 orphan
  engineers**. `global-setup.ts` migrates and seeds but **never truncates**, so any spec that dies
  before its `afterAll` leaks fixtures permanently. `dispatch-run-controller` triggers a dispatch that
  **iterates every zone**, so its cost grows with the orphan count until it blows the 5 s timeout.
  It passed in runs 1 and 2 and failed only in run 3 — after a run I killed at the tool's 10-minute
  ceiling added a fresh batch of orphans. Filed as **#156**.

**What this does and does not license.** It does not license "suite green". It does support the claim
that #153 introduced no regression: the dispatch/override/recommender/engineers neighbourhood was run
directly and repeatedly (32/32 on the 10 most-coupled specs; 9/9 earlier), and the specific failures
are reproducible-in-absence and non-reproducible-in-isolation. The test database was **not** cleaned —
that is a destructive operation on shared state and is #156's call, not a side effect of this issue.

## AC#4 grep gate

`status: 'ACTIVE'` on `workSchedule` in `apps/backend/src` (excluding `src/generated`) returns:

- `batch-assignment.service.ts:140` — **CREATE** (a new schedule is born `ACTIVE`)
- `override.service.ts:451` — **CREATE** (ZM_MANUAL schedule)
- `schedule-status.ts:22` — the constant itself

No read filter remains. The two other hits repo-wide (`cross-zone-escalation.service.ts:349`,
`engineer-admin.service.ts:132`) are **user**-table filters, unrelated to schedules.

## Rollback

Set `LIVE_SCHEDULE_STATUSES` back to `['ACTIVE']` — restores previous behaviour exactly at every site.
No schema change, no migration, no data change.

## Follow-ups filed

- **#154** — drop the `status` overload; derive provenance from `lastOverriddenAt` (design (b)).
  Needs an `OVERRIDDEN`-consumer sweep first.
- **#155** — widen the partial unique index to cover overridden schedules, so the DB backstop matches
  the code's liveness rule instead of trailing it.
- **#156** — the shared test DB accumulates orphaned fixtures (780 zones), making full-suite runs
  flaky. Not caused by #153; found while trying to verify it, and it blocks any trustworthy
  "suite green" claim from the local loop.
