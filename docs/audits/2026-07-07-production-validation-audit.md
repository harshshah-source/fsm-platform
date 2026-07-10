# FSM Platform — Production Validation Audit

**Date:** 2026-07-07
**Scope:** Fresh-database, evidence-first end-to-end acceptance test of the AutoPlant → FSM pipeline against the live AutoPlant source over VPN.
**Method:** One complete pipeline executed and traced. Every conclusion is backed by a database query, an API response, or an application log captured during the run. Where something was not proven, it is stated explicitly.
**Reviewer roles:** Principal Software Architect · Principal Backend Engineer · Principal Data Engineer · QA Lead · SRE · Production Readiness Reviewer.

---

## Executive Summary

**The core AutoPlant → FSM pipeline works end-to-end and is architecturally sound.** One pipeline run ingested the live fleet cleanly in **438 seconds** with **zero foreign-key orphans, zero duplicate natural keys, and correct idempotency guards**. Master-sync, telemetry ingestion, device-state recompute, dashboards, RBAC scoping, and the schedulers all functioned.

**It is not yet production-ready as a product**, for three reasons that are mostly *not* code bugs:

1. Authentication is a hardcoded in-memory dev store.
2. Fleet-Uptime is structurally empty because the pipeline does not ingest PGI.
3. **83% of synced devices land in the UNZONED bucket** — a real operational consequence of the AutoPlant source data that qualifies the earlier "zone data is 98.7% clean" conclusion.

**Overall verdict: pipeline production-viable; product not yet.**

---

## Environment

| Item | Value |
|---|---|
| Database | PostgreSQL 16.14 + PostGIS, `fsm` role (non-superuser) |
| Session TimeZone | `Asia/Calcutta` (⚠️ not UTC — see Findings) |
| AutoPlant source | `ap_masters` (27,538 plants), `ap_widgets` (60,204 vehicles), reachable over VPN |
| Scheduler | `@nestjs/schedule` in-process cron (no Redis/BullMQ dependency) |
| Auth | In-memory dev user store (5 seeded roles, shared password) |

---

## Phase 0 — Clean Environment (baseline)

- Data-only reset of all **1,274 application tables** (`TRUNCATE ... RESTART IDENTITY CASCADE`). PostGIS and the Prisma migration ledger were preserved deliberately — the `fsm` role is not a superuser, so a full `prisma migrate reset` would drop PostGIS unrecoverably.
- All **52 migrations** confirmed applied (`migrate status`: up to date).
- Reference seed loaded successfully.

**Post-seed baseline (non-empty tables):**

| Table | Rows |
|---|---|
| zones | 5 (North, South, East, West, UNZONED) |
| zone_mappings | 4 (all MAPPED: west→West, north→North, south→South, east→East) |
| company_master | 3 |
| sla_rule_config | 3 |
| priority_rule_config | 7 |
| districts / regions | 14 / 6 |
| common_kit_definition / component_master | 4 / 4 |
| plants | 1 (seed placeholder) |
| raw_device_snapshots partitions | 1,215 |
| plant_eligible_floating_se (matview) | 0 (populated, empty) |

`system_settings` was empty at baseline (see note under device-state).

---

## Phase 1 — Infrastructure Verification

| Check | Result |
|---|---|
| Backend boot | ✅ clean ("Nest application successfully started"), after clearing a stale instance on port 3000 (see Findings) |
| AutoPlant connectivity (VPN) | ✅ `ap_widgets` 60,204 vehicles, `ap_masters` 27,538 plants |
| Prisma / DB connection | ✅ |
| Integration health endpoint | ✅ `source.connected=true, vehicleRows=60204` |
| Redis / BullMQ | N/A — not a dependency; schedulers are in-process cron |
| Auth | ✅ login works (in-memory store) |

---

## Phases 2–3 — Pipeline Execution & Stage Tracing

One pipeline via `POST /api/integration/run-pipeline`. **Total 438s.**

