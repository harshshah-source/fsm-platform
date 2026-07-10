# Backend Engineering Review — Architecture, Ingestion Walkthrough & Gap Analysis

> ✅ **EXECUTED (marked 2026-07-10 by the SYSTEM-STATE audit).** Part III A1–A6 all landed as
> Issue #97 slices (see INDEX.md #97 entry). B7 (eligibility) shipped as #112's switch; B8 (zone
> ratification) remains an ops gate. Historical record — do not re-derive work from it.

**Date:** 2026-07-05
**Branch reviewed:** `feat/autoplant-integration` (HEAD `b45d00b`)
**Scope:** principal-engineer review of the NestJS backend, Prisma schema, AutoPlant integration,
ingestion pipeline, runtime behavior, and dashboards. The implementation — not the documentation —
was treated as the source of truth. Known facts supplied externally: production MySQL connectivity
works (`10.0.0.25` over VPN), all production queries are read-only and capped **< 100 rows/query**
(DBA requirement), Master Sync has successfully imported production master data into PostgreSQL,
and the React admin dashboard is connected to the real backend.

---

# Part I — Architecture Assessment

## 1. Overall Backend Architecture

The backend (`apps/backend`) is a NestJS modular monolith over Postgres 16 + PostGIS via Prisma 7
(driver adapter `@prisma/adapter-pg`), with a single `AppModule` composing ~24 feature modules.
There is **no Redis, no BullMQ, and no `@nestjs/schedule` anywhere in the dependency tree** — the
CLAUDE.md description ("Redis/BullMQ, S3") is aspiration, not implementation. Every asynchronous
behavior in the system is a synchronous, manually-triggered method.

| Layer | Modules | Role |
|---|---|---|
| **Integration** | `ingestion` (+ `ingestion/autoplant`) | AutoPlant MySQL read seams, master sync, snapshot ingestion, health surface |
| **Derived state** | `device-state` | `device_states` recompute (inactivity, SLA bucket, eligibility) |
| **Domain spine** | `ticketing`, `verification`, `recommender`, `scheduling`, `intraday`, `cross-zone`, `shared-pool`, `soft-state`, `planner` | Failure cycles, tickets, scoring, day plans, escalation |
| **Org & config** | `org`, `settings`, `auth`, `roles`, `audit` | Reference data, RBAC, zone crosswalk |
| **Operations** | `dashboard`, `reports`, `inventory`, `component-request`, `engineers`, `notifications`, `vouchers`, `devices` | Read models and workflow queues |

**Data movement (as actually wired):**

```
AutoPlant MySQL (10.0.0.25, VPN, read-only)
  ap_masters.mst_plant/mst_company/mst_transporter/mst_vehicle ──► AutoPlantMasterSource (keyset, ≤90 rows/query)
  ap_widgets.tb_vehiclemaster (+gpssignal JSON)               ──► AutoPlantSourceReader (keyset, IST→UTC)
                    │
        IntegrationSyncService.runPipeline()   ← manual trigger only
                    │
  MasterSyncService ─► company_master / transporters / plants / vehicles / devices  (+ master_sync_runs)
  SnapshotIngestionWorker ─► raw_device_snapshots (+ snapshot_runs / snapshot_run_chunks)
  DeviceStateService.recompute() ─► device_states
                    │
  DashboardService (raw SQL over device_states ⋈ plants ⋈ zones ⋈ company_master)
                    │
  React admin (fetch + JWT, VITE_API_URL → /api)
```

Two critical runtime observations:

1. **The pipeline stops at `device_states`.** `IntegrationSyncService.runPipeline()` deliberately
   does not chain ticket creation. More importantly, `TicketCreationService.createForInactiveEligible`,
   `RecommenderService.runForZone`, and `BatchAssignmentService.dispatchForZone` **have no callers
   anywhere in production code** — no controller, no scheduler. Built, tested, and dormant.
2. **Auth is not production auth.** `auth/user-store.ts` is an in-memory dev seed
   (`zm.north@fsm.test` / `'correct-password'`, scrypt-hashed but hardcoded). The Postgres `users`
   table is an account registry only — a DB user cannot log in (tracked as Issue 91, HITL).

Production readiness by layer: integration + derived state + dashboards are **functionally
production-capable, operationally manual**. The domain spine is **code-complete but unactivated**.
Auth and scheduling are **not production-ready**.

## 2. Prisma Schema Review (ingestion-related models)

Schema: `prisma/schema.prisma` (2,037 lines, 58 models, 49 migrations, latest
`20260704120000_add_zone_mapping_layer`).

