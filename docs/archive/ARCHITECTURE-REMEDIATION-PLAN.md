# Architecture Remediation Plan — Backend Design Review (2026-07-02)

> **ARCHIVED 2026-07-12 — executed/refiled plan.** R1–R4 landed pre-#97; R6→#100 (done), R7→#101 (partial), R8→#105, R9 tail→#103, R5/R10 → #106 perf family. Current gaps: `docs/SYSTEM-STATE-2026-07.md` §5.
Status: ready-for-agent
Scope: `apps/backend` only. Produced from a senior-architect design review of the NestJS
modular-monolith at mid-build. Each section below is a self-contained remediation spec an
agent (Opus) can execute as a vertical slice. Findings are ordered by severity; the
**recommended build order is R1 → R2 → R3 → R4 → R6 → R5 → R7 → R8 → R10 → R9**
(R1–R4 must land before the real AutoPlant `SourceReader` is wired).

Conventions used throughout:
- All paths are relative to `apps/backend/` unless stated otherwise.
- "Raw-SQL migration" = the existing project pattern: Prisma migration file with hand-written
  SQL appended (same posture as the partial-unique indexes and PostGIS geometry).
- Every remediation must keep the existing TDD posture: RED test first, then implement.
- Do NOT re-add any activity-ping staleness gate to the Recommender (see memory:
  `last_activity_at` never gates scoring — HEARTBEAT_STALE was deliberately removed).

---

## R1 (BLOCKER) — Add the scheduler/worker runtime; wire the inert core loop

### Problem
The platform has **no autonomous behavior**. `package.json` contains no `bullmq`, no
`ioredis`, no `@nestjs/schedule`. Worse:

- `DeviceStateService` (`src/device-state/device-state.service.ts`) is **not provided by any
  Nest module** and has no controller — `device_states` never refreshes in a deployed app.
- `TicketCreationService.createForInactiveEligible` (`src/ticketing/ticket-creation.service.ts:27`)
  has no caller outside tests.
- `RecommenderService.runForZone`, `BatchAssignmentService.dispatchForZone`,
  `IntradayInsertionService.fireForZone`/`sweepTimeouts`, `VerificationService.runVerification`,
  the report aggregations (`src/reports/*-aggregation.service.ts`), the soft-inactive twice-daily
  snapshot, VIEWED soft-state timeout clearing, and the `plant_eligible_floating_se` MV refresh
  are all invoke-on-demand only (some via Operations-Head HTTP POSTs, some with no trigger at all).

Every time-driven *system guarantee* (10-minute acceptance timeout, twice-daily snapshot,
5-minute verification scan, SLA bucket advancement) is currently a *human procedure*.

### Target design
One **JobsModule** owning all recurring work, built on **BullMQ + Redis** (the declared stack).
Design it as a thin dispatch layer over the existing invokable services — the services already
take `now: Date` and are idempotent/re-entrant by design, so no service rewrites are needed.

```
src/jobs/
  jobs.module.ts          // BullModule.forRoot (Redis from env) + queue registrations
  jobs.config.ts          // cadence table (see below), env-overridable
  core-loop.processor.ts  // ingest → recompute → ticket-create → intraday-fire (per zone)
  sweeps.processor.ts     // intraday sweepTimeouts, verification scan, soft-state VIEWED timeout,
                          // repeat-escalation, install-lifecycle sweep
  aggregations.processor.ts // daily efficiency, month-end fleet-uptime/root-cause/zm-scorecard,
                          // twice-daily soft-inactive snapshot, MV refresh, partition maintenance (R3)
  jobs.controller.ts      // GET /api/jobs/health (last-run, lag per job) — OPERATIONS_HEAD
```

Cadence table (all env-overridable, values from the LLD/CONTEXT):

| Job | Cadence | Invokes |
|---|---|---|
| `snapshot-ingest` | every 15 min (configurable) | `SnapshotIngestionWorker.run()` |
| `device-state-recompute` | after each successful ingest run (chained), fallback every 15 min | `DeviceStateService.recompute()` (post-R4 version) |
| `ticket-create` | chained after recompute | `TicketCreationService.createForInactiveEligible()` |
| `intraday-fire` | chained after ticket-create, per zone | `IntradayInsertionService.fireForZone(zoneId)` |
| `intraday-sweep-timeouts` | every 1 min | `sweepTimeouts()` |
| `verification-scan` | every 5 min | `VerificationService.runVerification()` |
| `soft-state-timeout-sweep` | every 5 min | soft-state VIEWED expiry |
| `morning-batch` | daily at zone-morning (e.g. 06:00 IST), per zone | `RecommenderService.runForZone` then `BatchAssignmentService.dispatchForZone` |
| `soft-inactive-snapshot` | twice daily (e.g. 06:00 / 18:00 IST) | `SoftInactiveCountService.recompute()` |
| `efficiency-daily` | daily 00:30 | `SystemEfficiencyAggregationService` (previous day) |
| `fleet-uptime`, `root-cause`, `zm-scorecard` | month-end (1st, 01:00, previous month) | respective aggregation services |
| `mv-refresh-floating-se` | on territory/coverage mutation (already service-driven) + nightly safety refresh | `PlantEligibleFloatingSeService.refresh()` |
| `partition-maintenance` | daily 00:10 | R3 partition/retention SQL |

