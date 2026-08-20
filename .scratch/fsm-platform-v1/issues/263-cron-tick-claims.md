# 263 — DB-side cron tick claims: a second sweeps-enabled instance becomes a safe no-op

Status: ready-for-agent
Type: AFK · Backend
Decision: #258 Q8.7 (G6)

## Objective

Correctness must not depend on `BUSINESS_SWEEPS_ENABLED`/`INGESTION_SCHEDULER_ENABLED` being set on
exactly one instance. If two instances both run schedulers, each cron fire window has exactly one
winner; losers log a no-op.

## Current behaviour

Every `@Cron` in the app (18 jobs, pinned by `scheduler-wiring.e2e-spec.ts`) fires wherever the env
flag is truthy. Two enabled instances = every sweep twice: duplicate `dispatch_runs` rows (degraded
to LOCK_CONTENDED noise), doubled report-cube rebuilds racing delete+insert, doubled notification
sends, and the recommender's silent P2002 `continue` drops (`recommender.service.ts:610`). The
per-name in-flight `Set` in `runGuarded` (`business-sweep-scheduler.service.ts:134-150`) is
process-local.

## Required change

1. `cron_tick_claims` table: `(job_name TEXT, window_start TIMESTAMPTZ, claimed_by TEXT,
   claimed_at TIMESTAMPTZ)` with `UNIQUE (job_name, window_start)`. `claimed_by` = the #98 build
   stamp / hostname+pid, for diagnosis.
2. `claimTick(jobName, firedAt)` helper: derive `window_start` by truncating `firedAt` to the
   minute; `INSERT ... ON CONFLICT DO NOTHING`; inserted → run, else → log `tick already claimed by
   <claimed_by>` and return. One indexed statement per tick.
3. Wire it into the shared guard layer, not 18 call sites: `runGuarded` (business sweeps) and the
   equivalent single-flight wrappers in `DispatchSchedulerService`, `ScheduleClosureScheduler`,
   `PlantEligibilityRefreshScheduler`, `VehicleReturnResumeScheduler`, `IntegrationSchedulerService`,
   `PartitionMaintenanceService`. The #260 retry loop claims its retry windows too.
4. Retention: piggyback a daily delete of claims older than 7 days on the partition-maintenance
   tick (no new cron).
5. Manual HTTP triggers are NOT tick-claimed — they are operator actions arbitrated by #259/#268's
   own guards.

## Existing code to reuse

`runGuarded`; `buildStampFields()` for `claimed_by`; partition-maintenance daily tick for retention.

## Data model

`cron_tick_claims` table + unique (one migration). Append-mostly, self-pruned.

## API / UI surfaces

None. Mobile: n/a.

## Acceptance criteria

- [ ] Two app instances against one DB, same job firing in the same minute window: exactly one
      executes (asserted on the job's side effect), the other logs the holder and no-ops.
- [ ] A skipped claim never marks the sweep errored (G7: a no-op is not a failure).
- [ ] Claims older than the retention horizon are pruned.
- [ ] `scheduler-wiring.e2e-spec.ts` still pins 18 jobs (this issue adds no cron).

## Tests

e2e: two-Nest-apps-one-DB claim spec (the #259 two-connection pattern); unit for window derivation
(minute truncation, DST-irrelevant — windows are UTC instants).

## Dependencies / Blocked by

None. Independent of #259-#262; lands any time.

## Risks

Cron drift between instances (>60s clock skew) could produce two windows — acceptable: the zone
claims/uniques below still hold; note the NTP assumption in `docs` (#111 runbook line).

## Rollback

Drop the helper call sites; table is inert.
