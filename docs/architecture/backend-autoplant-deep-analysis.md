# FSM Backend × AutoPlant Production Integration — Deep Analysis Report

> **Date:** 2026-07-04 · **Branch:** `feat/autoplant-integration` · **HEAD at analysis:** `b45d00b`
> **Nature:** analysis only — no implementation. Companion docs:
> `autoplant-production-integration.md` (8-phase blueprint), `autoplant-integration-progress-tracker.md`
> (living tracker), `zone-architecture-investigation.md` (Rev 3), `docs/autoplant/` (production DESCRIBEs
> + sample data), `.scratch/fsm-platform-v1/issues/96-autoplant-master-sync.md`.
>
> **Evidence tags** used throughout:
> **[code]** = verified from the implementation · **[prod-db]** = verified from the production
> DESCRIBEs/sample data in `docs/autoplant/` · **[inferred]** = inferred from evidence ·
> **[unknown]** = requires clarification (collected in §15).

---

## TL;DR (the five findings that matter)

1. **The integration is already ~60% built and committed on this branch.** Phases 1–4 (connectivity,
   org-mirror schema, device-id String migration, real `AutoPlantSourceReader`, master-sync core, real
   `AutoPlantMasterSource`, health surface) exist in code with tests. This is not a greenfield
   integration problem — it is a *finish-and-wire* problem. **[code]**
2. **Nothing runs the pipeline in production.** There is no scheduler anywhere
   (`@nestjs/schedule`/BullMQ are not installed; grep for cron/setInterval finds nothing in runtime
   code). `DeviceStateService` is not registered in *any* Nest module;
   `TicketCreationService.createForInactiveEligible`, `RecommenderService.runForZone`, and
   `BatchAssignmentService.dispatchForZone` have **zero runtime callers** — they are only invoked by
   the Book8 test harness. Today, only snapshot ingestion has a trigger (`POST /api/snapshots/run`,
   Operations Head, manual). **[code]**
3. **With real AutoPlant data, zero tickets would be created** even if everything were wired: ticket
   creation gates on `eligible_for_uptime`, which requires a PGI within 15 days from `pgi_history` —
   a table populated only by seed/SAP (deferred). AutoPlant has no PGI concept. This is the single
   biggest functional gap (tracked as blocked Phase 5, "eligibility_source"). **[code]**
4. **The remaining blockers are business decisions, not engineering:** R6 (state→zone map ratification
   + `plants.zone_id` nullable migration), R13 (company tier/rank feed — not in AutoPlant), the
   plant-status scope set, and VPN/credentials. The code deliberately refuses to guess these (the
   resolver defers, `MasterSyncService` is unwired). **[code]**
5. **The production data quality matches what the code already defends against**:
   `mst_company.company_type` is dirty (real customers typed `NA`), `mst_vehicle.company_id` = 0,
   junk `plant_state` values (`india`, `NA`, blank), leading-zero device IMEIs. The plant-first
   master-sync design is the correct response to this data. **[prod-db]**

---

## 1. Current backend architecture **[code]**

NestJS modular monolith (`apps/backend`), Postgres 16 + PostGIS via Prisma (client generated to
`src/generated/prisma`), single `AppModule` composing 22 feature modules and ~40 controllers. No
microservices, no message broker in runtime (BullMQ mentioned in docs only — **not installed**).

**Module map** (dependency direction is uniformly inward toward `PrismaModule`; no cycles observed):

- **Spine**: `IngestionModule` (snapshots + all AutoPlant code) → `device-state/` (services only,
  *no module*) → `TicketingModule` (creation, troubleshoot submission, non-op, recovery, install,
  auto-recovery, repeat-escalation) → `RecommenderModule` → `SchedulingModule` (batch assignment /
  day plan / overrides) → `IntradayModule`, `CrossZoneModule`, `SharedPoolModule`.
- **Reads**: `DashboardModule`, `ReportsModule` (pre-aggregated monthly/daily cubes), `DevicesModule`.
- **Support**: `AuthModule` + guards (`AuthGuard`/`RoleGuard`/`ZoneScopeGuard`), `AuditModule`
  (same-transaction audit rows), `SettingsModule` (`system_settings` JSONB registry), `OrgModule`
  (zones/plants/companies/users/SE coverage/territory admin), `NotificationsModule` (channel gateway
  is a logging stub seam), `InventoryModule`, `VerificationModule`, `VouchersModule`.