### Implementation steps
1. `npm i bullmq ioredis` in `apps/backend`; add `REDIS_URL` to `.env.example`.
2. Provide `DeviceStateService` properly: create `src/device-state/device-state.module.ts`
   (imports `PrismaModule`, `SettingsModule`; exports the service). Import it from `JobsModule`
   and `IngestionModule`.
3. Chain the core loop as a BullMQ **flow** (parent/child jobs) so recompute only runs after a
   successful ingest, ticket-create after recompute, intraday-fire after ticket-create. A
   failed parent halts the chain for that tick — the next tick retries; every service in the
   chain is already idempotent, so replays are safe.
4. Per-zone jobs (`morning-batch`, `intraday-fire`): enumerate zones at enqueue time
   (`prisma.zone.findMany`) and enqueue one child job per zone — zone failures are isolated.
5. Concurrency: set queue concurrency 1 for `snapshot-ingest`, `morning-batch`, and
   `device-state-recompute` (they are single-writer by design; the ingest advisory lock +
   partial unique remain the DB backstop). Sweeps can be concurrency 1 as well — they are
   cheap and 1-minute cadence.
6. Observability: each processor writes a Pino log line with `{job, durationMs, resultSummary}`;
   `GET /api/jobs/health` reads BullMQ job counts + last-completed timestamps so the admin
   dashboard "data as of" banner logic can also alert on scheduler lag.
7. Keep every existing on-demand HTTP trigger (they become manual re-run buttons); update their
   doc comments from "cron deferred" to "cron-wired via JobsModule; endpoint = manual re-run".
