# AutoPlant Production Integration — Progress Tracker & Production Readiness Checklist

> ⚠️ **STALE (marked 2026-07-10 by the SYSTEM-STATE audit).** Last verified 2026-07-03 at HEAD
> `b45d00b` — ~40 commits behind. Phase marks predate #97 slices 2–7 and #100–#113. Do not plan
> from this file; current state lives in `docs/SYSTEM-STATE-2026-07.md` + INDEX.md.

> **Companion to** `docs/architecture/autoplant-production-integration.md` (the approved 8-phase blueprint)
> and `docs/architecture/zone-architecture-investigation.md` (Rev 3).
> **This file is a living tracker** — update the status marks and the "Last verified" line as phases land.
>
> **Last verified:** 2026-07-03 · **Branch:** `feat/autoplant-integration` · **HEAD:** `b45d00b`
> **Verification basis:** git log/diff/status, Prisma schema diff, file reads, grep, `tsc --noEmit`, full backend
> test suite (787 passed / 5 skipped) — repository evidence only. Commits since Phase-4 core: `5ac6857`
> (health surface + issue 96), `710475f` (real `AutoPlantMasterSource` + `mst_plant` column fix),
> `b45d00b` (plant-first derivation — R14 dissolved into R6).

## Legend

| Mark | Meaning |
|---|---|
| ✅ | Done — committed and verified |
| 🟡 | In progress / uncommitted in working tree |
| ⛔ | Blocked — waiting on a business decision or external access |
| ⬜ | Not started |
| 🔁 | Deferred by design to a later phase (intentional) |

---

## 1. Executive progress

