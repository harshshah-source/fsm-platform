# 348 — Ingestion silence detection, reaped-run reason, role-safe freshness

**Done 2026-09-03.** Wave 2 of the module-gaps completion plan
(`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4), absorbing survey ids ING-03, ING-06 and ING-08.
Red-first. No upstream dependency; unblocks **#349** (Integration Health page) and **#351**
(dashboard freshness badge), both of which read the fields this slice adds.

## What it closes

Three defects in one surface, all of which had the same shape: **the pipeline was allowed to look
healthy while it was not running.**

**1. A stopped cron read as healthy.** Every detector in `ingestion-alert.ts` counts runs that
*happened* — the streak is a leading block of non-SUCCESS runs. Zero runs is zero non-SUCCESS runs, so
a scheduler that stopped firing scored `streak: 0`, `downstreamGated: false`, `alert: false`: a
perfect bill of health, produced by a pipeline doing nothing at all.

**2. There was no age threshold anywhere.** This is worse than the issue states, and was verified
against the tree before building. `AutoPlantHealthService` computed `ageMinutes` for both feeds and
then compared it with **nothing, in any file**: `grep -rn "overdue\|staleAfter" src/ingestion/` before
this slice returns only the banner's "stuck / overdue" copy for a run still RUNNING past 15 minutes.
So a 21-hour-old snapshot and a two-minute-old one rendered as the same quiet grey "data as of" line,
and the integration-health payload returned a large number that nothing judged. The badge was not
"partly wrong" — it was never a function of freshness at all.

**3. Two roles were never told, and the code hid it.** `GET /snapshots/latest` was
`@Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')`, so a Warehouse Manager and a
Service Engineer got a 403 — which `SnapshotBanner` caught and dropped on the floor. The banner simply
did not appear, which is indistinguishable from a healthy pipeline. The two roles least able to notice
stale telemetry for themselves were the two roles never warned about it.

And separately, **a reaped run recorded no reason**: `snapshot_runs` had no `error` column, so the
heartbeat reaper (#261) flipped an orphaned RUNNING row to FAILED with nothing but a `finished_at`.
In `/snapshots/runs` a process restart and a genuine ingestion failure were the same row.

## The shape of the fix

`IngestionAlertHealth` gains a **silence** verdict alongside its streak verdict:

```
silenceMinutes         minutes since the newest SUCCESS run (null when none is on record)
expectedCadenceMinutes derived from the configured cron
overdueAfterMinutes    expectedCadenceMinutes × 2
schedulerPaused        the master switch is off — stopped on purpose
overdue                no SUCCESS inside overdueAfterMinutes, while the scheduler is meant to run
```

`overdue` folds into the existing `alert`, so the OH health card and the banner both light up off the
flag they already read. `AutoPlantHealthService.FreshnessHealth` gains the matching `stale` /
`staleAfterMinutes` for both feeds — the comparison `ageMinutes` never had. `IntegrationHealth` gains
`schedulerEnabled` so #349's page can render "paused" rather than inventing a verdict.

## Decisions worth keeping

**1. The threshold is derived from the cron, never written down.** `cronCadenceMinutes()` reduces the
configured expression to an interval (`*/30 * * * *` → 30, `0 2 * * *` → 1440). A hard-coded "stale
after 60 minutes" starts lying the first time an operator widens `INGESTION_TELEMETRY_CRON`, and it
lies in the dangerous direction: the banner goes red on a correctly-configured pipeline until somebody
mutes it, and then it stays muted. The threshold has to move with the knob that sets the cadence.

A cron with a day-of-week or day-of-month restriction returns **null**, not a guess. "Every Monday at
2am" has no cadence, and inventing one fires the alert every weekend — the alert-fatigue failure that
gets alerting switched off entirely.

**2. The cadence is resolved from `readIngestionSchedulerConfig()`, not re-spelled.** The value comes
from the same function the `@Cron` decorators evaluate, so the freshness threshold cannot disagree
with the cron the scheduler actually registered. That drift *is* the failure mode this slice fixes, so
reproducing it inside the fix would be self-defeating. `ingestion-alert.ts` stays pure — no Nest, no
`process.env` — and the two services (`SnapshotQueryService`, `AutoPlantHealthService`) thread the
config in through one shared `readIngestionCadence()`.

**3. The default, when a caller supplies no cadence, is *paused*.** A caller that forgets to thread
the config through cannot fabricate a red banner out of nothing. False silence alarms on every surface
would cost more than the gap being closed.

**4. `schedulerPaused` is a third state, not a synonym for either of the other two (AC4).** The
scheduler is off by default (`INGESTION_SCHEDULER_ENABLED` — enabling it is an ops step), which is the
steady state on every dev box and in CI. Suppressing `overdue` there is required or the feature would
be a permanent false alarm. But suppressing it into the *healthy* grey line would be the original
defect wearing a different hat, so pause gets its own amber banner: **"Ingestion paused: the telemetry
scheduler is switched off, so this figure will not advance."** The age is still reported. Pausing
suppresses the *silence* verdict only — a hand-triggered run that FAILED still shows red.

**5. Silence is measured from the newest SUCCESS, inside the window already being read.** The scan
already returns the newest 20 finalized runs; adding `startedAt`/`finishedAt` to that `select` gives
the timestamp for free rather than paying a second query on a path polled from every admin page on a
60-second timer. It also gives the right answer for a pipeline that is retrying and failing every 30
minutes: not quiet, but not fresh either — the freshness clock runs from the last run that actually
produced data, not from the last run of any kind.

No SUCCESS anywhere in that 20-run window also counts as overdue: either nothing has ever run, or the
last twenty finalized runs all failed. Both are "the pipeline is not producing data".

**6. The boundary belongs to the healthy side.** `overdue` is `silence > 2 × cadence`, strictly. At the
30-minute cadence, 60 minutes is fine and 61 is not. One skipped tick is a slow run, a restart, or a
tick another instance claimed (#263); two consecutive missed windows is no longer explicable that way.

**7. Widening `/snapshots/latest` to every authenticated role is not a data loosening.** The payload is
timestamps and run statuses — no device, no ticket, no zone, nothing a role could be scoped to. It
answers "how old is what you are looking at, and is the thing that produces it running". Withholding
that was the defect; the route now carries no `@Roles` at all (`AuthGuard` still applies at the
controller) with a docblock saying why. No `@CurrentScope()` is involved: this is a read with nothing
to scope, not a manager write door.

**8. `ORPHANED_RUN_ERROR`, reused verbatim from `stale-run.ts`.** `MasterSyncRunService.reapStaleRuns`
has written exactly this marker since Issue 97; the snapshot reaper was a line-for-line twin of it that
wrote no reason only because the column did not exist. One vocabulary across both run ledgers means the
two histories read the same way. A run that ends on its own still records `null`, which is what keeps
the marker meaningful.

**9. The banner states a failed read instead of swallowing it.** The dropped 403 is *why* the WM/SE gap
went unnoticed for so long. It is now a quiet grey "freshness unavailable — could not read ingestion
status" line, deliberately **not** an alert: an unreachable API is evidence about the API, not about
ingestion, and turning every transient fetch error into a red banner would re-create decision 1's
failure mode from the other end.

## What was tested, and why in that shape

**The cadence rule is proved against a frozen clock, without a database.** `ingestion-alert.spec.ts`
stays pure, so the boundary (60 vs 61 minutes), the pause suppression, the zero-run case and the
"streak and silence can both be true" case are all provable arithmetic rather than seeded rows.

**The cron parser test imports `DEFAULT_TELEMETRY_CRON` and `DEFAULT_MASTERS_CRON` rather than
retyping them.** If somebody changes the shipped cadence, the assertion that the parser reads it
correctly moves with it — which is the drift this whole slice exists to prevent.

**AC1 is asserted per role over HTTP, not once.** The verdict and the widened route are two halves of
one acceptance criterion ("the banner is red for **every** role"); asserting `overdue` for a ZM only
would pass against a route that still 403s a WM.

**AC2 is asserted through `POST /snapshots/run`, not by calling the reaper.** The reap fires inside
`startRun()`, so triggering the next run is the production path; a direct call would prove the writer
works without proving it is reached. The lifecycle spec covers the other three arms — the direct reap,
a live run being left alone *and* left unlabelled, and a normally-finished run carrying no reason.

**AC4 is asserted at all three layers** (derivation, HTTP payload, banner), because "no false alert"
is a claim about what a surface renders, and the suppression could be correct in the service and lost
in the component.

## Acceptance criteria

- **AC1** — met. `overdue: true` for zero runs and for a SUCCESS older than 2× cadence
  (`ingestion-alert.spec.ts`, `snapshots-api.e2e-spec.ts`); the banner renders red for ZM, WM and SE
  (`snapshot-banner.test.tsx`).
- **AC2** — met. A heartbeat-reaped run shows `error: "orphaned (process restart)"` in
  `/snapshots/runs` (`snapshots-api.e2e-spec.ts`) and on the row itself
  (`snapshot-run-lifecycle.e2e-spec.ts`).
- **AC3** — met. WM and SE sessions get 200 from `/snapshots/latest` and render the banner; the route
  is still 401 unauthenticated.
- **AC4** — met. A disabled scheduler yields `schedulerPaused: true`, `overdue: false`, `alert: false`
  and an "Ingestion paused" banner — never the healthy line, and never an alert. A genuine failure
  still shows through a pause.

## Tests, verbatim

| File | Tests | New |
| --- | --- | --- |
| `apps/backend/test/ingestion-alert.spec.ts` | 32 passed | 16 |
| `apps/backend/test/snapshots-api.e2e-spec.ts` | 17 passed | 11 |
| `apps/backend/test/snapshot-run-lifecycle.e2e-spec.ts` | 9 passed | 4 |
| `apps/backend/test/ingestion-alert.e2e-spec.ts` | 7 passed | 0 (regression) |
| `apps/admin/test/snapshot-banner.test.tsx` | 18 passed | 10 |

**41 new tests.** The four backend files ran together through the DB lock: **4 files / 65 tests, all
passing.** The banner tests were run **red first** — 3 failed (overdue copy, the paused line, the
unavailable line) against the pre-change component, then green at 18/18.

Regression sweep — `integration-health-api`, `integration-health-build`, `stale-run-reaper`,
`snapshot-worker`, `snapshot-ingestion-schema`, `acting-scope-route-sweep`: **6 files / 45 tests, all
passing.** The route sweep is included deliberately, because this slice removes a `@Roles` decorator;
it stays green because `/snapshots/latest` is a GET and the sweep only collects write verbs.
`npx tsc --noEmit` (backend) and `npx tsc -b` (admin) → exit 0.

**Full admin suite → 129 files / 928 tests.** One file fails and it is not this slice:
`issue-122b-ui.test.tsx` expects no "Action Required" heading, which is another wave-2 slice (#350)
in flight in the same working tree. Five further files failed only under full-suite load and pass in
isolation (`assign-console`, `install-create`, `schedule-override`, `ticket-drawer-tabs`,
`scheduler-console-composition`).

## Migration

`20260903140000_snapshot_run_error` — `ALTER TABLE "snapshot_runs" ADD COLUMN "error" TEXT`.
Nullable, no default, no backfill: every existing row is untouched and honest, and NULL means "written
before runs recorded a reason", not "succeeded".

**The Prisma drift gate was not run.** It cannot run on this box — the local `fsm` role has no
`CREATE DATABASE` — so per the standing operator decision for this run the migration is hand-written
and verified by the suite (the four backend specs above exercise the new column end to end).
`prisma/drift-baseline.txt` was deliberately **not** regenerated.

## Follow-ups this slice does not own

- **`apps/admin/src/api/snapshots.ts` still types only the #300 payload.** The new fields (`overdue`,
  `schedulerPaused`, `silenceMinutes`, `overdueAfterMinutes`, `expectedCadenceMinutes`) are declared
  locally in `SnapshotBanner.tsx` because that module belongs to another agent this round and was
  already modified in the working tree. **#351** builds `SnapshotHealthBadge` off `apiSnapshotLatest`
  and should lift the local type into the shared client then; **#349** needs the same for
  `FreshnessHealth.stale` / `staleAfterMinutes` / `IntegrationHealth.schedulerEnabled` in
  `api/integrationHealth.ts`.
- **`BuildHealthPage.tsx` does not render the new freshness verdict.** It is #349's whole subject; the
  backend fields it needs are on the payload now.
- **The master-sync feed has a `stale` flag with no consumer.** Same reason — the health page is #349.
- **Nothing alerts *out* of the platform on silence.** `overdue` is a surface verdict only; there is no
  notification path. If a stopped cron overnight is meant to page somebody, that is a separate issue.
- **`.scratch/locks/backend-test.sh` cannot recover from an orphaned lock directory.** One was
  encountered during this slice: `backend-test.lock` existed with no `owner`/`epoch` inside, so
  `lock_age_min` returned `-1` ("unknown → treat as fresh") and every waiter blocked for the full
  45-minute `STALE_MIN` fallback. The fail-safe is correct in principle — the comment explains exactly
  why guessing an age is worse — but an **empty** lock directory is positively an orphan, not an
  unknown, since a live holder always writes both files immediately after `mkdir`. Worth a cheap
  `[ -z "$(ls -A "$LOCK")" ]` arm. Not this slice's file to change.
