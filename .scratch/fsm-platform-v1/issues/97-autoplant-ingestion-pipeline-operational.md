# 97 — AutoPlant ingestion pipeline: continuous, recoverable, unattended operation

Status: done (code) / ready-for-human (runtime) — all 7 TDD slices landed & committed (`97-PROGRESS.md`
line 299, "ALL 7 SLICES DONE ✅ 2026-07-06"; reaper committed `3c6b460`; read-error/PARTIAL-cursor path
in `snapshot-ingestion.worker.ts:70-104,130`). Remaining is NOT code: (a) ops flips
`INGESTION_SCHEDULER_ENABLED=true` after zone ratification (B8); (b) runtime verification against the live
VPN source (§7) needs external access — HITL. The acting half stays gated on B7 (§11).
Type: engineering (tracer-bullet; one architecture-HITL point pre-decided by the 2026-07-05 review)
Depends on: 04 (snapshot path), 05 (device-state), 96 (master-sync core). Related: 65 (readiness seam).
Authority: [`docs/architecture/backend-engineering-review-2026-07-05.md`](../../../docs/architecture/backend-engineering-review-2026-07-05.md)
Part III §A (A1–A6) + §"Recommended execution order" steps 1, 2, 4, 5.

> **One issue, implemented incrementally.** Seven independently-mergeable TDD slices (§5). Every slice
> leaves `main` green and the system runnable. This issue completes the **ingestion half only**
> (AutoPlant → masters → snapshots → `device_states`, running by itself, safely, recoverably). The
> acting half (ticket creation → recommender → dispatch) is downstream of a business decision (empty
> `pgi_history`, review B7) and is **explicitly out of scope** (§11).

---

## 1. Problem Statement

**What exists.** The ingestion pipeline is functionally complete and verified against production data:

- `AutoPlantMysqlClient` — read-only MySQL seam (statement guard, `< 100`-row cap, `dateStrings`).
- `MasterSyncService.sync()` — plant-first org-graph upsert with structural anti-drift, single-in-flight
  guard (`master_sync_runs_one_in_flight`), and a data-driven zone-mapping queue.
- `SnapshotIngestionWorker.run()` — keyset drain of `tb_vehiclemaster`, per-chunk retry ×3, idempotent
  `ON CONFLICT DO NOTHING`, resume watermark.
- `DeviceStateService.recompute()` — full-fleet inactivity / SLA-bucket / eligibility derive + upsert.
- `IntegrationSyncService.runPipeline()` (`integration-sync.service.ts:41`) — chains the three stages,
  driven by `POST /api/integration/run-pipeline` (Ops-Head) or the CLI.
- `AutoPlantHealthService` + `GET /api/integration/health` — connectivity + master/snapshot freshness.

**What is missing (the reason it is not production-ready).** Everything runs *only when a human presses
the button*, and three failure modes make unattended operation unsafe:

1. **No scheduler.** There is no `@nestjs/schedule`, BullMQ, Redis, or cron anywhere in the dependency
   tree (verified: `apps/backend/package.json`). `device_states.computed_at` freezes at the last manual
   run — the dashboards silently go stale with no operator action. (Review A1.)
2. **Orphaned-`RUNNING` lockout.** A process death mid-run leaves a `RUNNING` row; the partial-unique
   index then rejects **every** future run with 409 until someone manually deletes the row. The CLI
   works around this for *snapshot* runs only (`autoplant-sync.ts:84`); master-sync has no equivalent.
   No reaper exists. (Review A2.)
3. **PARTIAL-run watermark data loss.** On a PARTIAL run the resume cursor advances to the high-water
   mark of *succeeded* chunks; a permanently-failed middle chunk's window falls behind the watermark
   forever, and its pings are never re-read. The loss is biased toward dying devices (their last-ever
   ping). (Review A3.)