```
AutoPlant (live)
  ↓  master-sync        [83.4s]   plants 750 · companies 39 (+26 skip NO_INSCOPE_PLANT)
  │                                transporters 7,676 · vehicles 18,204 (1 skip PLANT_NOT_SYNCED)
  │                                devices 18,204 (1 skip VEHICLE_NOT_SYNCED)
  ↓  snapshot ingest    [353.2s]  601 chunks · 49,999 pings · SUCCESS
  ↓  device-state        —         18,204 device_states upserted
```

**Stage details:**

| Stage | Rows read/written | Skips (itemised) | Time | Idempotency |
|---|---|---|---|---|
| Master-sync | 750 plants, 39 companies, 7,676 transporters, 18,204 vehicles, 18,204 devices | companies 26 NO_INSCOPE_PLANT; vehicles 1 PLANT_NOT_SYNCED; devices 1 VEHICLE_NOT_SYNCED | 83.4s | insert-only zone_id; upsert by natural key |
| Snapshot ingest | 49,999 pings across 601 chunks | 63/54/48… device_ids "not yet in devices" → telemetry journalled, device_states deferred (graceful) | 353.2s | keyset by device_id; run guard |
| Device-state | 18,204 upserted | — | fast | set-based single pass |

- `49,999` is **organic, not a cap** — the reader paginates by `device_id` (LIMIT 90/chunk) and terminates on a short page.
- The "device_id not yet in devices" WARNs are **graceful degradation**, not errors — telemetry is journalled and device_states catch up once master-sync mirrors the device.

---

## Phase 4 — Database Validation

**Foreign-key integrity: PERFECT — 0 orphans across all relationships:**

| Relationship | Orphans |
|---|---|
| plants.zone_id → zones | 0 |
| vehicles.plant_id → plants | 0 |
| vehicles.company_id → company_master | 0 |
| devices.current_vehicle_id → vehicles | 0 |
| device_states.device_id → devices | 0 |

No duplicate natural keys (plants.source_plant_id, vehicles.vehicle_no, devices.device_id). No case-duplicate zones (`lower(name)` unique held).

**Table counts:** plants 751 · companies 42 · vehicles 18,204 · devices 18,204 · device_states 18,204 · raw_device_snapshots 58,279 · tickets 0.

**Zone distribution (plants vs devices):**

| Zone | Plants | Devices |
|---|---|---|
| West | 390 | 698 |
| UNZONED | 247 | **15,077** |
| South | 51 | 2,223 |
| North | 41 | 158 |
| East | 22 | 48 |

**Device-state distributions:**

- `is_inactive`: true 5,015 / false 13,189.
- `sla_bucket`: WARNING 11,460, LONG_PENDING 3,350, null 997, VERY_SEVERE 505, SEVERE 467, EARLY_RISK 418, CRITICAL 404, RISK 314, HIGH_CRITICAL 289.
- `eligible_for_uptime`: **false for all 18,204** (root cause: `pgi_history` = 0; eligibility requires a PGI within 15 days, and the pipeline does not ingest PGI).
- 995 devices have no telemetry match (null latest ping → null sla_bucket) — ~5.5%, a device_id mismatch between master and telemetry feeds.

**`devices.device_type` = NULL for all 18,204.** Deliberate: `autoplant-master-source.ts:198` hardcodes `NULL AS device_type` because the value lives on `ap_widgets.tb_vehiclemaster`, not `mst_vehicle`. Impact is limited — the recommender's device-bucket derives from `device_states.sla_bucket`, not this column — so only the device-list UI and the reports `deviceType` filter are affected.

---

## The Zone Finding (most significant result)

**83% of synced devices land in UNZONED**, and this qualifies the earlier "98.7% of plants have a usable zone" conclusion.

Evidence chain:
- **15,076 of 15,077 UNZONED devices** are on plants whose `source_zone_name` is NULL.
- The culprits are the **largest ACTIVE plants**: KESORAM WORKS (2,195 devices), RCP-9211 (1,762), NCP-9117 (1,446), CCP-9115 (1,141), the SATNA lines — all with **NULL `zone_name` AND NULL `plant_state`**.
- Source truth from `ap_masters.mst_plant` (27,210 distinct plants):
  - Full population: `West Zone` = 26,148 distinct plants (96%); `has_usable_zone` 26,635 vs `no_usable_zone` 575 (2.1%). **The 98.7% figure is correct at the full-population level — not a fan-out artifact.**
  - **But among ACTIVE plants** (the sync scope, `plantStatuses: ['ACTIVE']`), only **227** are "West Zone" while NA=357 and null/blank=207 dominate.
  - Weighted by vehicles: NA (442k) + null/blank (134k) overwhelm the real zones.