| Model (table) | Ownership | Written by | Read by | Key constraints / notes |
|---|---|---|---|---|
| `Company` (`company_master`) | **Hybrid** | MasterSync (mirror cols); Ops-Head `PATCH /org/companies` (tier/rank) | Recommender, TicketCreation, dashboards | `source_company_id` UNIQUE keys the upsert. AutoPlant-owned: `name`, `companyType`, `status`. FSM-owned: `companyTier`, `companyPriorityRank`, `opsOverride` — insert-only defaults `SILVER`/`'C'`, structurally excluded from re-sync updates. |
| `Plant` (`plants`) | **Hybrid** | MasterSync (mirror); `ZoneMappingService.reapply` (operational `zone_id`) | Everything zone-scoped | `source_plant_id` UNIQUE. AutoPlant-owned: `source_zone_*`, `source_region_*`, `plant_state/district`, `master_plant_*`, `status`. FSM-owned: `zone_id` (insert-only at sync; mutated only by reapply), `district_id`, PostGIS `location`. `zone_id` still NOT NULL — the nullable-zone migration was avoided by the UNZONED holding zone. |
| `Transporter` (`transporters`) | **AutoPlant mirror** | MasterSync | Vehicle FK, device-state denorm | `source_transporter_id` UNIQUE; `vehicles` FK wired in migration `20260703120000` after nulling dangling values. |
| `Vehicle` (`vehicles`) | **AutoPlant mirror** | MasterSync | TicketCreation, DeviceState denorm | Keyed by natural `vehicle_no` UNIQUE. `status` mirrors `deployment_status`. |
| `Device` (`devices`) | **Hybrid** | MasterSync (`deviceType`, `currentVehicleId`); Ops-Head (`dealType`) | DeviceState, TicketCreation, verification | `device_id` is a **String PK** (leading-zero IMEIs, alphanumeric vendor ids; migration `20260702130000` converted from BigInt). `dealType` absent from sync create *and* update. |
| `MasterSyncRun` (`master_sync_runs`) | FSM | MasterSyncRunService | Health surface | Advisory lock + partial-unique `RUNNING` guard. `entity_stats` jsonb per-entity inserted/updated/skipped. |
| `SnapshotRun` (`snapshot_runs`) | FSM | SnapshotRunService | Health, `GET /snapshots/latest`, resume cursor | `cursor` = last run's `data_as_of` ISO; `data_as_of` = high-water `gps_datetime` of succeeded chunks. Same dual in-flight guard. |
| `SnapshotRunChunk` (`snapshot_run_chunks`) | FSM | Worker | Ops telemetry | UNIQUE `(run_id, chunk_no)`; per-chunk retry count + error. |
| `RawDeviceSnapshot` (`raw_device_snapshots`) | FSM (telemetry archive) | SnapshotIngestionService only | DeviceStateService `groupBy` | RANGE-partitioned monthly by `gps_datetime` (raw SQL); UNIQUE `(device_id, gps_datetime)` + `ON CONFLICT DO NOTHING` = idempotent re-runs. **No FK to `devices`** — orphan telemetry legal by design; ordering (master before snapshot) handles R8. |
| `DeviceState` (`device_states`) | FSM (derived, hot) | DeviceStateService (full upsert); TicketCreation flips `has_open_failure_cycle` | Dashboards, TicketCreation, device list | One row per device; stored `sla_bucket`; denormalized vehicle/plant/company/transporter for a join-free hot path. |
| `ZoneMapping` / `PlantZoneOverride` | **FSM crosswalk** | Resolver auto-discovers PENDING rows during sync; admin maps/ignores/overrides via `/org/zone-mappings` | MappingTableZoneResolver, reapply | UNIQUE `(source_field, source_value_key)` on the normalized raw value; `seen_count`/`last_seen_at` triage the queue. |
| `Ticket` / `FailureCycle` / `TicketEvent` | FSM | TicketCreationService + lifecycle services | Queues, dashboards, reports | 1:1 ticket↔cycle; partial-unique "one active cycle per device" (invariant I1) as raw SQL; full status enum defined up-front. |
| `Recommendation` | FSM | RecommenderService (append-only) | Batch dispatch, explainability UI | Never updated; corrections append. Mutable offer state lives in `IntradayInsertion`. |
| `PgiHistory` (`pgi_history`) | FSM (SAP proxy) | **Nobody** — seeded manually; SAP feed unbuilt | Eligibility gate | The quiet load-bearing table: no rows ⇒ no device is `eligible_for_uptime` ⇒ zero tickets. |

## 3. End-to-End Data Lifecycle (one production device)

| Stage | Implementation | Entry point | Validation status |
|---|---|---|---|
| **1. AutoPlant source** | `ap_masters.mst_plant/mst_vehicle`; `ap_widgets.tb_vehiclemaster.latest_gps_datetime` + `gpssignal` | — | ✅ Verified live; authoritative DESCRIBEs in `docs/autoplant/` |
| **2. Master Sync** | `AutoPlantMasterSource` (keyset ≤90/query, ACTIVE plants ∧ DEPLOYED vehicles) → `MasterSyncService.sync()` plant-first | `POST /api/integration/sync-masters` (OH) or `npm run autoplant:sync` | ✅ Verified against production. 30+ tests. Row-count reconciliation still unticked. |
| **3. Snapshot ingestion** | `AutoPlantSourceReader` keyset over `(latest_gps_datetime, device_id)`, resume `>=` watermark; IST→UTC; worker chunks + retries ×3; `createMany(skipDuplicates)` | `POST /api/snapshots/run` (OH), `run-pipeline`, or CLI | Unit/e2e green; live-drain verification item still 🟡 in tracker |
| **4. Device state** | `DeviceStateService.recompute()` — groupBy max ping, per-device derive + upsert | chained in `run-pipeline` / CLI | e2e green; live populated. **Eligibility false fleet-wide (empty `pgi_history`).** |
| **5. Ticket creation** | `TicketCreationService` — one tx: cycle + ticket + event + flag flip | **NONE — no caller exists** | e2e green; **never executes at runtime. Production tickets: zero, by construction.** |
| **6–7. Recommendation / dispatch** | `RecommenderService.runForZone`, `BatchAssignmentService.dispatchForZone` | **NONE** | e2e green; dormant |
| **8. Dashboard APIs** | `DashboardService` raw SQL; `GET /snapshots/latest` banner; `GET /api/integration/health` | `GET /api/dashboard/*` | ✅ Live against real data |
| **9. React dashboard** | `apps/admin/src/api/*.ts` — plain `fetch` + Bearer token; no mock layer in the app | Vite SPA | ✅ Connected; 150+ component tests |

Today's verified end-to-end path is **AutoPlant → masters → snapshots → device_states → inactivity
dashboards**. The ticket/recommendation half has never processed a production row — (a) nothing
invokes it, (b) the eligibility gate's PGI input is empty.

## 4. Runtime Execution — complete trigger inventory

**Everything is manual.**

| Subsystem | Trigger | Auth |
|---|---|---|
| Full pipeline (master→snapshot→device-state) | `POST /api/integration/run-pipeline?chunkSize=` (503 if unconfigured) | OPERATIONS_HEAD |
| Masters only | `POST /api/integration/sync-masters` | OPERATIONS_HEAD |
| Snapshot drain only | `POST /api/snapshots/run` (chunk clamped ≤99) | OPERATIONS_HEAD |
| CLI (no server needed) | `npm run autoplant:sync` / `autoplant:sync pipeline` / `autoplant:ping` | env + VPN |
| Zone re-apply | `POST /api/org/zone-mappings/reapply` | Ops-Head (audited) |
| Ticket creation | **nothing** | — |
| Recommender / batch dispatch | **nothing** | — |
| Intra-day insertion / timeout sweep | `POST /api/intraday-insertions/fire`, `/sweep-timeouts` (manual) | managers |
| Cross-zone Platinum sweep | `POST /api/cross-zone/sweep` (manual) | managers |
| Report aggregations | per-report OH `recompute` endpoints ("cron deferred" on every one) | OPERATIONS_HEAD |
| Integration health | `GET /api/integration/health` | OPERATIONS_HEAD |