4. **A VPN half-failure hangs instead of failing.** The mysql2 pool has no `connectTimeout` and queries
   have no per-statement timeout — a packet-blackholing VPN leaves `readChunk` pending indefinitely with
   the run stuck `RUNNING` (compounds #2). (Review A4.)
5. **Completeness is unprovable.** Skips are bare counters with the reason only in code comments
   (`master-sync.service.ts:108…209`); after `vehicles: {skipped: 3200}` there is no way to enumerate
   which rows or why, and the `< 100`-row cap makes ad-hoc investigation painful (Review A5). Nothing
   compares FSM row counts to AutoPlant counts, so "SUCCESS" can silently mirror a fraction of the fleet
   (Review A6).

The pipeline is a set of well-built mechanisms wrapped in single-in-flight guards *explicitly designed
for a scheduler that does not exist*. The gap between "excellent codebase" and "running product" for the
ingestion half is entirely operational: automation + recoverability + provable completeness.

---

## 2. Objective

Turn ingestion from a manually-triggered set of endpoints into a **self-running subsystem** that a
developer never has to babysit:

- It **runs on its own** on a fixed cadence (masters daily off-hours; telemetry + device-state on a
  short interval), with overlapping ticks degrading to a safe no-op.
- It **recovers by itself** from a crash or a dropped VPN — no orphaned row ever locks out future runs,
  and a hung connection fails fast rather than pinning the run open.
- It **loses no telemetry** at the PARTIAL edge — a failed chunk's window is re-read on the next run.
- It is **provably complete** — an operator can see, in the health endpoint, FSM-vs-AutoPlant row-count
  reconciliation and an itemised, per-reason account of every skipped master row.

"Complete ingestion pipeline" = **AutoPlant → masters → snapshots → `device_states` runs continuously,
recovers unattended, drops no pings, and reports its own completeness** — with read-only access and the
`< 100`-row cap preserved at every entry point, and **zero new business rules invented**.

---

## 3. Scope

### Included
- New dependency: **`@nestjs/schedule`** (in-process cron; the only new infrastructure). Recommended by
  the review over BullMQ — one process, no fan-out.
- `IntegrationSchedulerService` in `IngestionModule`: two cron jobs (masters daily; telemetry+recompute
  short-interval), env-gated, dormant when AutoPlant is unconfigured, overlap-safe.
- A shared **stale-run reaper** applied to **both** `master_sync_runs` and `snapshot_runs`.
- **PARTIAL-cursor lower-bound fix** in `SnapshotIngestionWorker`.
- **MySQL fail-fast**: pool `connectTimeout` + per-query timeout in `AutoPlantMysqlClient`.
- **Itemised skip accounting** for master-sync (per-reason counters + persisted rejected keys).
- **Reconciliation counts** (source-vs-FSM per entity) surfaced in `GET /api/integration/health`.
- An **overlap-safe telemetry tick** entry on `IntegrationSyncService` (snapshot + recompute, no master).

### Not included (scope fence)
- Chaining `TicketCreationService` / recommender / dispatch into the pipeline — gated on the eligibility
  business decision (review B7); §11.
- Any change to master-sync/snapshot/device-state **business logic**, scope vocabulary, zone map,
  eligibility rule, tier feed, districts, or geo. This issue automates and hardens *what already runs*.
- Performance rewrites (batched master upserts, set-based device-state) — deferred; the chosen cadence
  is conservative enough for current perf (§10, review A7).
- BullMQ / Redis / queue infrastructure — introduced only when a second worker process exists (review §11).

---

## 4. Dependency Analysis

| # | Dependency | Why it exists | Blocks impl? | Kind |
|---|---|---|---|---|
| D1 | `@nestjs/schedule` package | In-process cron for the scheduler slice | No — additive dep, feature-flag OFF by default | Technical |
| D2 | Existing single-in-flight guards (advisory lock + partial-unique `RUNNING`) on both run services | The scheduler relies on them so overlapping ticks 409 → skip; the reaper relies on the `status='RUNNING'` shape | No — already present | Architectural |
| D3 | `IntegrationSyncService.runPipeline()` / `syncMasters()` | The scheduler drives these; needs a new telemetry-only tick alongside them | No — extend, don't replace | Architectural |
| D4 | `AutoPlantMysqlClient.query()` sole choke point | Timeouts and reconciliation `COUNT(*)` reads both go through it (read-only guard + cap enforced there) | No | Technical |
| D5 | `AutoPlantHealthService` + `/api/integration/health` | Reconciliation + reaper-swept counts surface here — the operator's existing window | No — extend | Operational |
| D6 | mysql2 timeout semantics (`connectTimeout` on pool, `{sql,timeout}` per query) | Fail-fast on VPN half-failure | No | Technical |
| D7 | DBA `< 100`-row cap + read-only account | Every new source read (reconciliation `COUNT(*)`) must obey it | No — but constrains reconciliation to `COUNT(*)` (1 row) not row enumeration | Business/Operational |
| D8 | **Eligibility business decision** (empty `pgi_history`, review B7) | The *acting* half cannot process a row until this is decided | **Blocks the acting half only** — which is why it is Out of Scope here | Business |
| D9 | Scheduler-vs-queue architecture choice | Normally an architecture-HITL stop | **Pre-decided** by the 2026-07-05 principal-engineer review (in-process `@nestjs/schedule` now) — no fresh HITL needed; cadence values + prod ON/OFF are ops config | Architectural |
| D10 | New migration for `master_sync_rejects` (skip accounting) | Persist skipped natural keys the way `zone_mappings` persists zone values | No — additive table, no drift on existing data | Technical |

No dependency blocks the **ingestion** work. D8 blocks only the out-of-scope acting half; D9 is resolved
by the review.

---

## 5. TDD Implementation Plan

Seven slices, dependency-ordered (review order: A4 + A2 → A3 → A6/A5 → A1). Each is RED → GREEN →
REFACTOR, independently testable, independently mergeable, and leaves the system working.

### Slice 1 — MySQL fail-fast timeouts (review A4)
- **RED.** Test that `AutoPlantMysqlClient.query()` rejects within a bounded time when the underlying
  driver never resolves (inject a fake query that returns a never-settling promise); assert a
  timeout error, not a hang. Test that pool config carries `connectTimeout`.
- **GREEN.** Add `connectTimeout` to `getPool()` config; wrap `query()` in a per-statement timeout
  (mysql2 `{sql, timeout}` or a ~30s `Promise.race`). A timed-out read rejects → caller fails the run.
- **REFACTOR.** Extract the timeout constant to `readAutoPlantMysqlConfig()` (env-overridable), default 30s.
- *File:* `ingestion/autoplant/autoplant-mysql.client.ts`.

### Slice 2 — Stale-run reaper (review A2)
- **RED.** Seed a `RUNNING` `master_sync_runs` row with `started_at` older than N minutes; assert the
  next `startRun()` reaps it to `FAILED` (`error='orphaned (process restart)'`) and then succeeds
  rather than 409-ing. Same test for `snapshot_runs`. A *fresh* `RUNNING` row (younger than N) must
  still 409.
- **GREEN.** A shared reaper (helper or tiny service) that, inside `startRun()` **before** taking the
  lock, marks `RUNNING` rows older than `INGESTION_STALE_RUN_MIN` (default e.g. 30) as `FAILED`. Wire
  into `MasterSyncRunService.startRun()` and `SnapshotRunService.startRun()`.
- **REFACTOR.** De-duplicate the two call sites behind one reaper unit; delete the CLI snapshot-only
  `deleteMany({status:'RUNNING'})` workaround (`autoplant-sync.ts:84`) now that the reaper is durable.
- *Files:* `ingestion/autoplant/master-sync-run.service.ts`, `ingestion/snapshot-run.service.ts`.

### Slice 3 — PARTIAL-cursor lower-bound fix (review A3)
- **RED.** Drive the worker with a source whose middle chunk fails all retries and later chunks succeed;
  assert the persisted cursor equals the **`min(gpsDatetime)` lower bound of the first failed chunk**,
  not the succeeded high-water mark. Assert the next run re-reads that window (and `ON CONFLICT` makes
  the overlap free — no duplicate rows).
- **GREEN.** In `SnapshotIngestionWorker.run()`, track the first failed chunk's lower bound; on PARTIAL
  finish, persist `cursor` = that lower bound. SUCCESS behaviour unchanged; FAILED (`dataAsOf=null`)
  unchanged; the freshness banner stays SUCCESS-only.
- **REFACTOR.** Name the two cursor semantics explicitly (`resumeCursor` vs `dataAsOf`) so the
  optimistic-resume / conservative-display asymmetry is legible.
- *File:* `ingestion/snapshot-ingestion.worker.ts`.

### Slice 4 — Itemised skip accounting (review A5)
- **RED.** Run a master-sync over a fixture where vehicles are skipped for distinct reasons; assert
  `entity_stats` carries per-reason counters (`skippedOutOfScope` / `skippedNoPlant` /
  `skippedNoCompany` / `skippedNoDevice`) and that a `master_sync_rejects` row is written per skipped
  natural key (`run_id, entity, source_key, reason`).
- **GREEN.** Additive migration `master_sync_rejects`; split the counters at the existing skip sites
  (`master-sync.service.ts:108,113,140,184,209`); persist rejected keys (capped/batched to respect PG
  round-trip cost).
- **REFACTOR.** Fold reject-writing into one helper so each skip site is a single call.
- *Files:* `ingestion/autoplant/master-sync.service.ts` + `prisma/migrations/*`.

### Slice 5 — Reconciliation counts in health (review A6)
- **RED.** With a fake source exposing per-entity `COUNT(*)` under the sync filters, assert
  `GET /api/integration/health` returns `{ entity, sourceCount, fsmCount, drift }` per entity and a
  top-level `reconciled: boolean`. Assert each reconciliation query is a single-row `COUNT(*)`.
- **GREEN.** Add source-side `COUNT(*)` methods (same filters the sync uses — ACTIVE plants, DEPLOYED
  vehicles) to the master source; extend `AutoPlantHealthService` to diff against FSM counts and store
  on the run row / surface in health. Alert flag on drift beyond a threshold.
- **REFACTOR.** Reuse the source's existing filter fragments so the reconciliation query can never
  diverge from the sync query.
- *Files:* `ingestion/autoplant/health.service.ts`, `autoplant-master-source.ts`.

### Slice 6 — Overlap-safe telemetry tick
- **RED.** Assert a new `IntegrationSyncService.ingestTelemetry()` runs snapshot + device-state (no
  master) and, when a run is already in flight, catches the 409 `RUN_IN_PROGRESS` and returns a
  `skipped` result instead of throwing.
- **GREEN.** Add `ingestTelemetry()` (calls `snapshotWorker.run()` + `deviceState.recompute()`); wrap
  the 409 into `{ skipped: true }`. Leave `runPipeline()`/`syncMasters()` untouched.
- **REFACTOR.** Share the 409-swallow with `syncMasters` so both scheduled paths are uniformly
  overlap-safe.
- *File:* `ingestion/autoplant/integration-sync.service.ts`.

### Slice 7 — In-process scheduler (review A1)
- **RED.** With `@nestjs/schedule` test harness (manually invoke the cron handlers), assert: the
  masters handler calls `syncMasters`; the telemetry handler calls `ingestTelemetry`; when
  `INGESTION_SCHEDULER_ENABLED` is false **or** AutoPlant is unconfigured, both handlers no-op; an
  in-flight overlap logs a skip and does not throw.
- **GREEN.** `IntegrationSchedulerService` in `IngestionModule` with two `@Cron` handlers (masters
  cron = daily off-hours; telemetry cron = short interval, both env-configurable). Guard on
  `INGESTION_SCHEDULER_ENABLED` (default OFF) and `client.isConfigured()`.
- **REFACTOR.** Centralise cron expressions + enable flag in one config reader; document the two knobs.
- *Files:* new `ingestion/autoplant/integration-scheduler.service.ts`, `ingestion.module.ts`, `app.module.ts`
  (register `ScheduleModule.forRoot()`).

---

## 6. Test Strategy

Prove-before-done, per slice. (BE test DB = sibling `fsm_test`, migrated+seeded by global-setup.)

| Slice | Unit | Integration / e2e | Repository | Failure | Regression | E2E |
|---|---|---|---|---|---|---|
| 1 Timeouts | timeout wrapper rejects on a never-settling query; config carries `connectTimeout` | client rejects within bound against a stub pool | — | dropped-VPN sim → run fails cleanly (not hung), run row not left RUNNING | happy-path query unchanged; read-only guard + cap intact | pipeline still drains with real-shaped fixture |
| 2 Reaper | reaper marks old RUNNING → FAILED; leaves fresh RUNNING | `startRun()` after crash-orphan succeeds; both run tables | seeded orphan row reaped with correct `error` | fresh in-flight still 409; reaper idempotent | existing 409 concurrency e2e still passes | crash → restart → next scheduled run proceeds |
| 3 PARTIAL cursor | cursor = first-failed lower bound (pure) | worker with failing middle chunk persists lower-bound cursor; next run re-reads | `snapshot_runs.cursor` value asserted | all-failed run → FAILED, `dataAsOf` null, banner unmoved | SUCCESS-run cursor unchanged; `ON CONFLICT` dedup intact | two-run sequence: no ping lost, no duplicate rows |
| 4 Skip accounting | per-reason counter mapping (pure) | sync writes `master_sync_rejects` + split `entity_stats` | reject rows queryable by `(run_id, entity, reason)` | reject write failure doesn't fail the sync | idempotency e2e (no FSM-owned drift) still green | sync run → health/DB shows itemised skips |
| 5 Reconciliation | drift calc (pure) | health returns per-entity source-vs-FSM counts | counts read as single-row `COUNT(*)` | source unreachable → health degrades, no crash | `/health` freshness fields unchanged | run → `/health` shows `reconciled` + drift |
| 6 Telemetry tick | 409 → `{skipped:true}` mapping | tick runs snapshot+recompute, skips on overlap | `device_states` updated by tick | overlap 409 swallowed, not thrown | `runPipeline`/`syncMasters` behaviour unchanged | back-to-back ticks: second is a clean skip |
| 7 Scheduler | handlers dispatch to the right service; flag/unconfigured no-op | manual cron-handler invocation drives the pipeline | run rows created by scheduled tick | tick during in-flight run → logged skip | unconfigured env boots + scheduler dormant (no VPN) | enabled+configured → runs appear on cadence |

**Done bar for every slice:** new tests green; full backend e2e suite green (no regression); `tsc` +
build clean; read-only guard and `< 100`-row cap unviolated; migrations show no drift.

---

## 7. Runtime Verification

Each slice is verified against the running app, not just the test suite.

- **CLI.** `npm run autoplant:ping` (connectivity); `npm run autoplant:sync` / `autoplant:sync pipeline`
  (VPN + env). After Slice 2, kill the process mid-run and confirm the next CLI run proceeds (no manual
  row delete). After Slice 1, simulate a VPN drop and confirm the run fails within the timeout.
- **REST.** `POST /api/integration/sync-masters`, `POST /api/integration/run-pipeline?chunkSize=90`,
  `POST /api/snapshots/run` (all Ops-Head). Confirm 409 on overlap; 503 when unconfigured.
- **Database.** `psql` on PG16/5433: `SELECT status,started_at,finished_at FROM master_sync_runs ORDER BY run_id DESC LIMIT 5;`
  (no stuck RUNNING after a crash); `snapshot_runs.cursor` after a forced PARTIAL; `master_sync_rejects`
  row counts; `MAX(computed_at) FROM device_states` advances on cadence once the scheduler is on.
- **Health endpoint.** `GET /api/integration/health` — source connectivity, master/snapshot age-in-minutes,
  and (Slice 5) per-entity reconciliation + drift flag.
- **Dashboard.** Confirm the data-as-of banner advances after scheduled telemetry ticks and that zone/company
  inactivity numbers move with real data (visual-parity harness: log in as Ops-Head).
- **Production-safe.** All verification reads obey read-only + `< 100`-row cap; reconciliation is
  `COUNT(*)` (1 row); no query enumerates > 90 source rows/page.

---

## 8. Production Safety

Every slice preserves, and is tested against, these invariants:

- **Read-only AutoPlant access** — the `query()` first-token guard (SELECT/SHOW/DESCRIBE/…) is untouched;
  reconciliation adds only `COUNT(*)` reads.
- **`< 100`-row cap** — page size stays clamped 1..99; reconciliation returns a single count row.
- **Idempotency** — snapshot `ON CONFLICT DO NOTHING` and master `source_*_id` upserts are unchanged; a
  re-run (manual or scheduled) is a no-op on all FSM-owned data (asserted by the existing idempotency e2e).
- **Resume capability** — the watermark cursor is preserved; Slice 3 *strengthens* it (no PARTIAL skip).
- **Retry behaviour** — per-chunk ×3 backoff is unchanged; Slice 1 adds fail-fast so a hung read becomes a
  clean run failure the next tick retries.
- **Recovery after interruption** — Slice 2's reaper guarantees a crash never permanently locks out runs.
- **Concurrency safety** — the advisory lock + partial-unique `RUNNING` guards remain the serialization
  mechanism; the scheduler *relies* on them (overlap → 409 → skip), never bypasses them.
- **Data-ownership boundaries** — structural anti-drift (FSM-owned `zone_id`/`deal_type`/tier/rank excluded
  from every update) is unchanged; no slice writes an AutoPlant-owned or FSM-owned column it does not own.

---

## 9. Acceptance Criteria

1. `@nestjs/schedule` is the only new runtime dependency; no Redis/BullMQ/ioredis appears in
   `apps/backend/package.json`.
2. With `INGESTION_SCHEDULER_ENABLED=true` and AutoPlant configured, `device_states.computed_at` advances
   automatically on the telemetry cadence and `master_sync_runs` gains a SUCCESS row on the daily cadence —
   with no human trigger — verified over ≥ 2 consecutive cycles.
3. With the flag false **or** AutoPlant unconfigured, the app boots and the scheduler is dormant (no VPN
   required for dev/test/CI) — verified by the existing unset-env boot path staying green.
4. A process killed mid-run leaves no permanent lockout: the next `startRun()` (either run table) reaps the
   orphaned `RUNNING` row to `FAILED` and proceeds; a genuinely in-flight run still 409s.
5. A forced PARTIAL run persists the resume cursor at the first-failed-chunk lower bound; a subsequent run
   re-reads that window and inserts the previously-missing pings with **zero** duplicate rows.
6. A VPN half-failure causes the run to fail within `AUTOPLANT_QUERY_TIMEOUT_MS` (default ≤ 30s) instead of
   hanging; the run row does not remain `RUNNING` (reaper + timeout together).
7. After a master-sync, `entity_stats` carries per-reason skip counters and `master_sync_rejects` enumerates
   each skipped natural key with a reason — an operator can list "which 3,200 and why" via a single indexed query.
8. `GET /api/integration/health` reports, per entity, `sourceCount`, `fsmCount`, and a `drift`/`reconciled`
   flag, each sourced from a single-row `COUNT(*)`.
9. Overlapping scheduled ticks never throw: an overlap logs a skip and returns `{skipped:true}`.
10. Full backend e2e suite green, `tsc` + build clean, migrations show no drift, read-only guard and
    `< 100`-row cap unviolated — at **every** slice's merge, not just the last.

---

## 10. Risks

| Kind | Risk | Mitigation |
|---|---|---|
| Technical | Reaper races a genuinely-slow-but-alive run and reaps it → duplicate concurrent run | `INGESTION_STALE_RUN_MIN` set well above the worst observed run time (e.g. 30 min ≫ minutes-scale runs); reaper runs *before* the lock, and the advisory lock + partial-unique still serialise a real overlap |
| Technical | Per-statement timeout too tight → healthy long queries fail | Default 30s, env-overridable; timeout applies to `< 100`-row reads which are sub-second in practice |
| Operational | Scheduler turned on before zones are ratified / eligibility decided → dashboards run continuously on UNZONED/zero-ticket data | Ingestion→`device_states` is correct regardless; the acting half stays off (out of scope). Flag defaults OFF; enabling is an ops step after review B8/B7 |
| Operational | Reconciliation drift alarms are noisy while zone-mapping queue is being drained | Drift is informational (a flag + counts), not a hard failure; threshold configurable |
| Performance | Device-state recompute (~18k sequential upserts, "≈ minutes") on a short cadence could overrun the interval | Choose a conservative telemetry cadence (e.g. 30 min) comfortably above run time; set-based rewrite (review A7) is a **deferred** follow-up with a clear trigger (tighter cadence / p95 pain), not this issue |
| Business | Temptation to chain ticket creation to "finish" the pipeline | Explicitly fenced (§11): the empty-`pgi_history` eligibility decision (review B7) is owned by Ops-Head/SAP and must not be invented in code |

---

## 11. Out of Scope (future issues)

- **Ticket-creation chaining + recommender/dispatch activation** — gated on the eligibility business
  decision (review B7, empty `pgi_history`); `TicketCreationService.createForInactiveEligible` has no
  caller today by construction. A separate issue behind the B7 decision.
- **Eligibility source / mode** (build SAP-PGI feed | bulk-seed | `pgi | all-deployed` mode setting) — business decision.
- **Zone-map ratification + pending-queue drain + reapply** (review B1/B8) — Ops workflow, already built.
- **Company tier/rank feed** (review B6/R13), **districts** (B4), **plant geo** (B5) — reference-data / business feeds.
- **Production authentication** (Issue 91) — separate HITL slice.
- **BullMQ / Redis** and any queue infrastructure — only when a second worker process exists.
- **Large-scale performance optimisation** — batched master upserts, set-based device-state recompute,
  delta reads (review A7); each has its own trigger point.
- **Scheduler enhancements beyond the minimum** — dynamic cadence, backpressure, distributed locking,
  per-zone scheduling, retry queues.
- **Caching / materialized views** — `mv_zone_dashboard_rollup` + Redis (review §8/§11).
- **Mobile integration**, **business-rule changes**, **partition child-table creation** (review A7) — all out.

---

*Slice merge order = §5 order. Each slice is a standalone PR; the system runs at every step.*