**Conclusion:** FSM's zone normalization is working **correctly** — it faithfully lands null/NA plants in UNZONED. The problem is that **zone completeness collapses in the ACTIVE working subset** that FSM actually syncs. Neither `zone_name` nor `plant_state` derivation can zone the big ACTIVE plants; they need manual `plant_zone_overrides`, a region-based fallback (`region_id`/`region_name`), or an Ops decision on the ACTIVE scope. Any "just normalize zone_name, it's clean" plan understates the manual work by fleet weight.

---

## Phase 5 — Scheduler Validation

All mechanisms confirmed by code **and** runtime observation:

- **Overlap protection:** durable `WHERE status='RUNNING'` partial-unique index on both `master_sync_runs` and `snapshot_runs`; `startRun()` throws 409 RUN_IN_PROGRESS. **Proven at runtime** — the enabled scheduler fired a telemetry tick mid-session (snapshot run 1) alongside the manual run 2; they serialized with no corruption.
- **Natural triggers:** the `*/30` telemetry scheduler fired on its own multiple times (snapshot runs 3 and 4 observed: `telemetry tick: snapshot 4 PARTIAL (1066 pings)` → `device-state recompute upserted 18204`).
- **Stale-run recovery:** `reapStaleRuns()` runs at every `startRun()` (45-min threshold) — this is why interrupted runs resolve to PARTIAL rather than blocking.
- **Partition maintenance:** `@Cron('10 0 * * *')`, create-ahead + `DROP TABLE` retention; 1,215 daily partitions present; 58k pings landed in dated partitions with no DEFAULT-partition fallback errors.

---

## Phase 6 — API Validation

Every endpoint returned expected status across roles; bodies cross-check against the DB.

**RBAC is correct and enforced:**

- **Zone scoping works** — ZM-North's `zone-overview` payload is 189 bytes vs 915 fleet-wide; `company-plant-overview` 857 bytes vs 23,909. The ZM sees only their zone.
- **403 matrix is consistent** — CSM and ZM are correctly denied `org/*` admin, `zm-scorecard`, `soft-inactive-trend`, and `integration/health`, while retaining dashboard access.
- **Empty-state handled** — `critical-queue`, `tickets` return `[]`; `fleet-uptime` near-empty (consistent with 0 tickets / 0 PGI).