| Metric | Value |
|---|---|
| Phases committed | **5 of 8** (Phase 1, 2a, 2b, 3, 4-core) |
| Phases in flight (uncommitted) | **0** |
| New runtime modules built (of design §9's six) | **~4 of 6** (`AutoPlantSourceReader`, `AutoPlantMappingLayer`, `MasterSyncService` core, `master_sync_runs` service) |
| Phase-count progress | **≈ 5 / 8 (~60%)** — Phase 4's *decision-free core* is done; its business-gated values remain |
| Effort-weighted progress | **~50%** (reader + master-sync mechanism built; scheduler/health phases 7/8 remain, plus the R6/R13/R14 business gates) |
| Data actually flowing AutoPlant→FSM | **Wired, not yet flowing** — `SOURCE_READER` binds the real `AutoPlantSourceReader` when env is set; `MasterSyncService` is built + tested but **not wired into Nest** (its scope/zone/source ports are gated); live data awaits VPN + credentials (HITL) |

**One-line status:** connectivity + schema mirror + the breaking device-id migration + the real telemetry SourceReader + the **master-sync mechanism** (pure mapping, run writer, transporter FK, FK-ordered upsert with anti-drift) are all committed and unit/e2e-tested; but no live data flows until VPN/credentials land, and the master synchroniser's live wiring waits on the R6/R13/R14 business decisions and Phase-7 scheduling.

---

## 2. Phase tracker (blueprint §11)

| Phase | Objective | Status | Evidence / anchor |
|---|---|---|---|
| **1 — Two-schema connectivity** | Reach `ap_widgets` + `ap_masters`, read-only | ✅ | commit `64ef534`; `autoplant-mysql.client.ts:22-53,80-101` |
| **2a — Org-mirror schema** | source keys, `transporters`, `master_sync_runs` | ✅ | commit `d619aa7`; migration `20260702120000_add_autoplant_org_mirror` |
| **2b — device_id BigInt→String** | String device identity across the spine | ✅ | commit `3e47f5e`; migration `20260702130000_device_id_bigint_to_string`; 9 models + `SourceSnapshotRow` |
| **3 — AutoPlant SourceReader** | real `readChunk` over `tb_vehiclemaster`+`gpssignal`, cursor-resume | ✅ | commit `a2b7201`; `autoplant-source-reader.ts` + `mapping.ts`; `SOURCE_READER` config-guarded bind. **Live VPN drain = HITL** |
| **4 — Master synchronizer** | upsert masters by `source_*_id`, FSM-owned preserved | 🟡 | **core done** `83c5513`: `master-mapping.ts` + `master-sync.service.ts` + `master-sync-run.service.ts` + transporter FK; 23 tests. **Gated/deferred:** R14 scope values, R6 zone map + `zone_id` nullable, R13 tier feed, Nest wiring (Phase 7) |
| **5 — Device states + interim eligibility** | correct `device_states` + eligibility proxy | ⛔ | no `eligibility_source` in src; needs business sign-off |
| **6 — Dashboard verification** | consumers render on real data | ⛔ | blocked on real data (no reader/syncer) |
| **7 — Recommender + scheduler chain** | cadence + orchestration | ⬜ | `@nestjs/schedule`/`bullmq` count = 0; no `integration-scheduler.service.ts` |
| **8 — Production validation + cutover** | VPN smoke, health, retire Book dataset | ⬜ | `health.service.ts` ABSENT; `test/env/book8/*` still present |

---

## 3. New runtime modules (blueprint §9) — build tracker

| Module | Path (planned) | Status | Notes |
|---|---|---|---|
| `AutoPlantSourceReader` | `ingestion/autoplant/autoplant-source-reader.ts` | ✅ | commit `a2b7201`; keyset `(gps_datetime, device_id)` R10, 3 cursor modes, 7 unit tests |
| `AutoPlantMappingLayer` | `ingestion/autoplant/mapping.ts` | ✅ | commit `a2b7201`; `tb_vehiclemaster`/`gpssignal`→FSM (snapshot side), 11 unit tests. `mst_*` master maps still Phase 4 |
| `MasterSyncService` | `ingestion/autoplant/master-sync.service.ts` | 🟡 | **core ✅** `83c5513`: FK-ordered upsert via pure `master-mapping.ts`, injected `MasterSyncSource`/`PlantZoneResolver`/`MasterSyncScope` ports; anti-drift structural (FSM-owned excluded from update). **Not Nest-wired** (ports gated/VPN); 4 e2e + 14 unit tests |
| `AutoPlantMasterSource` | `ingestion/autoplant/autoplant-master-source.ts` | ✅ | `710475f`; real `MasterSyncSource` over `ap_masters` (schema-qualified, `mst_vehicle⋈mst_plant` for company). Schema is now authoritative (`docs/autoplant/`); `mst_plant.master_plant_*` + `mst_vehicle.company_id=0` corrections applied. 5 unit tests. Binds behind config guard in Phase 7 |
| `MasterSyncRunService` | `ingestion/autoplant/master-sync-run.service.ts` | ✅ | `83c5513`; `master_sync_runs` writer + single-in-flight guard (advisory lock + `master_sync_runs_one_in_flight` partial-unique); 5 e2e tests |
| `IntegrationSchedulerService` | `ingestion/integration-scheduler.service.ts` | ⬜ | needs `@nestjs/schedule` or `bullmq` (not installed); this is where `MasterSyncService` gets Nest-wired |
| `AutoPlantHealthService` | `ingestion/autoplant/health.service.ts` | ✅ | source connectivity (configured/reachable) + master-sync/snapshot freshness; `GET /api/integration/health` (OpsHead), self-wired in `IngestionModule`; 4 e2e + 3 HTTP e2e. Failure-injection (VPN drop → banner) still Phase 8 |
| `master_sync_runs` table + service | schema + service | ✅ | **table ✅** (`schema.prisma`); **service ✅** (`MasterSyncRunService`, `83c5513`) |

---

## 4. Schema deltas tracker (blueprint §7)

| # | Sev | Change | Status | Evidence |
|---|---|---|---|---|
| 1 | C | `device_id` → `String` across 9 models + `SourceSnapshotRow` | ✅ | commit `3e47f5e`; migration `20260702130000_device_id_bigint_to_string` |
| 1a | C | (alt) surrogate `device_pk` | 🔁 not chosen | String key (#1) selected per design |
| 2 | C | `transporters` table | ✅ | `schema.prisma:1505-1516` |
| 2 | C | `vehicles.transporter_id → transporters` **FK** | ✅ | `83c5513`; migration `20260703120000` nulls dangling ids then adds FK (`ON DELETE SET NULL`) |
| 3 | C | `source_company_id` / `source_plant_id` / `source_transporter_id` / `source_device_id` (unique) | ✅ | `:68, :200, :1507`; device source key = the String PK itself |
| 3a | H | `plants` org-hierarchy source attributes | ✅ | `:200-208` (`source_zone_id/name`, `source_region_id/name`, `plant_state/district`, `master_plant_id/code`) |
| 4 | H | mirrored `status`/`active` on company/plant/vehicle/device | ✅ | `company_master.status`, `plants.status`, `vehicles.status` |
| 4a | H | `company_master.company_type` | ✅ | `:69` |
| 5 | H | eligibility-source mechanism | ⛔ | not implemented; business-rule gated |
| 6 | M | `vehicle_device_mappings` history | 🔁 deferred | not required for v1 |
| 7 | M | keep `raw_device_snapshots.device_id` FK-less | ✅ | intentional; retyped in place by 2b migration |
| 8 | M | two-schema config | ✅ | `autoplant-mysql.client.ts:22-25` |
| 9 | L | cursor-resume consumed | ✅ | `a2b7201`; reader owns resume via `SnapshotRunService.lastResumeCursor()` (worker unchanged, §6.2 opt-a) |
| 10 | L | `master_sync_runs` table | ✅ | `:1520-1531` |
| — | H | `plants.zone_id` → nullable | 🔁 Phase 4 | still `BigInt` non-null (`:193`) |

---

## 5. Per-phase detail checklists

### Phase 2b — device_id BigInt→String (✅ committed `3e47f5e`)
- [x] Retype `device_id` on all 9 models (`Device@id`, `DeviceState@id`, `RawDeviceSnapshot`, `FailureCycle`, `Ticket`, `PgiHistory`, `VerificationRun`, `DeviceDowntimeSummaryMonthly`, `NonOperationalMarking`)
- [x] `SourceSnapshotRow.deviceId: string`
- [x] Migration drops→retypes→re-adds the 5 device FKs; retypes 3 FK-less columns via `::text`
- [x] HTTP boundary parsers accept opaque string ids (drop numeric-only reject); plant/company stay BigInt
- [x] `test/source-reader.spec.ts` + ~115 fixture files churned bigint→String
- [x] `prisma migrate deploy` green; `tsc --noEmit` clean; full suite green (737 passed at 2b)
- [x] Committed as a discrete boundary (schema + migration + src + specs)

### Phase 3 — AutoPlant SourceReader (✅ committed `a2b7201`)
- [x] `autoplant-source-reader.ts implements SourceReader`
- [x] `SELECT … FROM tb_vehiclemaster WHERE latest_gps_datetime IS NOT NULL AND device_id IS NOT NULL … ORDER BY latest_gps_datetime, device_id LIMIT n`
- [x] Keyset cursor `"<wallclock>|<device_id>"` (intra-run); cross-run resume from last `snapshot_runs.cursor` via `lastResumeCursor()` (R10, §6.2 opt-a)
- [x] `mapping.ts`: `gpssignal` JSON → `power.mainstatus/mainvoltage`; leading-zero/alphanumeric/NULL `device_id`; never-pinged skip; future-timestamp guard
- [x] `normalizeSourceRow(+330)` reused (IST→UTC) — no change
- [x] Rebind `SOURCE_READER` (config-guarded: real reader when env set, else `InMemorySourceReader`)
- [x] Unit tests (recorded sample rows) + fake-client chunk/cursor tests (18 total)
- [ ] `autoplant:ping` smoke on both schemas (behind VPN) — **external-access HITL, not run**

### Phase 4 — Master synchronizer (🟡 core committed `83c5513`; business-gated tail open)
- [x] `master-sync.service.ts` upsert by `source_*_id`, FK order companies→transporters→plants→vehicles→devices
- [x] FSM-owned columns excluded from update set (`zone_id`, `district_id`, `deal_type`, `ops_override`, tier/rank) — structural in `master-mapping.ts`; anti-drift asserted by e2e re-sync test
- [x] Wire `vehicles.transporter_id → transporters` FK (migration `20260703120000`)
- [x] `master_sync_runs` writer (`MasterSyncRunService`, per-entity counts + status + single-in-flight guard)
- [x] Scoping **mechanism** — **plant-first** (`plantInScope` on `mst_plant.status` + companies DERIVED from in-scope plants; R14 company allow-list proven unnecessary — `710475f`+refactor). `company_type` no longer consulted.
- [x] Zone-assignment **mechanism** (`PlantZoneResolver` port; unmappable plant ⇒ deferred, no invented zone)
- [~] Zone-assignment **scaffold** — PROVISIONAL `state-zone-map.ts` + `StateMapZoneResolver` (`deriveZone`
      w/ `zone_name` conflict cross-check; defers on junk/unseeded); 14 unit tests; `docs/autoplant/R6-zone-map-proposal.md`. Ratification + breaking migration still gated.
- [x] ~~R14 scope VALUES~~ **DISSOLVED** — investigation proved company scope is derivable from the authoritative `mst_plant` (NOT-NULL `company_id`); no company allow-list. Only the plant status baseline (ACTIVE) + R6 remain.
- [ ] **R6** `plants.zone_id` nullable + `UNZONED` holding zone + Ops-Head exception queue + real `state→zone` map (breaking migration, ~16 ripples)
- [ ] **R13** real tier/rank feed (CRM/SAP or Ops-Head seed) — insert-only default ships now
- [ ] Nest wiring of `MasterSyncService` + real `MasterSyncSource` over `ap_masters` (Phase 7 scheduler / VPN)
- [ ] Inactive/deleted handling verified on live data (no destructive delete; mirror `status`)

### Phase 5 — Device states + interim eligibility (⛔)
- [ ] Eligibility proxy: `vehicle_deployment_status ∈ {ACTIVE, DEPLOYED}` → eligible (**R2 sign-off**)
- [ ] Never-pinged deployed-device policy (**R7 sign-off**)
- [ ] Recompute produces rows for active **and** inactive devices (denominator rule §1.3)

### Phase 7 — Scheduler + orchestration chain (⬜)
- [ ] Choose `@nestjs/schedule` vs `bullmq` (**architecture-HITL**) and add dependency
- [ ] `IntegrationSchedulerService`: master(daily) → snapshot(15–30m) → recompute → ticket → recommender
- [ ] Preserve single-in-flight guard (advisory lock + partial-unique)

### Phase 8 — Production validation + cutover (⬜)
- [ ] `AutoPlantHealthService` + `GET /api/integration/health`
- [ ] Failure injection (VPN drop → PARTIAL/FAILED; `data_as_of` banner correct)
- [ ] Retire `test/env/book8/*` (keep a minimal fixture reader for worker tests)

---

## 6. Business-decision tracker (Strategic HITL — gates Phases 4–5)

| ID | Decision | Owner | Status | Consequence if unresolved |
|---|---|---|---|---|
| R2 | Interim eligibility proxy (deployment status → eligible) | Ops Head | ⛔ open | `eligible_for_uptime=false` → **zero TROUBLESHOOT tickets** |
| R6 | Plant→FSM-Zone `state→zone` map (+ `UNZONED` fallback) | Ops Head | ⛔ open | Wrong ZM row-scope / dashboard mis-scoping |
| R7 | Never-pinged deployed device: inactive or not? | Ops Head | ⛔ open | Dead-looks-active / active-looks-dead |
| R13 | Company tier/rank ownership (CRM/SAP or Ops-Head seed) | Ops Head / SAP | ⛔ open | Recommender canonical sort degenerates (all equal) |
| R14 | Master scoping filter (which companies/plants are FSM's fleet) | (dissolved into R6) | ✅ resolved | **Plant-first derivation** — scope `mst_plant` (authoritative, `company_id` NOT NULL); companies derived from in-scope plants. No company allow-list; `company_type` unused. Only plant status baseline + R6 remain |
| — | Backlog issue for `ap_masters`→FSM master sync (§Appendix B gap) | Backlog owner | ⬜ unfiled | Phase 4 has no tracked issue |

---

## 7. Production-dependency tracker (external access)

| Dependency | Status | Note |
|---|---|---|
| VPN egress to `10.0.0.25` | ⛔ | external-access HITL; app stays on mock reader until present |
| Least-privilege read-only MySQL account (`SELECT` on `ap_widgets` + `ap_masters`) | ⛔ | ADR-0025 — secret never committed |
| Live `ap_widgets` / `ap_masters` data | ⛔ | needed to reconcile row counts + verify dashboards |
| Scheduler runtime (`@nestjs/schedule` or Redis/BullMQ) | ⬜ | dependency not installed |

---

## 8. Production Readiness Checklist (blueprint §15, annotated)

```
[✅] Review & approve architecture (data ownership, mapping, §7 schema deltas)
[⛔] Sign off business rules: interim eligibility (§5.6), never-pinged (§6.6), plant→Zone (§5.2)   ← R2/R6/R7
[⛔] Provision VPN egress + least-privilege read-only account on ap_widgets + ap_masters           ← external-access HITL
[✅] Validate Prisma deltas → migrate: device_id String, transporters, source_*_id, status,
     master_sync_runs                                                                              ← 2a ✅; 2b ✅ (3e47f5e)
[✅] Two-schema AutoPlant config + autoplant:ping green on both schemas                             ← config ✅; live ping needs VPN
[✅] Build AutoPlant SourceReader (tb_vehiclemaster + gpssignal, IST→UTC, cursor-resume) → rebind   ← a2b7201; live drain HITL
[🟡] Verify Snapshot ingestion (idempotent; UTC correct; device ids preserved; data_as_of accurate) ← unit/e2e green; live verify needs VPN
[🟡] Build Master Synchronizer (upsert by source-id; FSM-owned preserved; no destructive delete)   ← core `83c5513`; scope/zone VALUES + Nest wiring gated (R6/R13/R14)
[⬜] Verify Master Data (row counts reconcile; SE coverage/territory MV FKs resolve; re-sync = no drift)
[⬜] Verify Device States (rows for active + inactive; SLA buckets; eligibility proxy)
[⬜] Verify Dashboards (queues/rollups/critical-queue + freshness banner)
[⬜] Verify Recommendations (canonical sort + scoring; orchestration chain ordered)
[⬜] Wire IntegrationScheduler (master daily / snapshot 15–30 min → recompute → ticket → recommender)
[🟡] Health + alerting (connectivity + freshness); failure injection (VPN drop → PARTIAL/FAILED)   ← `AutoPlantHealthService` + `/api/integration/health` done (`83c5513`+); failure-injection still Phase 8
[⬜] Retire Book Dataset (delete test/env/book8/*; keep a fixture SourceReader for worker tests)
[⬜] PRODUCTION READY
```

**Readiness score:** 5 of 16 checklist items green (architecture, config, Prisma deltas/migrate, SourceReader build); 1 in flight (snapshot verify — needs VPN); the remaining 10 not started or blocked.

---

## 9. Risk register status (blueprint §14)

| # | Risk | Sev | Mitigation status |
|---|---|---|---|
| R1 | Device-id type corrupts leading-zero/alphanumeric ids | C | ✅ resolved in 2b (String), committed `3e47f5e` |
| R2 | No PGI source → zero tickets | C | ⛔ open (business sign-off) |
| R3 | VPN loss stalls/loses runs | H | 🟡 lazy pool/fallback ✅; cursor-resume ✅ (a2b7201); fail-fast statement timeouts ⬜ |
| R4 | Master-sync clobbers FSM-owned data | H | ✅ structural in `master-mapping.ts` (FSM-owned excluded from every `update` set) + idempotency e2e asserts no drift on re-sync (`83c5513`) |
| R5 | Full-scan performance on ~50k rows | H | 🟡 incremental keyset cursor built (a2b7201); chunked reads via worker; statement timeouts ⬜ |
| R6 | Zone-model mismatch mis-scopes ZM | H | ⛔ open (state→zone map decision) |
| R7 | Never-pinged/stale-timestamp devices | M | ⛔ open (policy) |
| R8 | Ingestion lands device absent from `devices` | M | ⬜ ordering (sync-before-snapshot) unbuilt |
| R9 | Two-schema config regression | M | ✅ preserved unset⇒mock; `autoplant-config.spec.ts` |
| R10 | No scheduler today | M | ⬜ unbuilt (Phase 7); note: R10 *cursor-resume* is done — this row is the *scheduler* |
| R11 | Telemetry gaps (`gpssignal` modem fields) | L | 🔁 accepted (non-load-bearing) |
| R12 | Rollback after cutover | L | ✅ feature-flag (unset env ⇒ mock reader) |
| R13 | No company tier/rank in AutoPlant | M | ⛔ open (CRM/SAP or Ops-Head seed) |
| R14 | Master scoping undefined | H | ✅ resolved — plant-first derivation from authoritative `mst_plant` (no company allow-list); see §6 |

---

## 10. Next action

Phase 4's **decision-free core is committed** (`83c5513`). What remains is business-gated or later-phase:

1. **Put the Phase-4 business gates to Ops Head (Strategic HITL):** **R14** scope VALUES (which
   `company_type`/`status` = FSM's fleet), **R6** `state→zone` map + the `plants.zone_id → nullable` breaking
   migration (+ `UNZONED` holding zone + Ops-Head exception queue + ~16 call-site ripples), **R13** tier/rank
   feed. The *mechanisms* (scope predicate, `PlantZoneResolver`, insert-only tier default) are built and waiting
   for values — do **not** invent them.
2. **File the master-sync backlog issue** (§Appendix B gap) in `.scratch/fsm-platform-v1/INDEX.md`.
3. **Phase 7 wiring:** once R6/R14 land + a real `MasterSyncSource` over `ap_masters` exists, register
   `MasterSyncService` behind the scheduler (`@nestjs/schedule`/BullMQ — architecture-HITL) with the ordering
   master→snapshot→recompute→ticket→recommender. `MasterSyncService` is intentionally **not** in a Nest module
   yet (its ports are unbound).
4. **Provision VPN + read-only credentials** (external-access HITL) to run the live `autoplant:ping` + a bounded
   snapshot drain and check off the remaining Phase-3 verify item.

> Keep this tracker in sync: when a phase commits, flip its row to ✅, tick its checklist boxes,
> and bump the "Last verified" line with the new HEAD.