8. Graceful shutdown: `onModuleDestroy` closes queues/workers so deploys don't strand jobs
   (interacts with R2's stale-run reaper for the ingest case).
9. Local/dev/test posture: `JOBS_ENABLED=false` (default in test/CI) makes `JobsModule` register
   nothing — the existing test harness keeps driving services directly.

### Acceptance criteria
- Fresh boot with `JOBS_ENABLED=true` + seeded data: within one cadence cycle, `device_states`
  rows advance, an artificially-stale device gets a ticket, a CRITICAL ticket gets an intraday
  offer, and an expired offer is rerouted by the sweep — with zero manual HTTP calls.
- With `JOBS_ENABLED=false`, the full existing test suite passes unchanged.
- `GET /api/jobs/health` shows per-job last-run and lag.

---

## R2 (BLOCKER) — Make snapshot ingestion crash-safe and asynchronous

### Problem
`SnapshotRunService.startRun` (`src/ingestion/snapshot-run.service.ts:26-44`) creates a
`RUNNING` row guarded by the raw-SQL partial unique `WHERE status='RUNNING'`. The advisory
xact-lock releases on process death, but the `RUNNING` **row** does not — after a crash every
future `startRun` 409s forever. No reaper, no heartbeat. Additionally,
`POST /api/snapshots/run` (`src/ingestion/snapshots.controller.ts:48-54`) executes the entire
source drain synchronously inside the HTTP request — a production full-table drain over VPN
will outlive any proxy timeout, and a client disconnect doesn't stop the run.

### Target design
Heartbeat + reaper + enqueue-and-return:

1. **Schema (additive migration):** add to `snapshot_runs`:
   - `heartbeat_at timestamptz` (nullable)
   Prisma model: `heartbeatAt DateTime? @map("heartbeat_at") @db.Timestamptz(6)`.
2. **Heartbeat:** `SnapshotIngestionWorker.run` updates `heartbeat_at = now()` after each chunk
   (piggyback on the existing `snapshotRunChunk.update` — same loop, one extra `snapshotRun.update`;
   or batch it every N chunks if chunk cadence is sub-second).
3. **Reaper inside `startRun`:** before attempting the insert, within the same transaction that
   takes the advisory lock:
   ```sql
   UPDATE snapshot_runs
      SET status = 'FAILED', finished_at = now()
    WHERE status = 'RUNNING'
      AND coalesce(heartbeat_at, started_at) < now() - interval '10 minutes';
   ```
   The advisory lock guarantees no *live* run is reaped (a live run's process holds the lock
   only during startRun, so use the heartbeat threshold, not the lock, as the liveness signal —
   10 min with a per-chunk heartbeat gives ample margin). A reaped run's chunks stay in
   `snapshot_run_chunks` for diagnosis; ingestion idempotency (`ON CONFLICT DO NOTHING`) makes
   the re-run safe.
4. **Async endpoint:** once R1 lands, `POST /api/snapshots/run` becomes:
   - enqueue a `snapshot-ingest` job; return `202 { enqueued: true }`;
   - if a run is currently `RUNNING` (fresh heartbeat), return the existing
     `409 RUN_IN_PROGRESS` verbatim (keeps the admin UI contract).
   Keep a `?sync=true` escape hatch guarded to non-production env for the e2e harness, or —
   preferred — point the e2e harness at `worker.run()` directly as it already does.
5. **Chunk-failure budget:** add `maxConsecutiveFailedChunks` (default 5) to
   `SnapshotRunOptions` in `snapshot-ingestion.worker.ts` — a dead source connection currently
   burns 3 retries × every remaining chunk; abort the run as `FAILED`/`PARTIAL` early instead.

### Acceptance criteria
- Kill the process mid-run (test: throw inside a chunk after 1 success) → next `startRun`
  succeeds after the threshold, prior run is `FAILED`, no manual SQL needed.
- A live run (fresh heartbeat) still 409s a concurrent start.
- `POST /api/snapshots/run` returns in <100 ms in production mode.

---

## R3 (BLOCKER) — Real partitioning + retention for `raw_device_snapshots`

### Problem
`prisma/migrations/20260619153000_add_snapshot_ingestion/migration.sql:61-66` declares
`PARTITION BY RANGE ("gps_datetime")` but creates **only the DEFAULT partition**. All telemetry
lands in `raw_device_snapshots_default` — one unbounded heap, which defeats the design and is
expensive to reverse later (splitting a populated default partition = detach + rewrite under
lock). No retention policy exists for telemetry (nor for `audit_logs` / `notifications`).

### Target design
1. **Migration (do now, while the table is small):**
   - Create monthly partitions covering `[first month of data .. now + 3 months]`:
     ```sql
     CREATE TABLE raw_device_snapshots_y2026m07 PARTITION OF raw_device_snapshots
       FOR VALUES FROM ('2026-07-01+00') TO ('2026-08-01+00');
     -- … repeat per month
     ```
   - Drain the default partition into the proper monthly partitions:
     ```sql
     BEGIN;
     ALTER TABLE raw_device_snapshots DETACH PARTITION raw_device_snapshots_default;
     INSERT INTO raw_device_snapshots SELECT * FROM raw_device_snapshots_default
       ON CONFLICT DO NOTHING;
     DROP TABLE raw_device_snapshots_default;
     CREATE TABLE raw_device_snapshots_default PARTITION OF raw_device_snapshots DEFAULT;
     COMMIT;
     ```
     (Keep a DEFAULT partition as a safety net for clock-skewed rows, but alert if it is ever
     non-empty — see step 3.)
2. **`PartitionMaintenanceService`** (`src/ingestion/partition-maintenance.service.ts`), run
   daily by R1's `partition-maintenance` job:
   - *Create-ahead:* ensure partitions exist through `now + 3 months`
     (`CREATE TABLE IF NOT EXISTS … PARTITION OF …` via `$executeRawUnsafe` with generated,
     validated names — never interpolate external input).
   - *Retention:* `DETACH PARTITION CONCURRENTLY` + `DROP TABLE` for partitions older than
     `telemetry_retention_months` (new `system_settings` key; default 12). Detach-then-drop is
     the entire point of partitioning: retention becomes O(1) instead of a `DELETE` storm.
     Note: monthly report aggregates (`device_downtime_summary_monthly` etc.) already decouple
     reporting from raw telemetry, so dropping old partitions loses nothing the product needs —
     confirm `fleet-uptime` aggregation for a month runs before that month's partition ages out
     (retention 12 ≫ aggregation lag 1, so this holds trivially; assert it in the service).
   - *Alert:* if `raw_device_snapshots_default` has rows, log at WARN and surface in
     `GET /api/jobs/health` — it means a row arrived with a `gps_datetime` outside all created
     ranges (bad source timestamp; investigate the normalizer).
3. **Retention for the other growers** (same service, same job):
   - `audit_logs`: no deletion in v1 (compliance posture) — but add a
     `@@index([createdAt])`-backed monthly report of table size to health; partitioning
     `audit_logs` by month is a future follow-up if growth demands it.
   - `notifications` + `notification_deliveries`: delete read in-app notifications older than
     `notification_retention_days` (default 90); deliveries cascade.
   - `snapshot_runs`/`snapshot_run_chunks`: delete runs older than 30 days (chunks are
     engineering telemetry, documented as purgeable with the parent run).

### Acceptance criteria
- Inserting a row dated next month lands in a real monthly partition, not DEFAULT.
- The maintenance job creates month `n+3` and drops month `n−13` (verified against a seeded
  fake-time harness).
- `EXPLAIN` on the hot read (`WHERE device_id = ? ORDER BY gps_datetime DESC LIMIT 1`) shows
  partition pruning when a time bound is supplied.

---

## R4 (BLOCKER-adjacent) — Set-based, incremental `device_states` refresh

### Problem
`DeviceStateService.recompute` (`src/device-state/device-state.service.ts:34-99`) is
load-the-world:
- `rawDeviceSnapshot.groupBy(deviceId, _max(gpsDatetime))` = full scan + hash-agg over the
  entire telemetry table (all partitions, all history) — the `(device_id, gps_datetime DESC)`
  index does not help this query shape;
- loads **all** devices with vehicle includes into JS memory;
- performs **one upsert per device**, sequentially — 100k devices ≈ 100k round trips, and this
  must run every few minutes to keep SLA buckets honest.

### Target design — two changes, both required

**A. Maintain `latest_gps_datetime` incrementally at ingest time.**
`SnapshotIngestionService.ingestChunk` (`src/ingestion/snapshot-ingestion.service.ts`) already
holds each chunk's rows in memory. After the `createMany`, compute per-device max
`gpsDatetime` within the chunk (a `Map<bigint, Date>`) and issue **one** set-based statement:

```sql
INSERT INTO device_states (device_id, latest_gps_datetime, computed_at)
SELECT * FROM unnest($1::bigint[], $2::timestamptz[], $3::timestamptz[])
ON CONFLICT (device_id) DO UPDATE
  SET latest_gps_datetime = GREATEST(device_states.latest_gps_datetime, EXCLUDED.latest_gps_datetime),
      computed_at = EXCLUDED.computed_at;
```

(`GREATEST` makes chunk replay/out-of-order chunks safe.) Unknown device_ids (telemetry for a
device not yet in `devices`) must not violate the `device_states.device_id → devices` FK:
filter the unnest against `devices` in the same statement
(`… SELECT u.* FROM unnest(...) u JOIN devices d ON d.device_id = u.device_id`), and count the
skipped IDs into the run's `chunk_stats` so master-data gaps are visible.

**B. Rewrite `recompute` as one SQL statement over `device_states` (no telemetry scan).**
The derivation is a pure function of `latest_gps_datetime` + reference data, so:

```sql
UPDATE device_states ds SET
  inactivity_hours = GREATEST(0, EXTRACT(EPOCH FROM ($now - ds.latest_gps_datetime)) / 3600),
  is_inactive      = (ds.latest_gps_datetime IS NOT NULL
                      AND $now - ds.latest_gps_datetime >= make_interval(hours => $threshold)),
  sla_bucket       = CASE ... END,          -- port classifySlaBucket to a SQL CASE; see below
  eligible_for_uptime = EXISTS (SELECT 1 FROM pgi_history p
                                 WHERE p.device_id = ds.device_id
                                   AND p.pgi_date >= ($now::date - 15))
                        AND NOT EXISTS (SELECT 1 FROM non_operational_markings n
                                         WHERE n.device_id = ds.device_id
                                           AND n.state IN ('CONFIRMED','ACTIVE')),
  vehicle_id  = v.vehicle_id, plant_id = v.plant_id,
  company_id  = v.company_id, transporter_id = v.transporter_id,
  computed_at = $now
FROM devices d
LEFT JOIN vehicles v ON v.vehicle_id = d.current_vehicle_id
WHERE d.device_id = ds.device_id;
```

Bucket-classifier parity: `classifySlaBucket` (`src/device-state/sla-bucket.ts`) is a pure
threshold function — generate the SQL `CASE` from the same threshold table (export the
threshold constants; write a unit test asserting the TS classifier and the generated CASE
produce identical buckets across boundary values, e.g. every threshold ±ε). This prevents the
two implementations drifting.

Keep the TS classifier as the single source of truth; the SQL is generated from its exported
threshold table at module init.

**Supporting index (additive migration):** none needed — `device_states` is PK-driven and the
update is a full-table update of a table with one row per device (bounded, ~fleet size), which
is the correct cost model. Add `@@index([hasOpenFailureCycle, isInactive, eligibleForUptime])`
only if `TicketCreationService`'s candidate query shows up in `pg_stat_statements` (its current
`(isInactive, slaBucket)` index is close enough for now).