**Dashboard-vs-DB cross-check:** zone-overview device counts sum to **18,204 = `device_states` exactly**. Total inactive reads **5,018 vs DB 5,015** — a 3-device discrepancy worth reconciling (likely a null-ping edge in the dashboard's inactive definition).

---

## Phase 7 — UI Validation (per role)

**Scope boundary (honest):** the UI's **data layer** was validated (the exact API responses each screen consumes, cross-checked against the DB), **not** browser rendering. The Vite admin app was not launched; visual/layout/interaction validation (loading states, charts, pagination) remains unverified.

- **Operations Head:** fleet-wide data present and correct; zone-overview spans all 5 zones.
- **CSM:** cross-zone dashboard visibility, correctly denied master-data admin.
- **Zonal Manager (North):** correctly scoped to zone 1. But North has just 158 devices — a ZM's practical view is nearly empty because the fleet is 83% UNZONED (the zone finding surfacing in the UI).

---

## Bugs & Findings (severity-ranked)

| # | Severity | Finding | Root cause | Fix |
|---|---|---|---|---|
| 1 | **HIGH (operational)** | 83% of synced devices → UNZONED | ACTIVE-scoped plants dominated by NULL-zone big plants; source-data reality, not a code bug | Manual overrides for top plants; region-based fallback; Ops decision on scope |
| 2 | **MEDIUM (correctness)** | Fleet-Uptime structurally empty | Pipeline never ingests PGI; `pgi_history`=0 → all ineligible | Add PGI ingestion, or gate Fleet-Uptime on a separate feed |
| 3 | **MEDIUM (infra)** | Container clock drift ~5.5h + session `TimeZone=Asia/Calcutta` | WSL2/Docker clock skew; non-UTC session (contradicts ADR-0025 "timestamptz UTC") | Pin NTP; set session `TimeZone=UTC` |
| 4 | LOW-MED (completeness) | `device_type` 100% NULL | Deliberate `NULL AS device_type` stub | Join `tb_vehiclemaster` or backfill from snapshot path |
| 5 | LOW (correctness) | Dashboard totalInactive 5,018 vs DB 5,015 | Definitional edge (null-ping) | Reconcile inactive definition |
| 6 | LOW (security) | In-memory user store, shared hardcoded password (`correct-password`) | Dev-only auth | Replace with Postgres-backed auth before deploy |
| 7 | LOW (ops) | Stale backend held port 3000 (EADDRINUSE); creds/VPN IP in plaintext `.env` | No process/secret management | Process manager + secrets store |
| 8 | INFO | 995 devices (5.5%) no telemetry match → null sla_bucket | device_id mismatch master vs telemetry | Monitor rate |

**Failure modes not reproduced (reasoned from code, not fault-injected):** mid-run crash recovery, connection-pool exhaustion, deadlocks. No evidence of them, but not adversarially tested.

---

## Performance

- Full pipeline **438s** for 18,204 devices / 49,999 pings / 601 chunks — comfortable for the daily-masters + 30-min-telemetry cadence.
- Master-sync 83s; snapshot ingest 353s (network-bound to AutoPlant, ≤90 rows/query respecting the DBA cap); device-state recompute set-based and fast.
- No slow-query pathologies. (One "active 7000s" query in `pg_stat_activity` was an artifact of the clock jump, not a real long-runner.)

---

## Production Readiness Scores (/10)

| Dimension | Score | Justification |
|---|---|---|
| Architecture | 8 | Clean modular monolith, ports/adapters, insert-only anti-drift zone_id, durable in-flight guards, config-as-data. |
| Reliability | 7 | Overlap + stale-run + partition maintenance present and runtime-proven; clock drift and no PID mgmt are environment gaps. |
| Correctness | 6 | Pipeline correct, idempotent, FK-clean — but Fleet-Uptime degenerate, 83% UNZONED limits usefulness, minor KPI drift. |
| Performance | 7 | 438s full-fleet fine for cadence; respects ≤90/query cap; no slow-query issues. |
| Maintainability | 8 | Heavily documented, TDD, config-as-data. |
| Security | 3 | In-memory users, shared hardcoded password, plaintext creds — not production auth. |
| Observability | 6 | Structured logs, run ledgers, reject accounting, health endpoint — but no metrics/alerting, and health timing is clock-sensitive. |
| Scalability | 6 | Set-based recompute + partitioning strong; full-fleet per-run reads and per-plant zone resolution fine now, watch at growth. |
| **Overall** | **6** | **Pipeline production-viable and demonstrably works end-to-end; product needs real auth, PGI ingestion, and an Ops decision on the UNZONED reality before deployment.** |

---

## Improvement Opportunities

- **Architecture/data:** treat the ACTIVE-scope zone gap as a first-class decision — region-based fallback tier, or bulk overrides for the top-20 plants (they carry most devices).
- **Correctness:** wire PGI ingestion so Fleet-Uptime has a denominator.
- **Observability:** emit metrics (run duration, skip/reject counts, pending-mapping count, drift) to a monitoring surface; health `ageMinutes` should not depend on a possibly-skewed DB clock.
- **Ops:** UTC everywhere; NTP-pinned containers; a process manager; secrets out of `.env`.
- **Security:** the Postgres auth swap is the single biggest gate to production.

---

## What was NOT done

- No browser-level UI validation (data layer only, cross-checked against DB).
- No code was modified — read/observe acceptance test only.
- Fault-injection failure modes (crash mid-run, pool exhaustion) were reasoned from code, not reproduced.