Concurrency safety is done properly (advisory lock + partial-unique `RUNNING` ⇒ 409). The system
degrades gracefully without AutoPlant (unset env ⇒ mock sources bind; sync endpoints 503).
The scheduler is a parked architecture-HITL decision (issue 96 / tracker Phase 7 / R10).

## 5. Master Sync Review (summary — code detail in Part II)

- **Plant-first derivation** (commit `b45d00b`): `mst_plant` is authoritative (NOT NULL `company_id`);
  `mst_company.company_type` is dirty (real customers typed `'NA'`); `mst_vehicle.company_id` is 0.
  Scope = ACTIVE plants; companies **derived** (created only when an in-scope plant references them);
  the R14 company allow-list dissolved.
- **Anti-drift (R4) is structural**: every `update` set in `master-mapping.ts` omits
  `companyTier`/`companyPriorityRank`/`opsOverride`, `zoneId`/`districtId`, `dealType`. Asserted by
  idempotency e2e.
- **Weaknesses:** ~2 Postgres round trips per row (findUnique-for-stats + upsert), ~40k+ sequential
  queries/sync; **no absence handling** (rows leaving AutoPlant scope keep last-seen status forever);
  no transaction across the run (partial graph on crash — heals on idempotent rerun).

## 6. Snapshot Ingestion Review (summary — code detail in Part II)

- Keyset cursor over the mutable current-state `tb_vehiclemaster`; three cursor modes (cold,
  cross-run watermark `>=`, intra-run composite `>`); cursor advances from last *scanned* row.
- Idempotent via UNIQUE `(device_id, gps_datetime)` + `ON CONFLICT DO NOTHING`.
- Per-chunk retry ×3, exponential backoff; failed chunk doesn't abort the run.
- **Risk 1 — PARTIAL-run data loss:** `data_as_of` advances past a permanently-failed chunk;
  `lastResumeCursor` accepts PARTIAL ⇒ that chunk's pings are skipped until those devices ping again.
  Loss biased toward dying devices.
- **Risk 2 — sampled history:** the source keeps only the latest ping per device, so
  `raw_device_snapshots` is history at *poll cadence*, not a GPS trail. Fine for inactivity detection.

## 7. Device State Review (summary — code detail in Part II)

Full-fleet recompute: groupBy latest ping → per-device inactivity/threshold/bucket/eligibility →
sequential upserts (N+1, ~18k round trips). `has_open_failure_cycle` correctly excluded from the
update (owned by TicketCreation). Eligibility = PGI ≤15d ∧ no active Non-Op — **false fleet-wide in
production** (empty `pgi_history`).

## 8. Dashboard Review

Real endpoints, raw parameterized SQL over `device_states`; ZM zone-scoped server-side from JWT
claims; MV + Redis deferred deliberately. No mock paths in the running app (mocks are vitest-only).
Critical queue and most Action-Required cards are structurally empty (no tickets exist). UNZONED
appears as a normal zone row. Freshness: banner advances only on SUCCESS runs (conservative), while
ingestion resumes on SUCCESS or PARTIAL (optimistic) — a deliberate asymmetry.

## 9. Data Ownership

| Entity | Owner | Rationale |
|---|---|---|
| Company | Shared | Identity mirrored (when referenced by in-scope plant); tier/rank/opsOverride FSM/CRM-owned, insert-only |
| Plant | Shared | Org hierarchy AutoPlant-authoritative (refreshes each sync); operational `zone_id` FSM-owned (reapply only) |
| Vehicle | AutoPlant | Fully mirrored; FSM adds nothing |
| Device | Shared | Identity + fitment AutoPlant; `deal_type` FSM (Ops-Head tag) |
| Zone | FSM | Pure FSM operational construct; AutoPlant zone mirrored only as `source_zone_*` audit columns |
| Service Engineer / Coverage / Territory | FSM | No AutoPlant linkage at all |
| Priority / Tier | FSM | Columns + `priority_rule_config`; truth is CRM/Ops (R13 unresolved) |
| SLA | FSM | `sla_rule_config` + shared band classifier (`@fsm/shared`) |
| Recommendations / Tickets | FSM | Derived/workflow state; AutoPlant never sees them |

## 10. Architecture Evaluation

**Strengths:** real ports/seams with prod+test bindings and unset-env⇒mock rollback (R12);
structural anti-drift; idempotency everywhere it matters; defensive read-only posture (statement
guard + <100-row cap at every entry point); the data-driven zone-mapping layer (unblocked
production import without inventing business rules); evidence-driven source modeling (composite-PK
dedup, plant-derived company, `master_plant_*` disambiguation).