### Migration/rollout
1. Land A + B behind the existing `recompute()` signature (return `{ upserted }` = affected
   rows) so all call sites/tests keep working; delete the groupBy/loop implementation.
2. One-time backfill: run statement A's logic as a single
   `INSERT … SELECT DISTINCT ON (device_id) device_id, gps_datetime … ORDER BY device_id, gps_datetime DESC`
   over existing telemetry to seed `latest_gps_datetime` for devices ingested before this change.
3. Wire into R1's chain (recompute after ingest).

### Acceptance criteria
- `recompute()` issues O(1) SQL statements regardless of device count (assert with a Prisma
  query-event counter in a test).
- Ingesting a newer ping for a device then running `recompute` flips `is_inactive`/`sla_bucket`
  exactly as before (reuse the existing device-state test suite unchanged — behavior parity).
- Chunk replay (same chunk twice) leaves `latest_gps_datetime` unchanged.

---

## R5 (SHOULD-FIX) — De-N+1 the Recommender run

### Problem
`RecommenderService.runForZone` (`src/recommender/recommender.service.ts:135-238`) per ticket:
- `candidates.orderedCandidatesForPlant(t.plantId)` → **2 queries** (`se_coverage` +
  `plant_eligible_floating_se` MV) with **no per-plant memoization**, even though tickets
  cluster by plant (the `seededPlants` set proves plant repetition is the expected case);
- one `recommendation.create` per ticket;
- `inventory.resolveComponentBlock(ticketId)` per assignable ticket.

≈4–5 sequential round trips × N tickets. At a few thousand open tickets per zone this is tens
of seconds per zone, serialized across zones by the morning batch.

### Target design (keep scoring in JS — weights are DB-tunable and the candidate set per plant
is small; the problem is round trips, not compute)