**Ports-and-adapters is applied consistently at exactly the external seams:**

| Port (DI token) | Production adapter | Fallback | Wired? |
|---|---|---|---|
| `SOURCE_READER` | `AutoPlantSourceReader` (MySQL keyset reader) | `InMemorySourceReader` when env unset | ✅ config-guarded in `IngestionModule` |
| `MASTER_SYNC_SOURCE` | `AutoPlantMasterSource` (built, tested) | — | ❌ not bound; `MasterSyncService` not registered |
| `PLANT_ZONE_RESOLVER` | `StateMapZoneResolver` (built, PROVISIONAL map) | — | ❌ not bound (R6 gated) |
| `DAY_PLAN_NOTIFIER`, `INSTALL_NOTIFIER`, `RECOVERY_NOTIFIER`, `CUSTOMER_CONFIRMATION_NOTIFIER`, notification channel gateway | — | Logging stubs | Stubs only (external send deferred by design) |

`AutoPlantMysqlClient` is a lazy read-only pool (rejects any non-SELECT/SHOW/DESCRIBE/EXPLAIN SQL as
defence-in-depth), two-schema config (`ap_widgets` default + schema-qualified `ap_masters`),
`dateStrings: true` so timezone handling stays in the FSM normalizer. **[code]**

## 2. Current ingestion pipeline **[code]**

```
AutoPlant ap_widgets.tb_vehiclemaster  (current-state, 1 row/vehicle)
   │  AutoPlantSourceReader.readChunk()      ← keyset (latest_gps_datetime, device_id), 3 cursor modes
   │  mapping.ts: gpssignal JSON → mains status/voltage; IST(+330)→UTC; drops NULL-device /
   │  never-pinged / future-skewed rows; device_id preserved verbatim as String
   ▼
SnapshotIngestionWorker.run()                ← per-chunk retry ×3, run = SUCCESS/PARTIAL/FAILED
   ▼
raw_device_snapshots                         ← monthly-partitioned, UNIQUE(device_id, gps_datetime),
   │                                            ON CONFLICT DO NOTHING (idempotent re-runs)
   ▼
DeviceStateService.recompute()               ← latest ping per device → inactivity_hours, is_inactive
   │                                            (≥ configurable 24h), sla_bucket (pure classifier),
   │                                            eligible_for_uptime (PGI ≤15d ∧ no active Non-Op),
   │                                            denormalised vehicle/plant/company/transporter
   ▼
device_states                                ← the hot table every queue/dashboard reads
   ▼
TicketCreationService.createForInactiveEligible()
   │   is_inactive ∧ eligible ∧ no open cycle ∧ has plant+company
   │   → FailureCycle(OPEN|REPEAT) + Ticket(TROUBLESHOOT, OPEN) + TicketEvent + flag flip,
   │     one transaction, invariant I1 backstopped by partial-unique
   ▼
RecommenderService.runForZone()              ← canonical sort → precedence (Dedicated→Multi-Plant→
   │                                            Floating) → hard filters → weighted scoring +
   │                                            cluster multiplier → recommendations rows
   ▼
BatchAssignmentService.dispatchForZone()     ← WorkSchedule + PlantBatchAssignment + tickets,
   ▼                                            dispatched ACTIVE (no approval gate)
DashboardService                             ← raw SQL over device_states ⋈ tickets ⋈ plants/zones
```

**Cross-run resume**: `snapshot_runs.cursor` stores the high-water UTC `data_as_of`; a fresh run
resumes `>=` its source-local wall clock, and idempotency absorbs the boundary re-read. Cursor
advances off the last *scanned* DB row (not last *kept* row) so filtered rows can't loop the reader.
This is a sound design against a current-state source table. **[code]**

**Critical caveat**: every arrow after `raw_device_snapshots` is invoked **only by tests or manual
HTTP** today (§4).

## 3. Current Prisma data model **[code]**