**Weaknesses / debt:** ~70% of the backend executes only in tests (dormant spine — first real run
risk); no scheduler = no product; eligibility gate has no data source (R2); sequential-loop I/O in
MasterSync and DeviceState; in-memory auth (#91); absence/staleness rot in masters; stale tracker
doc; scale ceiling ~10× current fleet before MV/set-based rewrites are needed.

## 11. Remaining Work (dependency-ordered)

**Architecture:** (1) Scheduler (R10) — recommend in-process `@nestjs/schedule` now, queue infra
only when a second process exists. (2) Eligibility interim rule (R2) — business decision.

**Implementation:** (3) chain ticket creation behind the eligibility decision; (4) production auth
(#91); (5) PARTIAL-cursor fix + MySQL statement timeouts; (6) recommender/dispatch activation
(needs real SE/coverage data — an Ops exercise); (7) master-sync absence handling + batching.

**Operational:** (8) zone-mapping working session (map → ignore → override → **reapply**);
(9) row-count reconciliation + failure injection + freshness alerting; (10) retire Book dataset,
update stale tracker.

**Business:** (11) R13 tier/rank feed; (12) notification adapters (#76), SAP/PGI, mobile.

**Do not build yet:** BullMQ/Redis, dashboard MVs + caching, delta reads, DeviceState set-based
rewrite — all scale responses to load that doesn't exist, each with a clear trigger point.

## 12. Final Assessment

As a *system of record with live fleet visibility*: close to production-ready. As a *field-service
operations platform*: not yet — the acting half has never executed outside tests and cannot until a
scheduler, an eligibility source, and real auth exist. The ingestion pipeline is the strongest part
of the codebase; residual hardening is the PARTIAL-cursor edge, timeouts, absence handling, and
automation. Highest risks in order: R2 (empty `pgi_history` ⇒ zero tickets), no scheduler,
dormant-spine first-contact risk, in-memory auth, PARTIAL watermark loss. The gap between
"excellent codebase" and "running product" is almost entirely operational: activation, automation,
and three named business decisions (zones, eligibility, scope vocabulary).

---

# Part II — Ingestion Pipeline: Code-Level Walkthrough

Follows one execution of `IntegrationSyncService.runPipeline()` (`POST /api/integration/run-pipeline`)
through every layer, in call order. Paths relative to `apps/backend/src/`.

## Stage 0 — `AutoPlantMysqlClient`: the connection seam

**File:** `ingestion/autoplant/autoplant-mysql.client.ts`

The only class holding a MySQL connection; everything funnels through `query()`.

- **Config:** `readAutoPlantMysqlConfig()` reads env; production spans **two schemas on one host** —
  `ap_widgets` (telemetry, the pool's *default* schema) and `ap_masters` (never default; queries are
  backtick-qualified). Any missing var ⇒ `null` ⇒ DI factories in `ingestion.module.ts:82-118` bind
  empty/in-memory sources — dev/test/CI boot VPN-free. Also the rollback lever.
- **Pool:** created lazily on first query (`getPool()`); `connectionLimit: 4`;
  **`dateStrings: true`** — MySQL DATETIMEs arrive as raw wall-clock strings so the IST→UTC decision
  happens exactly once, in `normalize.ts`, under test.
- **Read-only guard** (`query()`, lines 100–110): first SQL token must be
  SELECT/SHOW/DESCRIBE/DESC/EXPLAIN or it throws before touching the pool — defence-in-depth on top
  of the DBA's read-only account. All params via mysql2 placeholders; only interpolations are the
  floored integer LIMIT and the backtick-quoted schema name.
- **Failure mode:** dropped VPN = rejected promise; no retry here (policy belongs to callers).
  `ping()` = `SELECT COUNT(*) FROM tb_vehiclemaster`, used by `/api/integration/health`.

## Stage 1 — Master Sync

Collaborators: `AutoPlantMasterSource` (MySQL reads) → `master-mapping.ts` (pure transforms) →
`MasterSyncService` (orchestration + writes) → `MasterSyncRunService` (bookkeeping + guard) +
`MappingTableZoneResolver` (the one business-gated field).

### 1a. Run guard — `MasterSyncRunService.startRun()` (`master-sync-run.service.ts:33`)

```
BEGIN;
  SELECT pg_try_advisory_xact_lock(hashtext('master_sync_run'));  -- false ⇒ throw 409
  INSERT INTO master_sync_runs (status) VALUES ('RUNNING');
COMMIT;
```

Two independent guards: the **non-blocking advisory lock** (second concurrent start gets 409
immediately; auto-releases at commit — serializes the *start* only) and the **partial unique index**
`master_sync_runs_one_in_flight ON (status) WHERE status='RUNNING'` (migration `20260703120000`) —
the durable cross-process backstop (`P2002` → same 409).

> **Caveat:** if the process dies mid-sync, the `RUNNING` row is orphaned and the index rejects
> every future run with 409 until manually cleared. **No stale-run reaper exists.** The CLI works
> around it for *snapshot* runs only (`autoplant-sync.ts:84` `deleteMany({status:'RUNNING'})`);
> master-sync has no equivalent anywhere.

### 1b. Source reads — `AutoPlantMasterSource` (`autoplant-master-source.ts`)

One generic pager, `pageAll()` (line 85) — the DBA-cap enforcement point. Per page:

```sql
SELECT <cols> FROM `ap_masters`.`<table>`
WHERE (<status filter>) AND <pk> > ?     -- cursor clause absent on page 1
ORDER BY <pk> LIMIT 90
```

Keyset on the PK (never OFFSET), page size clamped 1..99; termination = short page; all pages
concatenated **in memory** (~1k ACTIVE plants, ~18k DEPLOYED vehicles — fine).

Production facts encoded in the readers:

- **`readPlants()`:** `mst_plant` PK is *composite* `(plant_id, plant_code)` ⇒ `dedupBy` keeps first
  row per `plant_id`. Status filter pushed into SQL (~1k rows paged, not 27k).
- **`readVehicleMasters()`:** `mst_vehicle.company_id` is 0 in production — company resolved via
  the plant using a **GROUP-BY subquery** (a raw join would fan out per `plant_code`, inflating ~2×
  and making the company nondeterministic):

```sql
FROM `ap_masters`.`mst_vehicle` v
LEFT JOIN (SELECT plant_id, MIN(company_id) AS company_id
           FROM `ap_masters`.`mst_plant` GROUP BY plant_id) p
  ON p.plant_id = v.plant_id
WHERE v.deployment_status IN ('DEPLOYED')
ORDER BY v.vehicle_no LIMIT 90
```

- **`readCompanies()`/`readTransporters()`:** unfiltered full scans (companies must be complete
  because the derivation filter is FSM-side).

No retry at this layer; a failed page fails the sync (FAILED run). No snapshot isolation across the
four scans — downstream skip logic absorbs mid-scan inserts; next run picks them up.

### 1c. Pure mapping — `master-mapping.ts`

No I/O. Each `map*` returns `UpsertPlan {where, create, update}`; **anti-drift lives in the type
signatures** — `mapPlant`'s update type has no `zoneId`/`districtId`; `mapCompany`'s no
tier/rank; `mapDevice` omits `dealType` from create *and* update. Utilities: `cleanStr` collapses
`''`/`'NA'`/`'NULL'`; `toBigIntOrNull` also treats `0` as null (AutoPlant's "no id" sentinel).

### 1d. Orchestration — `MasterSyncService.sync()` (`master-sync.service.ts:86`)

```
startRun() → runId
1. readPlants(): per in-scope plant → zoneResolver.resolve() → findUnique + upsert
     → plantIdBySource;  collect company_id → neededCompanyIds
2. readCompanies(): skip unless in neededCompanyIds; upsert → companyIdBySource
3. readTransporters(): upsert (companyId best-effort) → transporterIdBySource
4. readVehicleMasters(): skip if plant/company didn't sync this run; upsert by vehicle_no → vehicleIdByNo
5. same rows again: mapDevice (null if no device_id OR vehicle unsynced) → upsert devices
finishRun(SUCCESS, stats)   — or catch → finishRun(FAILED, error) → rethrow
```

- **Plant-first derivation:** companies created *only* when an in-scope ACTIVE plant references
  them; no allow-list; `mst_company.company_type` never consulted.
- **findUnique-before-upsert** exists only to classify inserted-vs-updated for `entity_stats`;
  doubles the query count; racy only for the stat, not correctness.
- **No transaction spans the run** — crash leaves a partial graph, healed by idempotent rerun.
- **Device fitment protection:** device rows touched only when their vehicle synced this run —
  a scoping change can never null an existing fitment.
- **Cost:** 2 PG round trips × ~40k rows, sequential ⇒ minutes; don't schedule more than daily
  without batching.

### 1e. Zone resolution — `MappingTableZoneResolver.resolve()` (`mapping-table-zone-resolver.ts:62`)

Three-tier precedence, all data-driven: (1) `plant_zone_overrides` by `source_plant_id`;
(2) `zone_mappings` on `normalizeZoneKey(zone_name)` (trim/lowercase/strip "india"/"zone";
blank/`NA`/`null` → `__blank__`), honored only when `MAPPED`; (3) fallback: **upsert a PENDING
discovery row** (`seen_count+1`; update branch never touches `status`/`fsm_zone_id`, preserving
admin decisions) and return the seeded **UNZONED** zone — throws loudly if UNZONED isn't seeded.

Ownership rule: the resolver decides zone **only at first insert** (update excludes `zoneId`).
Mapping a value changes nothing until `POST /api/org/zone-mappings/reapply`
(`org/zone-mapping.service.ts:172`). *Sync discovers; reapply applies.* "I mapped it but the plant
is still UNZONED" ⇒ reapply wasn't run.

## Stage 2 — Snapshot ingestion

### 2a. Run open — `SnapshotRunService.startRun()` (`snapshot-run.service.ts:26`)

Same dual-guard pattern (advisory key `'snapshot_run'`, partial unique
`snapshot_runs_one_in_flight`, migration `20260619153000`). Same orphaned-RUNNING caveat.
`lastResumeCursor()` returns the `cursor` of the newest **SUCCESS or PARTIAL** run — written by
`finishRun` as `data_as_of.toISOString()`. (This "or PARTIAL" is where the data-loss edge lives.)

### 2b. The read — `AutoPlantSourceReader.readChunk()` (`autoplant-source-reader.ts:63`)

Cursor state machine, owned by the reader:

- **`null`** (run start): resolve `loadResumeCursor()`. No prior run ⇒ cold full backfill.
  Prior watermark (UTC ISO, no `|`) ⇒ shifted +330 min to IST wall-clock, predicate
  **`latest_gps_datetime >= ?`** (inclusive; boundary re-read is free via dedup).
- **`"wallclock|deviceId"`** (intra-run keyset): strict composite
  `(latest_gps_datetime > ? OR (latest_gps_datetime = ? AND device_id > ?))` — tie-safe.

```sql
SELECT device_id, latest_gps_datetime, latitude, longitude, speed,
       IGNITION_STATUS, DEVICE_TYPE, gpssignal
FROM tb_vehiclemaster
WHERE latest_gps_datetime IS NOT NULL AND device_id IS NOT NULL AND TRIM(device_id) <> ''
  [AND <cursor predicate>]
ORDER BY latest_gps_datetime, device_id
LIMIT <chunkSize>   -- 90 from every production entry point
```

Row-drop policy in `mapVehicleMasterRow` (`mapping.ts:99`): blank/`"NULL"` device_id; null
`latest_gps_datetime`; timestamp >24h (default skew) ahead of now after normalization (a bogus
future clock must not look freshly active). `parseGpssignal` tolerates object or JSON string and
normalizes `mainstatus` `"1"/"0"/"ON"/"OFF"` → 1/0. `normalizeGpsTimestamp` (`normalize.ts:25`):
parse naive components *as if UTC*, subtract the +330 offset.

**Cursor-advance subtlety:** `nextCursor` derives from the last row *scanned by SQL*, not the last
mapped row — a fully-junk chunk still advances (no re-read loop). Exhaustion = short page.

**Know your source:** `tb_vehiclemaster` is a *current-state* table (one row per vehicle,
`latest_gps_datetime` updated in place). ⇒ (a) at most one ping per device per run —
`raw_device_snapshots` is history *sampled at run cadence*, not a GPS trail; (b) the table mutates
under the scan — mid-drain pings are re-read (deduped) or caught next run by the `>=` watermark.

### 2c. The loop — `SnapshotIngestionWorker.run()` (`snapshot-ingestion.worker.ts:50`)

```
startRun() → runId
loop:
  chunk = source.readChunk(cursor, chunkSize)
  if rows > 0:
      INSERT snapshot_run_chunks (runId, ++chunkNo, 'PENDING')
      outcome = processChunk(...)          ← retry lives here
      ok  → UPDATE chunk SUCCESS, retry_count=attempts-1;  dataAsOf = max(gpsDatetime)
      fail→ UPDATE chunk FAILED, error=lastError            (run continues!)
  cursor = chunk.nextCursor;  break when null
status = failed==0 ? SUCCESS : succeeded==0 ? FAILED : PARTIAL
finishRun({ status, dataAsOf: FAILED ? null : dataAsOf, cursor: dataAsOf?.toISOString() })
```

- **Retry** (`processChunk`): ≤3 attempts, backoff `200ms × 2^(n-1)`; retrying a half-inserted
  chunk is safe (idempotent write). Exhausted chunk ⇒ FAILED with last error; **run continues**.
- **Not retried:** `source.readChunk` itself — a VPN blip mid-loop throws out of `run()`, leaving
  the run row RUNNING/orphaned (same reaper gap).
- **The PARTIAL edge, precisely:** chunks are time-ordered. Chunk 5 (09:00–09:20) fails all
  attempts; chunks 6–10 (09:20–11:00) succeed ⇒ `dataAsOf`≈11:00 ⇒ run PARTIAL, cursor=11:00 ⇒ next
  run resumes `>= 11:00` ⇒ **chunk 5's pings are never re-read**. Self-healing for healthy devices
  (they ping again); permanent for a device whose 09:05 ping was its last — the loss is biased
  toward exactly the devices that matter. Fix: on PARTIAL, persist the cursor as the lower bound of
  the first failed chunk.
- `data_as_of` stays null on fully-FAILED runs so the freshness banner never advances on bad data.

### 2d. The write — `SnapshotIngestionService.ingestChunk()` + DDL

One statement per chunk: `createMany({ data, skipDuplicates: true })` →
`INSERT … ON CONFLICT DO NOTHING`; returned `count` excludes conflicts (a full re-run reports 0).

DDL (migration `20260619153000`, hand-written — Prisma can't express partitioning):

```sql
CREATE TABLE raw_device_snapshots (...)
  PRIMARY KEY (id, gps_datetime)              -- partition key must be in the PK
  PARTITION BY RANGE (gps_datetime);
CREATE TABLE raw_device_snapshots_default PARTITION OF raw_device_snapshots DEFAULT;
CREATE UNIQUE INDEX ... ON raw_device_snapshots (device_id, gps_datetime);   -- dedup key
CREATE INDEX ... ON raw_device_snapshots (device_id, gps_datetime DESC);     -- latest-ping hot path
```

Operational truth: **only the DEFAULT partition exists** — monthly children + archive are a
deferred slice, so "partitioned" buys future flexibility, not present pruning. `device_id` is TEXT
post-migration `20260702130000`. Deliberately **no FK to `devices`** — telemetry for an unknown
device is legal and inert until master sync creates the device row (why `runPipeline` orders master
before snapshot). Growth ceiling: ≤1 row/device/run; 18k devices × 96 runs/day ≈ 1.7M rows/day
worst case, realistically far less (only devices past the watermark are read).

## Stage 3 — `DeviceStateService.recompute()` (`device-state/device-state.service.ts:34`)

Four bulk reads: threshold setting (default 24h); `rawDeviceSnapshot.groupBy` max `gpsDatetime` per
device; latest PGI per device + active Non-Op set (eligibility inputs);
`device.findMany({ include: { currentVehicle } })` — **the devices table drives the loop** (orphan
telemetry ignored; a master device with no telemetry gets a null-ping row and stays in denominators).

Per device (pure): `inactivityHours = max(0, now − latestGps)` (clamped; DB CHECK backstops);
`isInactive = hours ≥ threshold`; `slaBucket = classifySlaBucket(hours)` (first-match over
`SLA_BANDS` from `@fsm/shared`, null under 4h ⇒ ACTIVE devices invisible to queues; band table
shared with the React app); `eligibleForUptime = isEligibleForUptime(...)`
(`eligibility.ts` — active Non-Op short-circuits false; else PGI ≤15d; **false fleet-wide in
production**); denorm vehicle/plant/company/transporter from `currentVehicle`.

Write: one `upsert` per device. `hasOpenFailureCycle` is **absent from the update object** — owned
by TicketCreation; recompute and ticketing interleave safely. Not transactional, not incremental:
~18k sequential upserts ≈ minutes; mid-crash leaves mixed `computedAt` (harmless — converges on
rerun). First thing to rewrite as a set-based `INSERT … SELECT … ON CONFLICT UPDATE` when a
15-minute cadence lands.

## Stage 4 — Dashboard read path (`dashboard/dashboard.service.ts`)

Raw parameterized SQL (`Prisma.sql`); ZM scoping is `AND z.zone_id = $n` appended only for
`ZONAL_MANAGER`, from the JWT claim.

**`zoneOverview` (line 121)** — two aggregates stitched in JS:

```sql
-- numerator: inactive devices per zone per bucket
SELECT z.zone_id, z.name, ds.sla_bucket, COUNT(*)
FROM device_states ds JOIN plants p ON p.plant_id = ds.plant_id
                      JOIN zones z  ON z.zone_id  = p.zone_id
WHERE ds.is_inactive AND ds.sla_bucket IS NOT NULL [AND z.zone_id = ?]
GROUP BY z.zone_id, z.name, ds.sla_bucket;
-- denominator: ALL devices per zone
SELECT z.zone_id, COUNT(*) FROM device_states ds JOIN plants ... JOIN zones ... GROUP BY z.zone_id;
```

Notes: join is on the denormalized `ds.plant_id` ⇒ **unfitted devices (null plant) drop out of both
numerator and denominator by design**. UNZONED surfaces as a normal zone row.
`trendPctVsPrevDay` hardcoded null (Issue-40 history exists but isn't wired here).
`(is_inactive, sla_bucket)` composite index serves the numerator.

**`companyPlantOverview` (line 167)** — same pattern at company×plant grain; `companyId`/`plantId`
filters regex-validated (`/^\d+$/`) before binding.

**`criticalQueue` (line 229)** — the one dashboard query reading `tickets`
(`work_type='TROUBLESHOOT' AND status='OPEN' AND ds.sla_bucket IN (CRITICAL…LONG_PENDING)`),
grouped in JS into per-(company, plant) cluster cards; `suggestedSes` empty until the recommender
activates. **Returns zero rows in production today** — not a query bug; no tickets exist. Don't
"debug" the empty critical queue.

**`actionRequired` (line 299)** — nine fixed cards; seven `available:false` stubs; two real
zone-scoped counts (WAITING_COMPONENT paused >7d; RECOVERY stalled 14d).

**Freshness:** `SnapshotQueryService.latest()` — `dataAsOf` from the newest **SUCCESS** run
(PARTIAL doesn't advance the banner; stricter than the resume cursor — resume optimistically,
display conservatively) + the newest run of any status for the red FAILED/stuck alert.
`GET /api/integration/health` (`health.service.ts:53`) adds source connectivity (live `ping()` when
configured) + master/snapshot age-in-minutes; works without the VPN.

All dashboard queries are per-request inline SQL — no MV, no cache. Sub-100ms at ≤18k
`device_states`; the deferred `mv_zone_dashboard_rollup` + Redis has a clear trigger (fleet ~10×,
p95 pain) and shouldn't be built earlier.

## Cross-cutting summary

| Property | Master sync | Snapshot ingest | Device state | Dashboards |
|---|---|---|---|---|
| **Transaction scope** | none (per-row upserts) | per-chunk `createMany`; run metadata separate | none (per-row upserts) | read-only |
| **Retry** | none — rerun whole sync | ×3/chunk, exp backoff; source reads not retried | none — rerun | n/a |
| **Idempotency key** | `source_*_id` / `vehicle_no` / `device_id` upserts | UNIQUE `(device_id, gps_datetime)` + `ON CONFLICT DO NOTHING` | PK upsert, pure recompute | n/a |
| **Concurrency guard** | advisory lock + partial-unique RUNNING | same | none (pipeline-serialized) | n/a |
| **Failure residue** | partial graph, heals on rerun; **orphaned RUNNING blocks future runs** | FAILED chunks logged; **PARTIAL advances watermark past failed chunks**; same orphan risk | mixed `computedAt`, converges | n/a |
| **Perf shape** | ~40k sequential PG round trips + ~650 MySQL pages | ~650 MySQL pages cold, incremental after | 3 aggregates + ~18k sequential upserts | 1–2 indexed aggregates/request |
| **First fix** | stale-RUNNING reaper; batch upserts | PARTIAL cursor = first-failed-chunk bound; timeouts | set-based rewrite before tight cadence | wire trend from Issue-40 history |

Engineering signature across all stages: correctness via **database constraints** (unique keys,
partial indexes, ON CONFLICT) rather than app-level checks; pure functions for every transform;
manual triggers wrapped in guards explicitly designed for the scheduler that doesn't exist yet.
The three sharp edges an on-call engineer will meet: orphaned-RUNNING lockout, PARTIAL watermark
skip, empty-by-construction ticket surfaces.

---

# Part III — Gap Analysis: What's Missing & the Un-Captured Master Parameters

## A. What's missing for ingestion to be "working"

("Working" = continuously running, trustworthy, recoverable without a developer.)
A1–A4 are the items not to go to production cadence without.

### A1. No scheduler — ingestion runs only when a human presses the button
No `@nestjs/schedule`, no BullMQ, no cron anywhere. `device_states.computed_at` freezes at the last
manual run. **Fix:** install `@nestjs/schedule`; one `IntegrationSchedulerService` in
`IngestionModule` — master sync daily (off-hours), `runPipeline` (or snapshot+recompute) every
15–30 min. Every stage already has single-in-flight guards and idempotent writes precisely so
overlapping ticks degrade to a 409 no-op — catch it and skip the tick. BullMQ is not needed: one
process, no fan-out. Recommendation: in-process cron now; queue infra only when a second worker
process exists.

### A2. Orphaned-`RUNNING` rows permanently lock out future runs
Process death mid-run orphans the `RUNNING` row; the partial-unique index rejects **every**
subsequent run with 409 until manual cleanup. The advisory lock died with the connection — the
durable index keeps rejecting. CLI workaround exists for snapshot runs only (`autoplant-sync.ts:84`).
**Fix:** a stale-run reaper — on module init (or inside `startRun` before taking the lock), mark
`RUNNING` rows older than N minutes `FAILED` with `error='orphaned (process restart)'`. ~20 lines +
test; ship in the same change as A1.

### A3. PARTIAL-run watermark can permanently skip a failed chunk's pings
`dataAsOf` = max over *succeeded* chunks, persisted as cursor even on PARTIAL;
`lastResumeCursor` accepts PARTIAL ⇒ a failed middle chunk's window falls behind the watermark
forever. Loss biased toward dying devices (their last-ever ping). **Fix:** on PARTIAL, persist the
cursor as the **lower bound of the first failed chunk** (`min(gpsDatetime)` of that chunk); the
`>=` resume + `ON CONFLICT DO NOTHING` makes the overlap free. Keep the banner behavior
(SUCCESS-only) as-is.

### A4. No MySQL timeouts — a VPN half-failure hangs the run instead of failing it
No `connectTimeout` on the pool, no per-statement timeout (tracker R3 "fail-fast ⬜"). A
packet-blackholing VPN leaves `readChunk` pending indefinitely with the run RUNNING (compounds A2).
**Fix:** pool `connectTimeout` + per-query timeout (mysql2 `{sql, timeout}` or a ~30s
`Promise.race` in `AutoPlantMysqlClient.query`); a timed-out read fails the run cleanly.

### A5. Skip accounting is counters, not records
`stats.<entity>.skipped++` with the reason only in code comments
(`master-sync.service.ts:108,113,140,184,209`). After `vehicles: {skipped: 3200}` there is **no way
to enumerate which 3,200 or why** — and the DBA 100-row cap makes ad-hoc investigation painful.
**Fix:** split counters by reason (`skippedOutOfScope` / `skippedNoPlant` / `skippedNoCompany` /
`skippedNoDevice`) in `entity_stats`; persist skipped natural keys — a tiny `master_sync_rejects`
table (`run_id, entity, source_key, reason`) or a capped JSON array on the run row. This is the
master-sync analogue of what `zone_mappings` already does for zone values.

### A6. Reconciliation is unbuilt — "sync succeeded" ≠ "sync is complete"
Nothing compares FSM counts to AutoPlant counts (tracker item ⬜). SUCCESS can silently mirror a
fraction of the fleet (e.g. unknown `deployment_status` values). **Fix:** extend
`AutoPlantHealthService` / the run finisher with source-side `COUNT(*)` per entity under the same
filters the sync uses (1 row each, within the cap) vs FSM counts; store on the run row, surface in
`/api/integration/health`, alert on drift.

### A7. Performance shapes that block cadence (not correctness)
- **Master sync:** ~2 PG round trips/row, ~40k+ sequential queries/sync. Fix: drop the
  pre-`findUnique`, batch with `createMany`/`ON CONFLICT` per entity.
- **Device-state recompute:** ~18k sequential upserts/run — the dominant cost at 15-min cadence.
  Fix: single set-based `INSERT … SELECT … ON CONFLICT (device_id) DO UPDATE`; keep the pure
  classifier as test oracle.
- **Partitions:** only DEFAULT exists — create monthly children before tens of millions of rows.

### A8. The pipeline ends one stage early
`runPipeline` stops at device-state; `TicketCreationService` has **no caller**. Chaining is a
5-line change + a manual OH endpoint; the real blocker is the eligibility input (B7).

## B. Un-captured master parameters — inventory and disposition

Key distinction: some are **admin workflow already built and waiting to be operated**, some are
**code changes**, some are **business decisions that must not be invented in code**.

### B1. Plants sitting in UNZONED — *operate the existing workflow*
Working as designed: `MappingTableZoneResolver` never guesses. Every distinct raw
`mst_plant.zone_name` is a `zone_mappings` row; PENDING ones landed their plants in UNZONED and are
the admin queue, ranked by `seen_count`.

**Runbook (all endpoints exist, Ops-Head role):**
1. `GET /api/org/zone-mappings/pending` — the queue, highest-impact first (CLI prints top 20 after
   every sync).
2. Per value: `POST /api/org/zone-mappings/:id/map {fsmZoneId}` for real names;
   `POST /:id/ignore` for junk (stays UNZONED, leaves the queue). The `__blank__` key aggregates
   every blank/`NA`/`null` plant — needs a policy decision (a "General" zone vs deliberate UNZONED
   exception pool).
3. Conflict plants a value-map can't express: `POST /api/org/plant-zone-overrides` pins the
   `source_plant_id` directly.
4. **Then — mandatory — `POST /api/org/zone-mappings/reapply`.** Master sync is insert-only on
   `plants.zone_id`; mapping moves *nothing* until reapply runs. (#1 future support question.)
5. Verify: UNZONED shrinks toward the ignored/blank residue; re-sync and confirm `seen_count`
   stops growing for mapped values.

**Code improvement:** add pending-mapping count + UNZONED plant count to
`/api/integration/health` so zone hygiene is visible where the operator already looks.

### B2. Plants not captured at all (status-skipped) — *scope decision, then config*
Skips at `master-sync.service.ts:107` = `mst_plant.status ∉ ['ACTIVE']` (~26k of ~27k). Follow-ups:
- **Confirm the status vocabulary** — one production query
  (`SELECT status, COUNT(*) FROM mst_plant GROUP BY status`, a handful of rows, within the cap).
  If other statuses matter, widen `MASTER_SYNC_SCOPE` in `ingestion.module.ts:72` — injected
  config, zero code change.
- **Absence ≠ deactivation:** a plant flipping ACTIVE→INACTIVE leaves the read filter, so its FSM
  mirror keeps `status='ACTIVE'` forever (same for vehicles leaving DEPLOYED). Fix without
  destructive deletes: stamp `last_seen_run_id`/`lastSeenAt` on every upsert (AutoPlant-side
  metadata — no anti-drift concern), then a post-sync sweep marks unseen rows `STALE` or dashboards
  filter on freshness. Until then denominators only grow.

### B3. Vehicles/devices skipped because their plant/company didn't sync
`stats.vehicles.skipped` = plant unresolved (INACTIVE plant, `plant_id=0` sentinel, dangling);
each drags its device. Disposition: the bulk resolves itself as B1/B2 widen coverage (keyed upserts
⇒ no backfill step); the `plant_id=0`/dangling residue is a **source data-quality queue for
AutoPlant's DB team** — which is why A5 (itemized skips) matters: today you can't hand them a list.
Devices skipped for "no device_id" are correct-by-design.

### B4. Districts and geography — *reference-data load + fuzzier matching*
`resolveDistrict` exact-matches (case-insensitive) `plant_district` against FSM `districts` — which
is seeded with a **3-state sample (~15 districts)**; the full ~700-district load is explicitly
deferred (`org-seed.ts:56`). So `plants.district_id` is null for nearly every synced plant —
Floating-SE hierarchical territory has nothing to resolve against. **Fix:** (1) load the
authoritative India district list; (2) expect AutoPlant spelling drift — reuse the crosswalk
pattern (`zone_mappings.source_field` was designed for this generalization); (3) backfill existing
plants via the reapply path.

### B5. Plant geo-coordinates — *never populated; verify the source has them*
`plants.location` (PostGIS) is written by nothing; the `mst_plant` SELECT requests no coordinates.
The `plant_eligible_floating_se` MV / polygon logic has no geometry. **Whether AutoPlant carries
plant lat/long is not established in the repo** — check `docs/autoplant/` DESCRIBEs first; if
present, mirroring is a two-line addition (AutoPlant-authoritative → both create and update); if
not, plant geocoding is an FSM data-acquisition task, not a sync feature.

### B6. Company tier / priority rank — *business feed, with an operable stopgap*
All synced companies sit at insert-only `SILVER`/`'C'` — safe but degenerate: canonical sort and
Platinum cross-zone auto-escalation treat the fleet identically. Truth is CRM/SAP (R13); must not
be invented. **Stopgap requiring no code:** `PATCH /api/org/companies/:id` (audited, Ops-Head)
already updates tier/rank — a one-time spreadsheet exercise over the ~dozens of derived companies.

### B7. `deal_type` and PGI — the two empty inputs gating the entire ticket spine
- `devices.deal_type`: deliberately absent from sync; Ops-Head tagging endpoint exists (Issue 49).
  Only Recovery auto-creation depends on it — low urgency.
- **`pgi_history` is the critical one.** `isEligibleForUptime` returns false when
  `latestPgiDate === null`; the table has no feed ⇒ `eligible_for_uptime=false` fleet-wide ⇒
  TicketCreation (even once wired per A8) selects zero candidates ⇒ the entire acting half stays
  dark. **The single highest-leverage unresolved item.** Three options: build the SAP/PGI feed
  (weeks); bulk-seed PGI for the known-active fleet (hours, honest declared interim); or an
  eligibility-mode setting (`pgi` | `all-deployed`) so the gate runs permissive until the feed
  exists (small code change, cleanest). **Decide explicitly — don't let the empty table keep
  making the decision implicitly.**

### B8. Zones themselves — confirm the operational partition is ratified
The four operational zones are a seed guess (`SEED_ZONES`, `org-seed.ts:13`);
`docs/autoplant/R6-zone-map-proposal.md` is still a proposal. Renames are cheap now
(`zone_mappings` points at `zone_id`, not names) and expensive after ZMs/coverage/audit rows
accumulate. Get the zone list signed off **before** the B1 mapping session.

## Recommended execution order

1. **A2 + A4** (reaper + timeouts) — prerequisites for unattended operation; trivial diffs.
2. **A3** (PARTIAL cursor) — small; closes the only data-loss edge.
3. **B8 → B1** (ratify zones, then drain the pending queue + reapply) — ZM dashboards become real;
   pure ops.
4. **A1** (in-process scheduler) — ingestion becomes a system rather than a button.
5. **A5 + A6** (itemized skips + reconciliation in health) — makes B2/B3 investigable; proves
   completeness with numbers.
6. **B7 decision + A8** (eligibility mode, chain ticket creation) — lights up the core loop.
7. **B4, B6, B2-staleness, A7** (districts, tier backfill, last-seen stamps, batching) — follow at
   leisure; none block the above.

**Through-line:** the codebase's discipline has been to build mechanisms and refuse to invent
values — so most of "what's missing" is not code but *operating* what's built (the mapping queue,
reapply, tier patching) plus three named decisions (zones, eligibility, scope vocabulary) that
belong to their owners, not to the sync.