1. **Prefetch candidates for the run's distinct plants (2 queries total):**
   Add to `CandidateSelectionService`
   (`src/recommender/candidate-selection.service.ts`):
   ```ts
   async orderedCandidatesForPlants(plantIds: bigint[]): Promise<Map<string, CandidateSe[]>>
   ```
   - one `seCoverage.findMany({ where: { plantId: { in: plantIds } }, orderBy: [{ plantId:'asc' },{ seId:'asc' }] })`
   - one `SELECT plant_id, se_id FROM plant_eligible_floating_se WHERE plant_id = ANY($1) ORDER BY plant_id, se_id`
   - group in JS preserving the DEDICATED → MULTI_PLANT → FLOATING precedence per plant.
   Keep the single-plant method delegating to the batch one (intraday + manual-assign reuse it).
2. **Precompute run-wide inputs once** (already done for capacity/weights/planner — extend):
   - kit status: `InventoryService.commonKitStatusMany(seIds)` — one query over
     `se_van_stock` + `common_kit_definition` for **all SEs appearing in any candidate list**,
     replacing the per-ticket `ensureKitStatus` loop;
   - availability: already batched via `currentStatusMany` — call it **once** for the union of
     candidate SEs instead of per ticket.
3. **Batch the writes:** accumulate recommendation rows in the loop; flush with
   `prisma.recommendation.createMany({ data })` once at the end (order is preserved by
   `processingRank`, which is already stamped). If R6's run-scoping lands first, stamp
   `runId` here too.
4. **Batch the component-block bookkeeping:** collect `resolveComponentBlock` ticket IDs and
   issue one `updateMany({ where: { ticketId: { in }, resolvedAt: null }, data: { resolvedAt: now } })`;
   collect `recordComponentBlock` rows and `createMany` them.
5. The in-loop logic (hard filters, planner soft bias, cluster seed/multiplier, capacity
   counting via the `assigned` map) stays exactly as is — it is order-dependent and cheap.

Result: a zone run = ~8 queries + 2 batched writes, independent of ticket count.

### Acceptance criteria
- Query-count test: `runForZone` with 200 tickets across 20 plants issues < 15 queries
  (Prisma `$on('query')` counter).
- All existing recommender tests pass unchanged (behavior parity: same recommendations, same
  processingRank, same breakdowns).

---

## R6 (SHOULD-FIX) — Make batch dispatch transactional, idempotent, and indexed

### Problem
`BatchAssignmentService.dispatchForZone` (`src/scheduling/batch-assignment.service.ts:40-118`):
1. Reads **all-time** `status='SUGGESTED'` recommendations. Recommendations are append-only and
   never marked consumed; nothing scopes them to today's run. The only guard against
   double-dispatch is the raw-SQL partial unique on `batch_assignment_tickets`
   (`(ticket_id) WHERE removed_at IS NULL`), which surfaces as an **unhandled P2002 mid-loop**.
2. Dozens of sequential `create`/`update` calls with **no transaction** — a crash leaves
   half-dispatched schedules and tickets flipped `FORMALLY_ASSIGNED` with no batch.
3. `recommendations` has only `@@index([ticketId])` / `@@index([seId])`
   (`prisma/schema.prisma:313-314`) — the `status='SUGGESTED'` filter is a seq scan over a
   forever-growing table.

### Target design

1. **Introduce a recommendation run scope (schema, additive migration):**
   - New table `recommendation_runs`:
     `run_id bigserial PK, zone_id bigint, run_date date, mode text, created_at timestamptz`
   - `recommendations.run_id bigint NULL REFERENCES recommendation_runs` (nullable for
     historical rows), stamped by `RecommenderService` (which creates the run row first and
     returns `runId` in `RunSummary`).
   - This preserves the append-only explainability posture (ADR-0003/0017): rows are still
     never updated; "which run" becomes a first-class dimension instead of an implicit
     "everything still SUGGESTED".
2. **Dispatch consumes a specific run:** `dispatchForZone(zoneId, { runId, dateFrom, dateTo })`.
   The read becomes
   `findMany({ where: { runId, status: 'SUGGESTED', seId: { not: null }, ticket: { assignmentState: 'UNASSIGNED' } } })`
   — the `assignmentState` predicate is the semantic idempotency filter: a ticket already
   dispatched (by a prior partial run, an intraday accept, or a ZM manual assign) is skipped
   instead of exploding on the partial unique. The partial unique remains the DB backstop.
3. **Transaction per SE schedule:** wrap each SE's `workSchedule.create` + its batches +
   ticket rows + `ticket.update` flips in one `prisma.$transaction` (interactive). Rationale
   for per-SE rather than per-zone: bounded transaction size (an SE's day is ≤ dailyCapacity
   tickets), and one SE's failure doesn't roll back the whole zone. On P2002 inside an SE's
   transaction (lost race with intraday), catch, log, skip that ticket, continue — the ticket
   is legitimately taken.
   Batch the inner writes: `plantBatchAssignment.createMany` is not usable (need IDs), but
   `batchAssignmentTicket.createMany` per batch and one
   `ticket.updateMany({ where: { ticketId: { in } }, data: { assignmentState:'FORMALLY_ASSIGNED' } })`
   per schedule cut the round trips ~10×.