~45 models (`apps/backend/prisma/schema.prisma`, 1,976 lines). The load-bearing spine:

- **Org**: `Company` (tier + priority rank = recommender inputs; `source_company_id`,
  `company_type`, `status` = AutoPlant mirror), `Zone` → `Plant` (with full AutoPlant hierarchy
  mirror: `source_plant_id`, `source_zone_*`, `source_region_*`, `plant_state/district`,
  `master_plant_*`, `status`), `Transporter` (`source_transporter_id`), `Region`/`District`
  geography.
- **Fleet**: `Vehicle` (unique `vehicle_no`, FKs plant/company/transporter, `status` mirrors
  `deployment_status`) → `Device` (**String PK** — the Phase-2b migration retyped device identity
  across 9 models precisely because of AutoPlant's leading-zero IMEIs and alphanumeric ids) →
  `DeviceState` (derived, denormalised hot row).
- **Work**: `FailureCycle` (one active per device, raw-SQL partial unique) → `Ticket` (unified
  work-item, `work_type` discriminator TROUBLESHOOT/INSTALL/RECOVERY) → `TicketEvent`,
  `Recommendation` (append-only explainability), `WorkSchedule`/`PlantBatchAssignment`/
  `BatchAssignmentTicket`, `IntradayInsertion`, `CrossZoneEscalation`, `SoftState`,
  `TroubleshootingSubmission`, `VerificationRun`, component/inventory/voucher/leave models.
- **Ops bookkeeping**: `SnapshotRun`/`SnapshotRunChunk`, `MasterSyncRun` (with one-in-flight
  partial-unique), `AuditLog`, report cubes (`DeviceDowntimeSummaryMonthly`,
  `RootCauseSummaryMonthly`, `ZmPerformanceSummaryMonthly`, `SystemEfficiencySummaryDaily`,
  `SoftInactiveCountHistory`).
- **Eligibility inputs**: `PgiHistory` (SAP PGI proof-of-commercial-use; *"integration external
  (deferred), rows seeded directly for now"* — schema comment), `NonOperationalMarking`.

Constraints Prisma can't express (partitioning, partial uniques, CHECKs, PostGIS) are consistently
appended as raw SQL in migrations — a deliberate, documented pattern.

## 4. Current runtime execution flow — what actually runs **[code]**

This is the most important Phase-1 finding:

| Pipeline stage | Production trigger today |
|---|---|
| Snapshot ingestion | `POST /api/snapshots/run` — manual, Operations Head only |
| Device-state recompute | **None.** `DeviceStateService` is not in any module's providers; no controller or worker calls it |
| Ticket creation | **None.** Exported from `TicketingModule` but never called at runtime |
| Recommender run | **None.** `runForZone` has no caller ("no cron yet" per its own comment) |
| Batch dispatch | **None** for the morning batch; ZM manual assignment endpoints exist |
| Master sync | **None.** `MasterSyncService` deliberately not registered (ports business-gated) |
| Report aggregations | Manual HTTP recompute endpoints (`reports.controller`) |

The only place the full chain executes end-to-end is the Book8 test harness
(`test/env/book8/book8-core.ts`), which composes the production classes manually against CSV
telemetry. The system is a complete engine with no ignition — Phase 7 (`IntegrationSchedulerService`,
ordering master → snapshot → recompute → ticket → recommender under the existing single-in-flight
guards) is the named missing piece, and its scheduler technology choice (`@nestjs/schedule` vs
BullMQ, which the docs promise but package.json does not contain) is flagged architecture-HITL.

## 5. AutoPlant production data model **[prod-db]**

Two MySQL schemas on one host: `ap_masters` (masters) + `ap_widgets` (live telemetry).

- **`mst_company`** — PK `company_id` (int). `company_type` is **unreliable**: sample shows real
  customers (`Coke`, `Nuvista`, `Wonder Cements`, `Vedanta - ESL`, `UTCL`) typed `NA`; only some
  rows are `Shipper`/`Transporter`. `status` ACTIVE/INACTIVE. Mostly-blank CRM columns; `NA` used
  as a null sentinel throughout.
- **`mst_plant`** — composite-looking PK (`plant_id` + `plant_code` both marked PRI); `company_id`
  **NOT NULL** — the one reliable ownership edge, which is why the sync is plant-first. Carries the
  full org hierarchy: `zone_id/zone_name`, `region_id/region_name`, `plant_state`, `plant_district`,
  and a **distinct parent reference** `master_plant_id/master_plant_code` (verified: plant 4561
  "Zuari" → master_plant_id 4460, ≠ its own id). Data quality: junk states (`india`, `NA`, blank),
  `zone_name` typos exist ("Noth India" per code comments), `region_id`/`zone_id` = 0 sentinels,
  test plants (`JKPlant_Test`) that are ACTIVE.
- **`mst_transporter`** — PK `transporter_id` (bigint); `company_id` NOT NULL, **`plant_id` NOT
  NULL** — transporters are registered per (company, plant) in AutoPlant, so one physical
  transporter can plausibly appear as multiple rows across plants **[inferred]**.
- **`mst_vehicle`** — **PK is `vehicle_no`** (varchar). `device_id` varchar(255), nullable,
  non-unique index (MUL). `company_id` **defaults 0 and is 0 in every sample row** — unusable; the
  vehicle's company must be resolved via its plant (exactly what `AutoPlantMasterSource` does with
  `LEFT JOIN mst_plant`). `plant_id`/`transporter_id` present; `deployment_status`
  (`DEPLOYED`/`UNDEPLOYED` in sample; `ACTIVE` expected per code); rich fitment-lifecycle columns
  (`device_installation_date`, `device_removed_dt`, `previous_vehicle_no`, `first_vehicle_no`,
  `record_updated_date` — the last being the future delta-sync key). `maintenance` remark carries
  values like `NO TRIP > 15 DAYS`.
- **`ap_widgets.tb_vehiclemaster`** — the telemetry-bearing current-state table the snapshot reader
  consumes (`device_id`, `latest_gps_datetime` naive IST, `latitude/longitude`, `speed`,
  `IGNITION_STATUS`, `DEVICE_TYPE`, `gpssignal` JSON with `power.mainstatus`/`mainvoltage` in mixed
  `"1"/"0"`/`"ON"/"OFF"` vocabularies). **[inferred — verified in code and the Phase-3
  investigation, but no DESCRIBE for this table is in `docs/autoplant/`; see Unknown U1.]**
- **Foreign keys**: the FK dump shows constraints only on audit (`*_aud` → `revinfo`) and Quartz
  scheduler tables — **the business master tables have no declared FKs**; referential integrity is
  by convention only. This validates FSM's defensive skip-if-parent-missing posture. **[prod-db]**
- **Device identity**: leading-zero IMEIs (`0869925073271551`) and vehicle-number-like device ids
  (`AP03TC0959`) confirmed in sample — the String-PK decision is correct and load-bearing.

## 6. Mapping between AutoPlant and FSM **[code, prod-db]**

| AutoPlant | FSM | Key | Sync status |
|---|---|---|---|
| `mst_plant` (status-scoped, zone-resolvable) | `plants` | `source_plant_id` | Mapper + source built; **blocked on R6** |
| `mst_company` (derived: only companies an in-scope plant references) | `company_master` | `source_company_id` | Built; tier/rank insert-only default SILVER/C (**R13**) |
| `mst_transporter` | `transporters` | `source_transporter_id` | Built; FK to vehicles wired (migration `20260703120000`) |
| `mst_vehicle` (company via plant join) | `vehicles` | `vehicle_no` (natural key) | Built |
| `mst_vehicle.device_id` (+fitment) | `devices.device_id` / `current_vehicle_id` | String device_id | Built; device synced only when its vehicle synced |
| `tb_vehiclemaster` latest ping | `raw_device_snapshots` | `(device_id, gps_datetime)` | **Built and wired** (env-gated) |
| AutoPlant `zone_name`/`zone_id` | `plants.source_zone_*` (audit mirror only) | — | Mirrored; FSM operational `zone_id` derived from `plant_state` instead |
| — (no AutoPlant source) | `pgi_history`, `deal_type`, tier/rank, SE org | — | **No mapping exists — external/FSM-owned** |

**Concept collisions handled correctly**: AutoPlant "zone" is a per-company hierarchy label; FSM
Zone is the ZM authority partition — the code keeps these separate (`source_zone_name` vs derived
`zoneId`). AutoPlant `master_plant` is a parent/grouping reference, mirrored but not used
operationally.

## 7. Data ownership analysis **[code]**

The anti-drift split is *structural* — each `master-mapping.ts` upsert plan's `update` set simply
omits FSM-owned columns, so a re-sync cannot clobber them (asserted by an idempotency e2e):

- **AutoPlant-authoritative (refreshed every sync)**: company name/type/status; plant name, source
  hierarchy, state/district, master_plant_*, status; transporter name/company/status; vehicle
  plant/company/transporter/deployment status; device fitment (`current_vehicle_id`) and
  `device_type`.
- **FSM-owned (insert-only or never touched)**: `company_tier`, `company_priority_rank`,
  `ops_override`; operational `zone_id`/`district_id`; `deal_type`; all SE org, coverage, territory,
  availability; all workflow state.
- **External (neither system)**: PGI (SAP), tier/rank truth (CRM/Ops Head).

## 8–9. Integration analysis: reusable / needs modification / missing

**Reusable as-is [code]:** the entire spine below the seams — ingestion worker + run lifecycle,
chunk idempotency, device-state computation, SLA classifier, ticket creation with invariants,
recommender + scheduling + intraday + cross-zone, verification, dashboards/reports,
`AutoPlantMysqlClient`, `AutoPlantSourceReader` + mapping, `MasterSyncService` + mapping + run
service, `AutoPlantMasterSource`, `StateMapZoneResolver` scaffold, health surface.

**Needs modification [code]:**

1. `IngestionModule` — register `MasterSyncService` and bind its three ports (source, resolver,
   scope) behind the same config guard as `SOURCE_READER`.
2. `plants.zone_id` → nullable + UNZONED handling + exception queue (**the** breaking R6 migration,
   ~16 call-site ripples across cross-zone/planner/override — correctly deferred to a deliberate
   change).
3. `DeviceStateService` — needs a module home and a caller; also note it loads *all* devices and
   upserts row-by-row in a loop — fine at Book8 scale (~34k), worth a set-based rewrite before
   fleet scale **[inferred]**.
4. `state-zone-map.ts` values un-flag once R6 is ratified.
5. Master sync full-table reads → delta reads on `record_updated_date` (later optimisation, already
   noted in code).

**Missing entirely:**

1. **Orchestrator/scheduler (Phase 7)** — the highest-impact missing component; nothing chains
   master-sync → snapshot → recompute → ticket-create → recommender → dispatch. Technology choice is
   flagged architecture-HITL.
2. **Eligibility source for production (Phase 5)** — PGI-based gate has no data source; needs a
   business-ratified interim proxy (e.g., AutoPlant `deployment_status`/PGI-independent
   eligibility, or a SAP feed). Without it: zero tickets.
3. **Deal-type source** — `RECURRING`/`ONE_TIME` drives Recovery-ticket auto-creation; no source
   (follow-up #48 per schema comment).
4. **Ops exception queue read/UI** for unzoned/conflicted plants (the `onConflict` hook currently
   has no consumer).
5. **External notification channels** (WhatsApp/push/SMS) — logging stubs by design.
6. **SAP PGI integration** — external seam, deferred.

## 10. Architectural inconsistencies **[code]**

- `device-state/` has services but no `DeviceStateModule` — the only spine stage outside the module
  system; it works only because tests construct it manually. Inconsistent with every other stage.
- Trigger asymmetry: ingestion and report recomputes have manual HTTP triggers; device-state
  recompute and ticket creation have none at all — so even manual end-to-end operation via the API
  is impossible today.
- The progress tracker's Phase-8 row says `health.service.ts` is ABSENT, but it exists and is wired
  — the doc row is stale (the tracker's own §3 table has it ✅). Minor doc drift, implementation
  wins.
- Two vehicle tables (`ap_masters.mst_vehicle` vs `ap_widgets.tb_vehiclemaster`) feed two different
  FSM paths (master sync vs snapshots); if AutoPlant lets them disagree on `device_id` fitment,
  FSM's `devices.current_vehicle_id` (master path) and the telemetry stream (widgets path) can
  diverge **[inferred → Unknown U3]**.

## 11. Risks

- **R6 mis-ratification** → wrong ZM scoping across every dashboard and queue (highest blast
  radius). Mitigated: resolver defers instead of guessing. **[code]**
- **Tier default degeneracy (R13)**: until a real tier feed, every synced company is SILVER/C —
  canonical sort collapses to bucket+age ordering; Platinum auto-escalation to cross-zone never
  fires. **[code]**
- **Duplicate `device_id` across vehicle rows**: `mst_vehicle.device_id` is non-unique
  **[prod-db]**; master sync iterates and last-writer-wins on `current_vehicle_id` with no dedup or
  warning **[code]** → nondeterministic fitment if production has active duplicates
  (**Unknown U4**).
- **Sampling loss on current-state telemetry**: `tb_vehiclemaster` holds only the *latest* ping per
  vehicle, so FSM's history is a poll-frequency-dependent sample. Inactivity detection (24h
  threshold) is robust to this, but `VerificationRun` Phase-2 "continued pinging" counts and any
  future movement analytics are sensitive to polling cadence (**Unknown U2**).
- **Skew guard breadth**: rows with `latest_gps_datetime` > now+24h are dropped entirely — a device
  with a badly wrong clock becomes permanently invisible rather than flagged **[code, inferred
  severity: low]**.
- **UNDEPLOYED semantics**: sample shows many `UNDEPLOYED` vehicles with fitted devices and old
  pings. If synced and PGI-eligible, they'd generate troubleshoot tickets for vehicles AutoPlant
  already knows are off-fleet (`NO TRIP > 15 DAYS`) (**Unknown U5**).

## 12. Technical debt **[code]**

Modest and mostly deliberate: per-row upsert loops in `DeviceStateService`/`MasterSyncService`
(N+1 `findUnique`+`upsert` pairs — acceptable now, quadratic pain at fleet scale); report
aggregations manual-only; Book8 harness scheduled for retirement in Phase 8; logging-stub
notifiers; `zonalManagerUserId`/`actorId` FKs deferred by pattern; the R6-flagged provisional zone
map living in code with warning comments (good practice, but it *is* live code that must not ship
un-ratified).

## 13. Production readiness assessment

**Not production-ready — by explicit design, not by accident.** Ready: schema, ingestion path,
master-sync mechanism, health/observability surface (`GET /api/integration/health` distinguishes
"not configured" from "VPN down" from "sync stale"). Blocking: no scheduler (P7), no eligibility
source (P5), R6/R13 unratified, no VPN/credentials validated (the ping smoke test has never run
against production), dashboards never rendered against real data (P6). The single-in-flight guards,
idempotent upserts, and read-only SQL guard mean a premature run is *safe* — it just does nothing
useful yet.

## 14. Required implementation roadmap (extends existing architecture; no rewrites needed)

1. **Unblock decisions (Ops Head / external — can proceed in parallel with 2–3):** ratify R6 (zone
   set: North/South seeded today vs four implied; Chhattisgarh/MP/UP/Rajasthan placements), decide
   the interim eligibility rule (P5), choose the tier/rank feed (R13), confirm plant-status scope,
   provision VPN + read-only credentials.
2. **Wire the master sync** (decision-free once R6 lands): register `MasterSyncService` in
   `IngestionModule`, bind `MASTER_SYNC_SOURCE` → `AutoPlantMasterSource`, `PLANT_ZONE_RESOLVER` →
   `StateMapZoneResolver`, scope from config; add a manual `POST /api/master-sync/run` (Ops Head)
   mirroring the snapshot trigger for controlled first runs.
3. **Give `DeviceStateService` a module** and a trigger; consider the set-based recompute rewrite
   at the same time.
4. **R6 breaking migration**: `plants.zone_id` nullable + UNZONED holding + exception-queue read
   (+ the ~16 call-site ripples, done deliberately).
5. **Phase 7 orchestrator**: decide `@nestjs/schedule` vs BullMQ (HITL), then one
   `IntegrationSchedulerService` chaining master → snapshot → recompute → ticket-create →
   recommender → dispatch per zone, leaning on the existing in-flight guards.
6. **Phase 6/8 validation**: VPN smoke (`ping` both schemas), first live master sync + row-count
   reconciliation vs AutoPlant, first live snapshot drain, dashboard verification on real data,
   failure-injection on the health banner, retire Book8.

## 15. Unknowns — genuinely required, with the queries to answer them

- **U1 — `tb_vehiclemaster` authoritative DESCRIBE.** The snapshot reader's column list
  (`latest_gps_datetime`, `gpssignal`, `IGNITION_STATUS`, …) is verified in code/tests but no
  DESCRIBE for this table exists in `docs/autoplant/` (only the four `mst_*`). Matters: the wired,
  live ingestion path depends on it.
  ```sql
  DESCRIBE ap_widgets.tb_vehiclemaster;
  ```
- **U2 — AutoPlant-side update cadence of `latest_gps_datetime`.** Determines FSM polling
  frequency, verification Phase-2 viability, and whether a true ping-history table should be
  sourced instead. Also: does a per-ping history table exist in `ap_widgets`?
  ```sql
  SHOW TABLES FROM ap_widgets;
  SELECT COUNT(*), MAX(latest_gps_datetime), MIN(latest_gps_datetime)
  FROM ap_widgets.tb_vehiclemaster
  WHERE latest_gps_datetime >= NOW() - INTERVAL 1 DAY;
  ```
- **U3 — Do `mst_vehicle` and `tb_vehiclemaster` agree on fitment?** Affects whether master sync
  and snapshot path can diverge on `device_id`→vehicle.
  ```sql
  SELECT COUNT(*)
  FROM ap_masters.mst_vehicle m
  JOIN ap_widgets.tb_vehiclemaster w ON w.vehicle_no = m.vehicle_no
  WHERE COALESCE(m.device_id,'') <> COALESCE(w.device_id,'');
  ```
- **U4 — Duplicate active device fitments.** Master sync currently last-writer-wins.
  ```sql
  SELECT device_id, COUNT(*) c
  FROM ap_masters.mst_vehicle
  WHERE device_id IS NOT NULL AND TRIM(device_id) <> '' AND deployment_status = 'DEPLOYED'
  GROUP BY device_id HAVING c > 1 ORDER BY c DESC LIMIT 50;
  ```
- **U5 — `deployment_status` full vocabulary + fleet semantics** (does UNDEPLOYED mean "exclude
  from service scope"?). Affects the device_states denominator and ticket noise.
  ```sql
  SELECT deployment_status, COUNT(*) FROM ap_masters.mst_vehicle GROUP BY deployment_status;
  ```
  — plus a business call on which statuses are serviceable fleet.
- **U6 — Full production state/zone distribution for R6** (the sample is partial; the proposal doc
  already contains the exact query):
  ```sql
  SELECT plant_state, zone_name, COUNT(*)
  FROM ap_masters.mst_plant
  WHERE status = 'ACTIVE'
  GROUP BY plant_state, zone_name
  ORDER BY 3 DESC;
  ```
- **U7 — Source server timezone.** The +330 IST offset is a constant assumption
  (`AUTOPLANT_UTC_OFFSET_MIN`, env-overridable).
  ```sql
  SELECT @@global.time_zone, @@session.time_zone, NOW();
  ```
- **U8 — Eligibility interim rule (business, not a query):** in the absence of SAP PGI, what marks
  a device as commercially active? Candidate proxy visible in the data:
  `deployment_status = 'DEPLOYED'` — but that is Ops Head's call, and it changes both ticket
  creation and the Fleet-Uptime denominator.
- **U9 — Production zone set (business):** the dev seed has only North/South; four zones are
  implied. Must be settled before R6 mapping can resolve East/West plants at all.

---

**Bottom line:** the architecture needs no redesign for AutoPlant. The remaining work is one Nest
wiring change, one deliberate breaking migration (R6), one scheduler, one eligibility decision, and
live-data validation — everything else is already built, tested, and deliberately parked behind
seams waiting for exactly those decisions.