4. **Index (raw-SQL migration):**
   ```sql
   CREATE INDEX idx_recommendations_run_status ON recommendations (run_id, status);
   ```
   (Partial `WHERE status='SUGGESTED'` is unnecessary once run-scoped — runs are small.)
5. **Notifier stays outside the transaction** (it is a seam that may do I/O) — fire
   `dayPlanDispatched` after the SE's transaction commits, exactly as the current ordering
   already implies.
6. Update `morning-batch` job (R1) to pass the fresh `runId` from `runForZone` straight into
   `dispatchForZone` — recommend + dispatch become one flow per zone.

### Acceptance criteria
- Running dispatch twice for the same run creates zero additional schedules/batches (second
  run finds no `UNASSIGNED` tickets).
- Killing dispatch after SE #1 commits leaves SE #1 fully dispatched, SE #2 untouched
  (no orphan `FORMALLY_ASSIGNED` tickets) — assert by fault-injecting the notifier.
- `EXPLAIN` on the dispatch read uses `idx_recommendations_run_status`.

---

## R7 (SHOULD-FIX) — Close the intraday offer race windows

### Problem
`IntradayInsertionService` (`src/intraday/intraday-insertion.service.ts`) uses
check-then-act throughout:
- `accept` (:124-162) reads the row, validates `status`/`offeredSeId`, then updates — a
  concurrent `sweepTimeouts` (:224) can reroute the offer between read and write, yielding an
  SE "confirmed" onto a ticket that was simultaneously re-offered to someone else.
- `decline` and `reroute` (:362-409) do a JSON read-modify-write on `retryChain` with the same
  window (lost attempts in the chain).
- The schema has `version` optimistic-lock columns on `FailureCycle`/`Ticket`/`ComponentRequest`
  but `intraday_insertions` doesn't use one.

These are latent today only because the sweep is manual (R1 makes it a 1-minute timer running
concurrently with user taps — fix must land with or before R1's `intraday-sweep-timeouts`).

### Target design — status-conditioned writes (no schema change needed)

Convert every transition to a conditional `updateMany` and treat `count === 0` as lost-race:

1. **Accept:** replace the final `intradayInsertion.update` with
   ```ts
   const claimed = await tx.intradayInsertion.updateMany({
     where: { insertionId, status: 'PENDING_ACCEPTANCE', offeredSeId: seId },
     data: { status: 'ACCEPTED', respondedAt: now, ... },
   });
   if (claimed.count === 0) return { result: 'NOT_PENDING', status: refetched.status };
   ```
   **Ordering fix:** claim the insertion row *first*, then call
   `override.assignTicket(...)` inside the same interactive transaction; if assignTicket fails,
   the claim rolls back. (Today assignTicket commits *before* the status check-update, so a
   lost race leaves a formally-assigned ticket attached to a rerouted insertion.)
2. **Decline / sweep reroute:** the shared `reroute` performs its `update` as
   `updateMany({ where: { insertionId, status: 'PENDING_ACCEPTANCE', offeredSeId: ins.offeredSeId, retryCount: ins.retryCount } })`
   — the `retryCount` equality is the cheap optimistic lock that also serializes the
   `retryChain` append (chain is only written together with a `retryCount` bump or a terminal
   status). `count === 0` → someone else transitioned it; return without side effects
   (no ghost notification, no push).
3. **`manualAssign`:** same conditional pattern, `where: { insertionId, status: { in: ['PENDING_ACCEPTANCE','ESCALATION_REQUIRED'] } }`.
4. **Sweep query hint:** `sweepTimeouts` already filters
   `(status='PENDING_ACCEPTANCE', acceptanceDeadline <= now)` and the schema has
   `@@index([status, acceptanceDeadline])` — no index work needed; just re-fetch each row's
   current state via the conditional update rather than trusting the pre-read list.
5. Notifications/audit fire only after the conditional write succeeds (move the `pushOffer` /
   ghost notice after the `count === 1` check).

### Acceptance criteria
- Concurrency test: fire `accept` and `sweepTimeouts` for the same expired insertion
  concurrently (Promise.all in an integration test with a transaction barrier) — exactly one
  wins; the loser produces no notification and no ticket mutation.
- `retryChain` length always equals `retryCount` (+1 per terminal decline) under concurrent
  decline+sweep.

---

## R8 (SHOULD-FIX) — Untangle cross-module wiring (single instances, owned exports)

### Problem
Two anti-patterns:
1. **Constructor-default instantiation:** `RecommenderService`
   (`src/recommender/recommender.service.ts:70-74`) defaults
   `inventory = new InventoryService(prisma)`, `availability = new SeAvailabilityService(prisma)`,
   `softInactive = new SoftInactiveCountService(prisma)`; `IntradayInsertionService` (:88-89)
   defaults `new SeAvailabilityService(prisma)` and `new AuditService(prisma)`. This bypasses
   Nest DI, hard-couples concrete classes, and silently forks instances.
2. **Foreign services re-provided:** `RecommenderModule` lists `InventoryService`,
   `SeAvailabilityService`, `SoftInactiveCountService` in its own `providers` instead of
   importing `InventoryModule` / `EngineersModule` / `ReportsModule`; `IntradayModule`
   re-provides `SeAvailabilityService`. Result: multiple instances of "the same" service per
   process. Harmless while all services are stateless-over-Prisma; a bug factory the moment any
   gains a cache, queue producer, or connection.

Also: zero domain events — intraday reaches directly into scheduling (`OverrideService`),
recommender (`CandidateSelectionService`), engineers, notifications.

### Target design
1. **Delete every `= new X(prisma)` constructor default.** Tests that construct services
   directly must pass explicit fakes/instances (they already can — the parameters exist).
2. **Own-and-export:** each module exports its public services; consumers import the module:
   - `EngineersModule` exports `SeAvailabilityService`; `RecommenderModule` and
     `IntradayModule` import `EngineersModule` (remove their local providers).
   - `InventoryModule` exports `InventoryService`; `RecommenderModule` imports it.
   - `ReportsModule` exports `SoftInactiveCountService`; `RecommenderModule` imports it.
   - `AuditModule` already exports `AuditService` — inject it, don't `new` it.
   - Check for cycles: `ReportsModule` must not import `RecommenderModule` back (it doesn't
     today — `SoftInactiveCountService` only reads `device_states` + settings). If a cycle ever
     appears, split the shared read into a leaf module rather than `forwardRef`.
3. **Introduce one in-process domain event seam (deliberately minimal):**
   `src/common/events/` with `@nestjs/event-emitter` (or a 20-line typed emitter — no new infra):
   - `ticket.assigned { ticketId, seId, source: 'BATCH'|'INTRADAY'|'MANUAL' }`
   - `ticket.closed { ticketId, outcome }`
   Emit from `OverrideService.assignTicket` and the verification close path. First consumers:
   notifications (decouples intraday → notifications for the confirmation push) and the
   future SystemEfficiency incremental counters. Do **not** convert the synchronous
   *decision* dependencies (intraday → OverrideService is a genuine same-transaction command,
   not an event) — events are for *reactions*, commands stay direct calls.
4. Add an architecture test (dependency-cruiser or a simple jest rule) asserting no file
   imports another module's `*.service` without that module appearing in its own module's
   `imports` — prevents regression.

### Acceptance criteria
- App boots with exactly one instance of each service (assert via a DI token identity test:
  resolve `SeAvailabilityService` from two consuming modules → same reference).
- No `new \w+Service\(` occurrences under `src/` outside tests.
- Existing behavior tests unchanged.

---

## R9 (NICE-TO-HAVE) — Tighten residual stringly-typed state and missing FKs

### Problem
In an otherwise enum-disciplined schema (`prisma/schema.prisma`):
- `Recommendation.status` is `String` (:305) with de-facto values `'SUGGESTED' | 'UNASSIGNABLE'`;
- `ComponentBlockedQueue.wmActionStatus` is `String` default `"PENDING"` (:870);
- `IntradayInsertion.insertionType` is `String` default `"SYSTEM_CRITICAL"` (:340);
- `SlaRuleConfig.scope` is free text (:257) with de-facto values `'bucket' | 'company_tier'`;
- `Ticket.assignedSeId` (:1604) has an index but **no FK/relation** to `engineer_master`,
  unlike every other SE reference;
- `Ticket` keeps accreting nullable work-type-specific columns guarded only by comments —
  acceptable single-table posture (ADR-0004) but the raw-SQL CHECKs have not grown with the
  columns.

### Target design (one additive migration + mechanical code updates)
1. New enums, mapped like the rest:
   ```prisma
   enum RecommendationStatus { SUGGESTED UNASSIGNABLE @@map("recommendation_status") }
   enum WmActionStatus { PENDING ACTIONED @@map("wm_action_status") }        // confirm actual value set from service code first
   enum IntradayInsertionType { SYSTEM_CRITICAL @@map("intraday_insertion_type") } // defined complete for future MANUAL type
   enum SlaRuleScope { BUCKET COMPANY_TIER @@map("sla_rule_scope") }
   ```
   Migration: `CREATE TYPE`, then
   `ALTER TABLE … ALTER COLUMN status TYPE recommendation_status USING status::recommendation_status;`
   (values already conform; run a pre-check `SELECT DISTINCT` in the migration to fail loudly if not).
   Note the project convention: enums are *defined complete up front* so later issues never
   `ALTER TYPE` — check CONTEXT/issue docs for planned future values before freezing each set
   (especially `wm_action_status` and Phase-2 component-request states).
2. FK: `Ticket.assignedSe EngineerMaster? @relation(fields:[assignedSeId], references:[engineerId])`
   + back-relation on `EngineerMaster`. Pre-check for orphans before adding the constraint.
3. Extend the tickets work-type CHECK (raw SQL, same migration) to cover the newer column
   families, e.g.:
   ```sql
   ALTER TABLE tickets ADD CONSTRAINT chk_install_columns
     CHECK (work_type = 'INSTALL' OR (install_trigger_source IS NULL AND install_batch_id IS NULL AND fitted_at IS NULL));
   ALTER TABLE tickets ADD CONSTRAINT chk_recovery_columns
     CHECK (work_type = 'RECOVERY' OR (collected_device_serial IS NULL AND unable_to_collect_reason IS NULL));
   ```
   (Derive the exact column lists from the Issue 33/34/36 comments in the schema.)
4. Update service literals to the generated enum types (TypeScript will find every site).

### Acceptance criteria
- `SELECT DISTINCT` on each converted column returns only enum members; inserts with a typo
  fail at the DB.
- No behavior change; full suite green.

---

## R10 (NICE-TO-HAVE) — Use the ingestion cursor for incremental reads

### Problem
`SnapshotRun.cursor` is written at `finishRun`
(`src/ingestion/snapshot-ingestion.worker.ts:98-102`, value = high-water `gps_datetime`) but
`run()` always starts `cursor = null` (:57) — every run full-scans the source. Tolerable while
the source is `ap_widgets.tb_vehiclemaster` (a *current-state master*, one row per device;
dedup makes re-reads no-op inserts) but wasteful over VPN at fleet scale and wrong the moment
the reader targets anything history-shaped.

### Target design
1. **Resume semantics in the worker:** at `run()` start, read the most recent
   `SUCCESS`-or-`PARTIAL` run's `cursor` and pass it as the initial cursor. Add
   `SnapshotRunOptions.fullScan?: boolean` to force a from-scratch drain.
2. **Cursor contract clarification in `source-reader.ts`:** document that the cursor is a
   *source watermark* (e.g. ISO max `gps_datetime` already produced by the worker), and that
   readers must treat it as "return rows with `gps_datetime > cursor`" — for the vehiclemaster
   reader that is `WHERE gpsdatetime > ?` (paged `ORDER BY gpsdatetime, deviceid LIMIT ?`),
   which also naturally bounds each poll to changed devices only.
   Edge case to encode in the real reader: **equal timestamps at the watermark boundary** —
   use a composite watermark `(gps_datetime, device_id)` encoded in the opaque cursor string to
   avoid skipping ties (keyset pagination), since `>` on timestamp alone can drop rows sharing
   the boundary timestamp.
3. **Reconciliation:** R1 schedules a weekly `fullScan: true` run (off-peak) as the safety net
   against source rows updated *backwards* (device clock fixes) that an incremental watermark
   would miss. Idempotent inserts make it free of duplicates.
4. **PARTIAL-run watermark correctness:** today `dataAsOf`/`cursor` is the max across
   *successful* chunks — a failed middle chunk with earlier timestamps could be skipped forever
   once resuming is on. Fix: when `status = 'PARTIAL'`, set `cursor` to the max `gps_datetime`
   of the *contiguous successful prefix* of chunks (track per-chunk max in `chunk_stats`), or
   simpler and acceptable: on PARTIAL, persist `cursor = null` so the next run rescans (cheap,
   given dedup). Choose the simpler rule; document it in the worker docstring.

### Acceptance criteria
- Second run after a SUCCESS run reads only rows newer than the watermark (assert via a spy
  reader receiving the prior cursor).
- A PARTIAL run never causes permanently-skipped rows (test: fail chunk 2 of 3, re-run, assert
  all rows present).
- Weekly full-scan job registered in R1's cadence table.

---

## Cross-cutting sequencing & dependency notes

```
R2 (crash-safe ingest) ──┐
R3 (partitions)          ├── land BEFORE real AutoPlant SourceReader wiring
R4 (incremental states)  ┘
R1 (scheduler) ── requires R2's reaper before enabling snapshot-ingest on a timer;
                  requires R7 before enabling intraday-sweep-timeouts on a timer.
R6 (dispatch) ── touches RecommenderService (runId stamping); do together with or after R5.
R5, R8, R9, R10 ── independent; R8 first among these reduces merge friction for R5/R6.
```

Also carried over from the review — **explicitly out of scope here but file as follow-ups**:
- `vehicle_device_mappings` history table (Device.currentVehicleId is denormalized with no
  fitment history; referenced as "lands with Issue 18" in the schema comment but never created).
- Retention/partitioning decision for `audit_logs` (R3 only reports size).
- `TicketCreationService` per-candidate `findFirst` repeat-detection is a bounded N+1 (only
  newly-inactive devices); batch it opportunistically if it appears in slow logs.
- Outcome-causality metrics for the ZM scorecard (already noted as follow-up in the schema doc).

### What was judged sound (do not "fix")
- Raw-SQL partial-unique invariants (one active failure cycle / one RUNNING run / one active
  batch per ticket) — keep this pattern.
- Idempotent ingest via `(device_id, gps_datetime)` UNIQUE + `ON CONFLICT DO NOTHING`.
- Append-only `recommendations` with full `score_breakdown` explainability (R6 adds run
  scoping; it does not make rows mutable).
- Denormalized `device_states` hot table; report reads from monthly/daily summary tables.
- Read-only query guard on the AutoPlant MySQL seam; lazy pool so unset config never blocks boot.
- Enum-first schema, timestamptz discipline, in-transaction audit rows.
