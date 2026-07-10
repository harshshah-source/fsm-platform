# AutoPlant Production Integration — Architecture & Implementation Blueprint

> **Status:** DESIGN / BLUEPRINT (no production code in this document).
> **Scope:** Replace the test-only *Book Dataset / `InMemorySourceReader`* ingestion with a real, read-only
> integration against the **AutoPlant MySQL** source system (host `10.0.0.25`, over VPN).
> **System of record:** FSM PostgreSQL. **AutoPlant is a *source system only*** — never written to.
> **Authority:** `CONTEXT.md` → PRD → workflow → backend LLD → ADRs (per `docs/agents/domain.md`).
>
> This document is the production implementation guide. Implementation begins **only after review/approval**,
> phase-by-phase. Nothing here modifies Prisma, the `SourceReader`, or synchronization yet.

---

## 0. Executive summary — the five decisive findings

Everything below is backed by repository evidence. The five findings that shape the whole design:

1. **Device identity is the central schema blocker.** The entire FSM device spine assumes a numeric key:
   `SourceSnapshotRow.deviceId: bigint` (`apps/backend/src/ingestion/source-reader.ts:16`) →
   `raw_device_snapshots.device_id BigInt` (`schema.prisma:1105`) → `Device.deviceId BigInt @id`
   (`schema.prisma:1430`) → `device_states`, `failure_cycles`, `tickets`, `pgi_history`, `verification_runs`,
   `non_operational_markings`, `device_downtime_summary_monthly`. **AutoPlant `tb_vehiclemaster.device_id` is
   `varchar(255)`** and real data contains **leading-zero IMEIs** (`0869925073271551`), **alphanumeric ids**
   (`AP03TC0959`, third-party WheelsEye/vendor GPS), and **NULLs**. A `BigInt` key silently corrupts leading
   zeros and cannot store the rest. **Device identity must become a String** (see §7). This **overturns a
   documented LLD decision** — `fsm-backend-low-level-design.md:113` and `fsm-db-schema-table-wise.md:406`
   ("`device_id` bigint PK … matching the AutoPlant source-of-truth id space — **accepted coupling**") assumed a
   *numeric* device_id. That assumption predates production discovery and is falsified by the real data;
   revisiting it is an **architecture-level decision (Strategic HITL)**, not a routine schema tweak.

2. **Two source databases, single-DB config.** Discovery shows the source is split:
   - **`ap_widgets`** — live operational (`tb_vehiclemaster` = the Snapshot source; trip/alert/telemetry).
   - **`ap_masters`** — master data (`mst_company`, `mst_zone`, `mst_region`, `mst_plant`, `mst_vehicle`,
     `mst_transporter`).

   The current `AutoPlantMysqlConfig` (`autoplant-mysql.client.ts:17-24`) and `.env.example` assume a **single**
   `AUTOPLANT_MYSQL_DATABASE`. Master-sync + snapshot must read across **both** schemas.

3. **Org tenancy models do not match.** AutoPlant's org tree (`company → zone → region → plant`) is
   **per-customer-company** (each customer has its own zones/regions). FSM `Zone` is an **FSM-owned operational
   construct** (Zonal-Manager authority: NORTH/SOUTH/EAST/WEST) with **no `companyId`** and **no source-id column
   anywhere** on Company/Zone/Region/Plant (`schema.prisma`). Plant→FSM-Zone assignment is an **FSM-owned
   decision**, not a copy of `mst_plant.zone_id`. Reconciliation columns and a `transporters` table (absent
   today) must be added. **→ The Organization/Zone architecture was re-investigated twice and is now settled (Rev 3):
   Organizational hierarchy (`company → zone → region → plant → state/district`) is **AutoPlant-owned and
   authoritative** in `mst_plant` — FSM **mirrors it faithfully** (incl. AutoPlant's zone/region/state/district as
   *source attributes* on `plants`). The FSM **operational Zone** (ZM authority, cross-company, ~4) is a **separate
   FSM-owned concern** — `plants.zone_id` is derived from the authoritative `plant_state` via an FSM `state → zone`
   map (cross-checked against `source_zone_name`, Ops override), **never** a copy of AutoPlant's per-company zone.
   Full analysis: `docs/architecture/zone-architecture-investigation.md` §Revision 3 (§3.3, §5.2, §7 #3a, Risk R6
   here are updated to match).**

4. **The connection seam is already built; the mapping and orchestration are not.** `AutoPlantMysqlClient`
   exists (read-only guarded `mysql2` pool, `dateStrings:true`, lazy boot — `autoplant-mysql.client.ts`),
   `normalize.ts` handles IST→UTC, and `SourceReader` is a **one-method interface** (`readChunk`) bound via the
   `SOURCE_READER` DI token (`ingestion.module.ts:28`). The production swap is localized. **Gaps:** the real
   `SourceReader` is an empty `InMemorySourceReader([])`; the worker never resumes from the persisted cursor
   (always full-drains); **there is no master-sync path at all**; and **there is no scheduler** (`@nestjs/schedule`,
   `bullmq`, cron are all absent — ingestion is HTTP-triggered only).

5. **Eligibility (and therefore ticketing) has no AutoPlant source.** `device_states.eligible_for_uptime` gates
   ticket creation (`ticket-creation.service.ts:29-37`) and depends on **PGI** (`pgi_history`, SAP) + **Non-Op
   markings** (FSM). AutoPlant supplies neither. Without a PGI signal, `eligible_for_uptime=false` and **no
   TROUBLESHOOT tickets are ever created**. An interim eligibility proxy from AutoPlant deployment status is
   required (see §5.6, §14).

---

## 1. Current FSM architecture

### 1.1 The pipeline as built (Issue 04 / Issue 05)

```
                         ┌──────────────────────────────────────────────────────────┐
                         │  TEST-ONLY (to be deleted): Book Dataset (Book8_fixed.csv) │
                         │  test/env/book8/{book8-dataset,book8-seeder,book8-source-  │
                         │  reader}.ts  →  seeds org + feeds a mock SourceReader      │
                         └──────────────────────────────────────────────────────────┘
                                                  │ (test wiring only)
                                                  ▼
  SOURCE_READER (DI token)  ──►  InMemorySourceReader([])   ◄── PROD binding today = EMPTY placeholder
  (source-reader.ts:48)          (source-reader.ts:55-68 / ingestion.module.ts:28)
                                                  │  readChunk(cursor, chunkSize): SourceChunk
                                                  ▼
  ┌───────────────────────────────────────────────────────────────────────────────────────────┐
  │  SnapshotIngestionWorker.run()            (snapshot-ingestion.worker.ts:50)                  │
  │   • startRun() → snapshot_runs(RUNNING)   (single-in-flight: advisory lock + partial-unique) │
  │   • loop: readChunk → per-chunk snapshot_run_chunks row → ingestChunk (retry ×3, backoff)    │
  │   • data_as_of = MAX(gps_datetime) of succeeded rows; NULL if run FAILED                     │
  │   • finishRun(status = SUCCESS | PARTIAL | FAILED)                                           │
  └───────────────────────────────────────────────────────────────────────────────────────────┘
                                                  │  SnapshotIngestionService.ingestChunk()
                                                  │  createMany({ skipDuplicates:true }) → ON CONFLICT DO NOTHING
                                                  ▼
                              ┌────────────────────────────────────┐
                              │  raw_device_snapshots (partitioned) │  UNIQUE(device_id, gps_datetime)
                              │  schema.prisma:1102-1130            │  RANGE-partitioned monthly by gps_datetime
                              └────────────────────────────────────┘
                                                  │  DeviceStateService.recompute(now)  ← SEPARATE step
                                                  │  (device-state.service.ts:34) — NOT called by the worker
                                                  ▼
   MAX(gps_datetime)/device  +  pgi_history  +  non_operational_markings  +  device.currentVehicle
                                                  ▼
                              ┌────────────────────────────────────┐
                              │  device_states (1 row/device)       │  latest_gps_datetime, is_inactive,
                              │  schema.prisma:1477-1498            │  inactivity_hours, sla_bucket,
                              │                                     │  eligible_for_uptime, has_open_failure_cycle,
                              │                                     │  vehicle_id/plant_id/company_id/transporter_id
                              └────────────────────────────────────┘
             ┌─────────────────────────┬───────────────────────┬───────────────────────────┐
             ▼                         ▼                       ▼                           ▼
   TicketCreationService     DashboardService          RecommenderService          Reports / Device Detail
   createForInactive         zoneOverview /            runForZone → canonical      (downtime, root cause,
   Eligible (opens Failure   companyPlantOverview /    sort + scoring → Batch      fleet uptime) + SE Mobile
   Cycle + TROUBLESHOOT      criticalQueue             Assignment → Day Plan       (Technical Hints, Ticket
   Ticket)                   (data-as-of banner)       (Formal Assignments)        Detail telemetry)
```

### 1.2 Key facts about the current build (evidence)

- **`SourceReader` contract** (`source-reader.ts:15-48`): one method `readChunk(cursor: string|null, chunkSize:
  number): Promise<SourceChunk>`, where `SourceChunk = { rows: SourceSnapshotRow[]; nextCursor: string|null }`
  and `nextCursor === null` means *source exhausted*. The cursor is **opaque** to the worker.
- **`SourceSnapshotRow`** (`source-reader.ts:15-34`) — the post-normalization shape. Load-bearing fields:
  `deviceId: bigint`, `gpsDatetime: Date` (UTC). 16 more nullable telemetry fields (`lat, lon, mainsStatus,
  mainsVoltage, gpsValidity, gpsMode, ignitionStatus, speed, creg, cgreg, csq, ipAddress, portNo,
  simSubscriberName, unitNo, deviceType`) — **stored verbatim, read by no downstream consumer** (agent-verified).
- **Normalization** (`normalize.ts:24-42`): `normalizeGpsTimestamp(wallClock, sourceUtcOffsetMinutes)` converts a
  naive source wall-clock to a true UTC instant. Default source offset = **IST +330**. Only the timestamp is
  transformed; telemetry is preserved verbatim.
- **Worker** (`snapshot-ingestion.worker.ts:50-133`): `chunkSize=1000`, `maxAttempts=3`, `retryDelayMs=200`
  (exponential backoff). A failing chunk is retried and does **not** abort siblings. Run status =
  `SUCCESS` (0 failed) / `PARTIAL` (some) / `FAILED` (all). **The worker always starts `cursor = null`
  (full drain) and never consumes the persisted cursor** — incremental resume is not wired.
- **Run lifecycle** (`snapshot-run.service.ts:26-63`): `startRun()` guards single-in-flight with
  `pg_try_advisory_xact_lock(hashtext('snapshot_run'))` **and** a partial-unique index
  `(status) WHERE status='RUNNING'`; both map to `409 RUN_IN_PROGRESS`. `finishRun` writes `status`,
  `finished_at`, `data_as_of`, `cursor`.
- **Idempotency** (`snapshot-ingestion.service.ts:24-52`): `raw_device_snapshots` `@@unique([deviceId,
  gpsDatetime])` + `createMany({ skipDuplicates:true })` (`ON CONFLICT DO NOTHING`). Re-processing a chunk
  inserts nothing the second time.
- **`data_as_of`** = high-water `gps_datetime` across successfully-ingested rows; **NULL on a fully FAILED run**
  "so the dashboard banner never advances on bad data". Read by `SnapshotQueryService.latest()`
  (`snapshot-query.service.ts:44-57`) → `GET /api/snapshots/latest`.
- **Trigger:** `POST /api/snapshots/run`, `@Roles('OPERATIONS_HEAD')` (`snapshots.controller.ts:48-54`). **No cron
  / BullMQ anywhere** — every "job" (ingestion, device-state recompute, ticket creation, recommender, batch
  dispatch, verification sweep, report rollups) is an on-demand method with no orchestrator.

### 1.3 The downstream contract (what AutoPlant must ultimately satisfy)

Downstream consumers read **`device_states`**, not raw telemetry. From `raw_device_snapshots` the recompute uses
**only `device_id` + `gps_datetime`**. The `device_states` fields every consumer depends on:

| `device_states` field | Read by | Consequence if wrong / null |
|---|---|---|
| `latest_gps_datetime` | recompute (drives all), `criticalQueue`, recommender sort | Null → device treated ACTIVE, never inactive/ticketed/rankable |
| `is_inactive` | all dashboards, ticket creation | Gates queue visibility + ticketing |
| `sla_bucket` | dashboards, recommender (**hard requirement** — null ⇒ ticket unrankable) | Null → excluded from queues **and** recommendations |
| `inactivity_hours` | recommender PREVENTIVE age-bias | Age scoring only |
| `eligible_for_uptime` | ticket creation | False → **no ticket ever created** |
| `has_open_failure_cycle` | ticket creation | Prevents duplicate cycles |
| `plant_id`, `company_id` | dashboard rollups + ticket creation | Null → excluded from rollups **and** never ticketed |
| `vehicle_id`, `transporter_id` | denormalized onto tickets | Ticket field metadata |

> **Denominator rule (agent-verified):** `dashboard.zoneOverview` counts **all** `device_states` rows for
> `totalDevices` — so AutoPlant must produce a `device_states` row for **active** devices too, not only inactive
> ones. This means every tracked device needs at least one `raw_device_snapshots` row.

---

## 2. Current AutoPlant architecture (the source system)

AutoPlant is a MySQL fleet-telematics platform, **read-only** to FSM, reachable **only over the company VPN** at
host `10.0.0.25`. It exposes two databases relevant to FSM:

### 2.1 `ap_widgets` — live operational database

```
ap_widgets  (live state + telemetry; 54 tables)
   │
   ├── tb_vehiclemaster ───────────────► THE SNAPSHOT SOURCE (current-state, 1 row per vehicle_no)
   │      PK vehicle_no (varchar)         updated in place; NOT an append-only ping history
   │      device_id (varchar, nullable)   latest_gps_datetime, latitude, longitude, speed, course
   │      gpssignal (JSON)                IGNITION_STATUS, BATTERY_STATUS, MAIN_STATUS, DEVICE_TYPE, VENDOR
   │      insertion_datetime  ◄── ON UPDATE CURRENT_TIMESTAMP  → natural incremental CURSOR
   │      vehicle_deployment_status (ACTIVE/DEPLOYED/UNDEPLOYED), active_trip_id
   │      plant_id/plant_code/plant_name, transporter_id/code/name, LATEST_INSTALLATION_COMPANYID
   │
   ├── tb_tripmaster / tb_triplegwise / tb_trip_detention …  (trip lifecycle — LR/Next-Trip candidate, §12 note)
   ├── tb_alert / tb_alert_master_config …                   (alerting — out of scope v1)
   └── *_archival / *_bkp / *_logs / *_og                    (history/backups — DO NOT read)
```

**`tb_vehiclemaster` is a current-state master, not a telemetry history** (confirmed by prior discovery and the
one-row-per-`vehicle_no` PK). It carries both the *master mapping* (vehicle→device→plant→transporter→company +
deployment status) **and** the *latest telemetry* (`latest_gps_datetime`, lat/lon, `gpssignal` JSON). This is the
single table the existing seam already pings (`autoplant-mysql.client.ts:94`; `autoplant-ping.ts:33-34`).

**`gpssignal` JSON** (from sampled rows) nests the deep telemetry the FSM raw columns want, e.g.:
```json
{"epf": null, "rmc": null,
 "power":  {"mainstatus":"1","mainvoltage":"0","batterystatus":null,"batteryvoltage":"4056"},
 "idling": {"uid":"…","endlat":16.97,"endlon":82.27,"endtime":1782971844000,"startlat":…},
 "sensor": {"type":["temp","door","comp","fuel"],"compressor":"off",…}}
```
So `mains_status ← gpssignal.power.mainstatus`, `mains_voltage ← gpssignal.power.mainvoltage`, etc. Modem fields
(`creg/cgreg/csq/gps_validity/gps_mode`) are **not consistently present** in the sampled payloads and may be
partially unavailable — they are non-load-bearing (§1.3), so partial coverage is acceptable.

### 2.2 `ap_masters` — master database

```
ap_masters  (per-company master hierarchy)
   │
   ├── mst_company     PK company_id (int)      company_name, company_type (Shipper/Transporter/…), status, tier fields
   │        │                                    e.g. 1010=UTCL, 1012=SCL, 1014=JSW Cement, 1015=Vicat …
   │        ▼
   ├── mst_zone        PK zone_id (int)          company_id, zone_name (e.g. "North India"), status
   │        │            ▲ PER-COMPANY sales zone — NOT the FSM operational Zone
   │        ▼
   ├── mst_region      PK region_id (int)        company_id, zone_id, region_name (often a STATE), region_status
   │        │
   │        ▼
   ├── mst_plant       PK plant_id (int)         company_id, zone_id/zone_name, region_id/region_name,
   │        │            + PK plant_code          plant_name, plant_state, plant_district, status (ACTIVE/INACTIVE)
   │        ▼            e.g. 3038=Kadappa (Vicat), 4535=Rourkela Steel Plant …
   ├── mst_vehicle     PK vehicle_no (varchar)   device_id, plant_id, company_id, transporter_id, deployment_status,
   │                                              vehicle_status bit, hierarchy_path, mapping/installation dates
   │
   └── mst_transporter PK transporter_id (bigint) company_id, plant_id, transporter_code, transporter_name, status
```

**Relationship between the two databases:** `ap_masters` is the *authoritative registry* (who the companies /
plants / vehicles / transporters are), while `ap_widgets.tb_vehiclemaster` is the *live operational projection*
(the same vehicle→device→plant→transporter mapping **plus** current telemetry and deployment status). They share
natural keys: `vehicle_no`, `device_id`, `plant_id`, `transporter_id`, `company_id`. `tb_vehiclemaster` largely
denormalizes what `ap_masters` normalizes.

**Critical modelling truth:** AutoPlant's `company → zone → region → plant` is a **per-customer** hierarchy — every
customer company (`mst_company`) owns its *own* zones and regions (`mst_zone.company_id`, `mst_region.company_id`).
`mst_zone.zone_name` values are things like *"North India"/"South India"* scoped to one company; `mst_region` rows
are effectively **states**. This is **not** the FSM operational Zone (a single ops-team partition of India for
field engineers). See §3 and §5.2 for how this is reconciled.

---

## 3. Data ownership

The governing principle (per `CONTEXT.md`): **FSM is the system of record; AutoPlant is a source system.** FSM
mirrors AutoPlant's *fleet reality* but **owns all operational/field-service domain data** layered on top.

### 3.1 AutoPlant-owned (mirrored into FSM, read-only, never written back)

| Domain object | AutoPlant source | Why AutoPlant owns it |
|---|---|---|
| Customer **Company** identity | `mst_company` | AutoPlant is the CRM/telematics registry of customers |
| **Plant** (physical site) identity + address + status | `mst_plant` | Plants are AutoPlant-registered customer sites |
| **Vehicle** identity + attributes | `mst_vehicle` / `tb_vehiclemaster` | Vehicles are registered/operated in AutoPlant |
| **Device** identity (`device_id`), type, vendor | `tb_vehiclemaster.device_id` / `mst_vehicle` | GPS devices are provisioned in AutoPlant |
| **Transporter** identity | `mst_transporter` | Logistics operators are AutoPlant-registered |
| Vehicle↔Device↔Plant↔Transporter↔Company **mapping** | `tb_vehiclemaster` / `mst_vehicle` | AutoPlant is the fitment/deployment authority |
| **Telemetry** (`latest_gps_datetime`, lat/lon, power, ignition, `gpssignal`) | `tb_vehiclemaster` | GPS pings land in AutoPlant |
| **Deployment status** (ACTIVE/DEPLOYED/UNDEPLOYED), `active_trip_id` | `tb_vehiclemaster` | AutoPlant tracks operational state |

### 3.2 FSM-owned (never sourced from AutoPlant; must survive every sync)

| Domain object | FSM home (table) | Note |
|---|---|---|
| **Operational Zone → Zonal-Manager authority** | `zones`, `zones.zonal_manager_user_id`, `users.zone_id` | FSM ops partition; **not** `mst_zone` |
| **Plant → FSM-Zone assignment** | `plants.zone_id` (FK) | FSM decides which ops Zone a synced plant belongs to |
| **Service Engineers** + profiles | `engineer_master` | "SE schema not present in AutoPlant" (per your brief) |
| **SE Coverage** (Dedicated/Multi-Plant) | `se_coverage` | Plant responsibility mapping |
| **SE Territory** (Floating) + polygon | `engineer_territory_coverage`, `plant_eligible_floating_se` (MV) | Hierarchical + PostGIS coverage |
| **Tickets, Failure Cycles, Recommendations, Batches, Day Plans** | `tickets`, `failure_cycles`, … | Core field-service workflow |
| **Component Requests, Inventory, Shadow Use, Van Stock** | `component_requests`, `inventory_transactions`, … | Warehouse/parts domain |
| **Verification runs, Non-Op markings, Recovery/Install/Expense** | `verification_runs`, `non_operational_markings`, … | Governance |
| **User accounts, RBAC, acting-role attribution, audit logs** | `users`, `audit_logs` | Security |
| **Company tier / priority overrides** | `company_master.ops_override`, `company_tier`, `company_priority_rank` | Ops-Head override authority |
| **Deal Type** (RECURRING/ONE_TIME) | `devices.deal_type` | FSM tag (proxy for CRM/SAP until integrated) |
| **Derived state** (`device_states`), summaries/MVs | `device_states`, `*_summary_*` | Computed by FSM from mirrored + owned data |

### 3.3 Why this split (rationale)

- **AutoPlant is the truth of *what exists in the field*** (which device is on which vehicle at which plant). FSM
  must not invent or mutate that — it would drift from the physical fleet and from AutoPlant's own reporting.
- **FSM is the truth of *how the field-service organisation operates*** (who covers what, what work is open, who
  did it). AutoPlant has no concept of Service Engineers, tickets, SLA, or coverage — those are FSM inventions.
- **Organizational hierarchy ≠ Operational ownership (CHANGED — Rev 3).** These are **separate concerns with
  different owners and different cardinality**:
  - *Organizational hierarchy* (`company → zone → region → plant → state/district`) is **AutoPlant-owned and
    authoritative** in `mst_plant` (per the AutoPlant DB team). FSM **mirrors it faithfully** — company + plant
    identity plus AutoPlant's zone/region/state/district as **source attributes** on `plants`
    (`source_zone_id/name`, `source_region_id/name`, `plant_state`, `plant_district`). AutoPlant's zone is
    **per-company** (`mst_zone.company_id`).
  - *Operational ownership* — the FSM **Zone** (ZM authority + RBAC row-scope), SE mapping, coverage, batches,
    recommendations, tickets — is **FSM-owned**. FSM's Zone is a **cross-company** partition (~4 zones, one ZM each,
    spanning many customers' plants). It **cannot** be AutoPlant's per-company zone (that would create thousands of
    zones and break one-ZM-per-zone). Evidence: `Zone` has no `company_id`; ZM scope compares JWT `zone_id` to
    `plant.zone_id`; a company spans zones (ADR-0018).
  - **Therefore** `plants.zone_id` = the FSM *operational* zone, **auto-derived from the authoritative `plant_state`
    via an FSM-owned `state → zone` map** (cross-checked against `source_zone_name`, Ops-Head overrides exceptions)
    — *not* a copy of `mst_plant.zone_id`, and *not* manual per-plant classification. Full analysis:
    `docs/architecture/zone-architecture-investigation.md` §Revision 3.

---

## 4. Production data flow (target)

```
        VPN (private) ───────────────► AutoPlant MySQL @ 10.0.0.25  (READ-ONLY)
                                        ├── ap_masters  (mst_company/zone/region/plant/vehicle/transporter)
                                        └── ap_widgets  (tb_vehiclemaster + gpssignal telemetry)
                                                     │
        ┌────────────────────────────────────────────┴───────────────────────────────────────────┐
        ▼                                                                                          ▼
 ┌─────────────────────────────┐                                              ┌──────────────────────────────────┐
 │  MasterSyncService (NEW)    │                                              │  AutoPlantSourceReader (NEW)      │
 │  reads ap_masters + the     │                                              │  implements SourceReader          │
 │  master columns of          │                                              │  reads ap_widgets.tb_vehiclemaster │
 │  tb_vehiclemaster           │                                              │  + gpssignal JSON, chunked+cursor  │
 │  upsert by source-id maps   │                                              │  normalizeSourceRow() IST→UTC      │
 └─────────────┬───────────────┘                                              └──────────────────┬───────────────┘
               │ upsert (company/plant/transporter/vehicle/device masters)                        │ readChunk()
               ▼                                                                                   ▼
 ┌─────────────────────────────────────────────┐                          ┌──────────────────────────────────────┐
 │  FSM PostgreSQL — MASTERS                    │                          │  SnapshotIngestionWorker (existing)   │
 │  company_master, plants, transporters(NEW),  │  ── FK prerequisite ──►  │  → raw_device_snapshots               │
 │  vehicles, devices  (+ source_*_id columns)  │  (masters must exist     │  → snapshot_runs.data_as_of           │
 └─────────────────────────────────────────────┘   before device_states)  └──────────────────┬───────────────────┘
               ▲ preserved, never overwritten                                                  │
               │  FSM-owned overlay: zones, se_coverage, territory MV, dealType, opsOverride    ▼
               │                                              ┌──────────────────────────────────────────────────┐
               │                                              │  DeviceStateService.recompute(now) (existing)     │
               │                                              │  → device_states (per device)                     │
               │                                              └──────────────────┬───────────────────────────────┘
               │                                                                 ▼
               │        ┌────────────────────────┬───────────────────────┬──────────────────────────┐
               │        ▼                        ▼                       ▼                          ▼
               │  TicketCreationService   DashboardService         RecommenderService         Reports / Mobile
               │  (Failure Cycle +        (queues + data-as-of      (canonical sort +          (Technical Hints,
               │   TROUBLESHOOT Ticket)    banner)                   scoring → Day Plan)        Device Detail)
               │
        ┌──────┴─────────────────────────────────────────────────────────────────────────────────────────┐
        │  IntegrationSchedulerService (NEW) orchestrates cadence:                                          │
        │   master-sync (daily) → snapshot ingestion (e.g. every 15–30 min) → device-state recompute       │
        │   → ticket creation → recommender/batch dispatch. Health/connectivity monitored (§9).            │
        └──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**New components (bold) vs reused (existing):** `MasterSyncService`, `AutoPlantSourceReader`,
`IntegrationSchedulerService`, `transporters` table, and `source_*_id` columns are **new**. The
`SnapshotIngestionWorker`, `SnapshotIngestionService`, `SnapshotRunService`, `DeviceStateService`,
`TicketCreationService`, `DashboardService`, `RecommenderService`, and `AutoPlantMysqlClient` are **reused
unchanged** (except the device-id type change in §7 and the worker cursor-resume fix in §6).

---

## 5. Master synchronization design

### 5.1 Goal

Replace the two seed paths (`org-seed.ts` synthetic seed + `book8-seeder.ts` CSV seed) with a **`MasterSyncService`**
that upserts FSM masters from AutoPlant, keyed by **added source-id columns**, while **preserving all FSM-owned
overlay data** (zones/ZM mapping, SE coverage/territory, dealType/opsOverride tags).

### 5.2 Entity-by-entity mapping

| AutoPlant source | FSM target | Match key (added) | Sync rule |
|---|---|---|---|
| `mst_company` (company_id, company_name, company_type, status) | `company_master` | `company_master.source_company_id = mst_company.company_id` | Upsert customer companies (typically `company_type` in the shipper/customer set, `status='ACTIVE'`). `company_tier`/`priority_rank` default on insert; **never overwrite `ops_override`, tier, or rank on update** (FSM-owned). |
| `mst_plant` (plant_id, company_id, plant_name, plant_state, plant_district, region_name, status) | `plants` | `plants.source_plant_id = mst_plant.plant_id` | Upsert name + `company_id` (via company source-map). **CHANGED (Rev 3):** `mst_plant` is the **authoritative** hierarchy master — mirror it faithfully. Store its org hierarchy as **source attributes on `plants`**: `source_plant_id`, `source_zone_id`, `source_zone_name`, `source_region_id`, `source_region_name`, `plant_state`, `plant_district`, `master_plant_id/code`, `status`. Then **`plants.zone_id` = the FSM *operational* zone** (a cross-company ZM-authority partition, **not** AutoPlant's per-company zone): auto-derived from the authoritative `plant_state` via an FSM-owned `state → zone` map, **cross-checked against `source_zone_name`**, unmappable → `UNZONED` holding zone + Ops-Head exception queue; an Ops-Head override is **never overwritten** by re-sync. See `zone-architecture-investigation.md` §Revision 3. Set `plants.district_id` by matching `plant_district`/`plant_state` to FSM `districts`. |
| `mst_transporter` (transporter_id, company_id, transporter_name, status) | **`transporters` (NEW table)** | `transporters.source_transporter_id = mst_transporter.transporter_id` | Upsert; provides the FK target the schema currently lacks. |
| `mst_vehicle` / `tb_vehiclemaster` (vehicle_no, plant_id, company_id, transporter_id) | `vehicles` | `vehicles.vehicle_no` (existing `@unique`) | Upsert; resolve `plant_id`/`company_id`/`transporter_id` FKs via the source-id maps. |
| `tb_vehiclemaster.device_id` (+ DEVICE_TYPE, VENDOR) | `devices` | `devices.source_device_id` (String; see §7) | Upsert device identity + `device_type`; set `current_vehicle_id` from the fitment. **Never overwrite `deal_type`** (FSM tag). |

> **Company tier/rank gap (important).** AutoPlant `mst_company` carries **no `company_tier` and no
> `company_priority_rank`** — only `company_type` (Shipper/Transporter/…) and `status`. But those two fields are
> the **top-level gates of the Recommender canonical sort** (`CONTEXT.md` §Company Tier / §Company Priority Rank;
> ADR-0003 / ADR-0017). Therefore tier/rank are **CRM/SAP- or Ops-Head-owned**, never sourced from AutoPlant. The
> sync sets a safe default (e.g. `SILVER`/`C`) on **insert only** and leaves `ops_override`/tier/rank untouched on
> update. Until a CRM/SAP tier feed exists, Operations Head must seed/override tiers or all companies rank equally
> — a business-rule item to flag (§14 R13).

**Not synced from AutoPlant (kept FSM-owned):** `zones` and `zonal_manager_user_id`, `regions`/`districts`
reference geography (FSM's Indian-admin geography for Floating-SE territory — separate from AutoPlant's per-company
`mst_region`), `se_coverage`, `engineer_master`, `engineer_territory_coverage`, `plant_eligible_floating_se`.

### 5.3 Upsert strategy

- **Deterministic upsert by source id.** Every synced master gets a `source_*_id` column with a `@@unique`
  constraint; the sync does `INSERT … ON CONFLICT (source_*_id) DO UPDATE SET <mirrored columns>`. FSM-owned
  columns are **excluded from the `DO UPDATE SET`** list (insert-only defaults), so a re-sync never clobbers ops
  data.
- **Ordered by FK dependency** (same order the book seeder proved out): companies → transporters → plants →
  vehicles → devices. Vehicles require an existing plant + company; plants require an FSM Zone assignment; devices
  require nothing but attach `current_vehicle_id` when the vehicle exists.
- **Stable ids.** FSM surrogate PKs (`company_id`, `plant_id`, …) remain stable across syncs (keyed by
  `source_*_id`), so the FSM-owned overlay FKs (`se_coverage.plant_id`, `engineer_master.zone_id`,
  `device_states.*`) never break.

### 5.4 Conflict handling

- **FSM-owned vs mirrored collision:** resolved structurally — mirrored columns are updated; FSM-owned columns
  (`zone_id`, `deal_type`, `ops_override`, tier/rank, coverage) are never in the update set.
- **Name/attribute drift:** AutoPlant wins for mirrored attributes (name, address, status, fitment). An audit row
  records material changes (e.g. a device re-mapped to a different vehicle/plant).
- **Duplicate/ambiguous source rows:** AutoPlant has archival/`_bkp`/`_log` tables — the sync reads **only** the
  canonical `mst_*` and `tb_vehiclemaster`, never `*_archival`/`*_bkp`/`*_og`/`*_logs`.

### 5.5 Deleted & inactive records

- **AutoPlant is read-only and rarely hard-deletes** (it archives). The sync **must not hard-delete** FSM rows on
  a missing source row (a plant/vehicle absent from one incremental page is not a deletion).
- **Soft state via `status`:** `mst_company.status`, `mst_plant.status`, `mst_transporter.status`,
  `mst_vehicle.vehicle_status`/`deployment_status` carry ACTIVE/INACTIVE. Mirror these to an FSM `status`/`active`
  flag (recommended new nullable column) rather than deleting. `INACTIVE` plants/vehicles remain in FSM for
  historical tickets/reports but are excluded from active dashboards and ticketing by filtering on the mirrored
  status.
- **Reconciliation sweep (full sync):** the periodic *full* master sync (§5.7) can flag FSM rows whose
  `source_*_id` is no longer present/active in AutoPlant as `stale`/`inactive` for Ops-Head review — never an
  automatic destructive delete.

### 5.6 Interim eligibility (critical — no PGI source in AutoPlant)

`device_states.eligible_for_uptime` needs a PGI signal (`pgi_history`, from SAP) that AutoPlant does not supply.
Until SAP PGI integration lands, recommend an **interim eligibility proxy** derived during master-sync/ingestion:
treat a device as *commercially active* when `tb_vehiclemaster.vehicle_deployment_status ∈ {ACTIVE, DEPLOYED}`
(and/or a recent `active_trip_id`), writing a synthetic `pgi_history` row (or a dedicated
`eligibility_source='AUTOPLANT_DEPLOYMENT'` flag) so `isEligibleForUptime()` (`eligibility.ts:15`) returns true for
deployed devices. **This is a business-rule decision (Strategic HITL) — must be approved** because it changes what
counts toward Fleet Uptime and what gets ticketed. Alternative: relax the ticketing gate for a bootstrap window.
See §14 risk R7.

### 5.7 Frequency, error recovery

- **Cadence:** master data changes slowly → **full master sync daily** (off-peak), plus optional **incremental
  delta** hourly using `mst_vehicle.record_updated_date` / `mst_plant.updated_date_time` where available.
- **Chunked reads** (e.g. 1–5k rows/page) to bound memory and MySQL load; `connectionLimit:4` pool already caps
  concurrency (`autoplant-mysql.client.ts:69`).
- **Error recovery:** wrap each entity phase in its own try/catch; a failed phase does not roll back earlier
  successful upserts (they are idempotent). Record a `master_sync_runs` row (mirroring the `snapshot_runs` pattern)
  with per-entity counts + status for observability. Re-run is safe (idempotent upserts).
- **VPN/connectivity failure:** master sync aborts cleanly, leaves last-good masters intact, and surfaces on the
  health monitor (§9). No partial destructive writes.

---

## 6. Snapshot synchronization design

### 6.1 Flow

```
tb_vehiclemaster (+ gpssignal JSON)
      │  AutoPlantSourceReader.readChunk(cursor, chunkSize)   [NEW — implements SourceReader]
      │    • SELECT … FROM tb_vehiclemaster WHERE insertion_datetime > :cursor
      │      ORDER BY insertion_datetime, vehicle_no  LIMIT :chunkSize
      │    • dateStrings:true → parse gpssignal JSON → build RawSourceRow
      │    • normalizeSourceRow(raw, sourceUtcOffsetMinutes=330)  [reuse normalize.ts]
      ▼
SourceSnapshotRow[] (UTC gpsDatetime)
      │  SnapshotIngestionWorker.run()  [reuse, unchanged except cursor-resume fix]
      ▼
raw_device_snapshots  (ON CONFLICT(device_id,gps_datetime) DO NOTHING)  [reuse]
      │  DeviceStateService.recompute(now)  [reuse]
      ▼
device_states → dashboards / recommender / ticketing
```

### 6.2 Cursor strategy

- **Cursor = a composite keyset watermark `(gps_datetime, device_id)`** — this is exactly the design already
  specified in `.scratch/fsm-platform-v1/ARCHITECTURE-REMEDIATION-PLAN.md` **R10**: resume from the last
  SUCCESS/PARTIAL run's cursor, read `WHERE gps_datetime > ? ORDER BY gps_datetime, device_id LIMIT ?`, with the
  composite key so boundary-tie rows are never dropped, plus a periodic off-peak `fullScan` reconciliation. Encode
  the opaque `nextCursor` as `"<gps_datetime ISO>|<device_id>"`. **Do not diverge from R10** — align to it.
  - *Alternative considered:* `tb_vehiclemaster.insertion_datetime` (`ON UPDATE CURRENT_TIMESTAMP`) advances on
    any row change (including a device re-mapping with no new ping), so it catches master mutations a `gps_datetime`
    watermark misses. But master re-mappings are handled by the **master sync** (§5), not the snapshot path, and
    the worker's `data_as_of`/`device_states` derivation both key on `gps_datetime` — so the R10 `gps_datetime`
    keyset is the correct, consistent choice for the snapshot reader. Because `tb_vehiclemaster` is a
    *current-state master* (one row/device), re-reads dedup to no-op inserts (R10, and §6.5).
- **`gps_datetime` for the snapshot row** = `normalizeGpsTimestamp(latest_gps_datetime, +330)`. Rows with a **NULL
  `latest_gps_datetime`** (device never pinged) are handled explicitly (§6.6).
- **Initial full backfill:** first run drains all rows (`WHERE insertion_datetime IS NOT NULL ORDER BY …`), so
  every device gets at least one `raw_device_snapshots` row and thus a `device_states` row (denominator rule,
  §1.3). Subsequent runs are incremental from the persisted cursor.

> **Worker fix required.** Today the worker always starts `cursor=null` and never reads the persisted
> `snapshot_runs.cursor` (`snapshot-ingestion.worker.ts:57`). For incremental production ingestion, either (a) the
> `AutoPlantSourceReader` loads the last successful `snapshot_runs.cursor` when the worker passes `cursor=null`, or
> (b) the worker is changed to seed the initial cursor from the last successful run. **Recommend (a)** — keeps the
> worker generic and the resume logic inside the reader. This is the one behavioural change to the existing worker
> path (besides the device-id type).

### 6.3 Incremental loading & chunk size

- Reuse the worker's `chunkSize=1000` default; tune to 1–2k after load testing against MySQL. `connectionLimit:4`
  bounds concurrent connections.
- Each chunk is an independent transaction on the FSM side (`createMany`), retried ×3 with backoff (existing).

### 6.4 Scheduling

- **No scheduler exists** — introduce `IntegrationSchedulerService` (§9) using `@nestjs/schedule` (lightweight) or
  BullMQ (if a job queue is wanted for retries/observability). Recommended cadence:
  - **Master sync:** daily full + optional hourly delta.
  - **Snapshot ingestion:** every **15–30 min** (aligns with the 24h inactivity threshold and SLA buckets; the
    `data-as-of` banner keeps managers honest about freshness).
  - **Chain:** snapshot ingestion → `DeviceStateService.recompute` → `TicketCreationService.createForInactiveEligible`
    → recommender/batch dispatch. This ordering exists in code but is currently unwired.
- Preserve the single-in-flight guard (advisory lock + partial-unique) so overlapping cron ticks 409 cleanly.

### 6.5 Idempotency, retry, failure handling

- **Idempotency:** unchanged — `@@unique([deviceId, gpsDatetime])` + `ON CONFLICT DO NOTHING`. Re-reading an
  unchanged `latest_gps_datetime` is a no-op insert.
- **Retry:** unchanged per-chunk retry ×3 with exponential backoff; a failed chunk does not abort the run
  (PARTIAL). `data_as_of` stays NULL on a fully FAILED run so the banner never advances on bad data.
- **Failure handling:** connectivity loss mid-run → the in-flight chunks fail → run finishes `PARTIAL`/`FAILED`;
  next scheduled run resumes from the last persisted cursor. No data corruption (idempotent).

### 6.6 Edge cases specific to AutoPlant data (from sampled rows)

- **NULL `device_id`** (vehicle with no fitted device): skip the snapshot row (no device to track) but the
  master-sync still records the vehicle. Log a per-run count.
- **`device_id == vehicle_no`** (third-party GPS, e.g. `AP03TC0959` VENDOR=WheelsEye): valid device — the String
  device key (§7) stores it. Track normally.
- **NULL `latest_gps_datetime`** (device never/long-ago pinged): decide policy — recommend **emit no
  `raw_device_snapshots` row** (nothing to record) but ensure a `device_states` row still exists via the master
  (so the device appears in the denominator). This needs a small `recompute` consideration (currently a device
  with no raw snapshot yields `latestGpsDatetime=null` → not inactive). **Flag for review:** should a
  never-pinging deployed device count as inactive? (Business rule — §14 R7.)
- **Future/stale `latest_gps_datetime`:** `inactivity_hours` is clamped ≥0 (`device-state.service.ts:64-67`), so
  clock skew is absorbed; but a bogus *future* timestamp would make a dead device look active. Add a sanity guard
  (reject `gps_datetime > now + skew`) in the reader.
- **Leading-zero / alphanumeric `device_id`:** the whole reason for §7. Preserve as an exact String.

---

## 7. FSM Prisma review (recommendations only — do NOT modify yet)

Legend: **C**=Critical (blocks production), **H**=High, **M**=Medium, **L**=Low.

| # | Sev | Current | Recommended | Reason / evidence |
|---|---|---|---|---|
| 1 | **C** | `Device.deviceId BigInt @id` (`schema.prisma:1430`); `SourceSnapshotRow.deviceId: bigint` (`source-reader.ts:16`); `raw_device_snapshots.device_id BigInt` (`:1105`); `device_states.device_id BigInt` (`:1478`); same on `failure_cycles`, `tickets`, `verification_runs`, `pgi_history`, `non_operational_markings`, `device_downtime_summary_monthly` | **Change device identity to `String`** (source device_id/serial) across all these tables and the `SourceReader`/`normalize` types. Preserve leading zeros; allow alphanumerics/vendor ids. | AutoPlant `device_id` is `varchar(255)`; real data has `0869925073271551` (leading zero), `AP03TC0959` (alphanumeric), and NULLs. BigInt corrupts/omits them. Greenfield (book data being deleted, no prod rows) makes the migration low-risk. |
| 1a | **C** | *(alternative to #1)* | If a numeric PK must be kept, add surrogate `device_pk BigInt @default(autoincrement()) @id` **+** `source_device_id String @unique`, and repoint all device FKs to the surrogate. | Higher blast radius (every device FK repoints). **#1 (String key) is simpler and recommended** for greenfield. |
| 2 | **C** | No `transporters` table; `Vehicle.transporterId BigInt?` bare, no FK (`schema.prisma:1457`; comment 1450-1452); denormalized `device_states.transporter_id` | **Add `transporters` table** (`transporter_id` PK, `source_transporter_id String/BigInt @unique`, `name`, `company_id`, `status`) and FK `vehicles.transporter_id → transporters`. | `mst_transporter` exists and Ticket Detail needs Transporter name/contact (`CONTEXT.md` — SE contacts Transporter). **Already designed** in the LLD (`fsm-backend-low-level-design.md:155`) but never built in Prisma. |
| 3 | **C** | No `source_*_id` columns anywhere on Company/Plant/Vehicle/Device | **Add `source_company_id`, `source_plant_id`, `source_transporter_id`, `source_device_id`** (each `@unique`). `Vehicle` reuses existing `vehicle_no @unique` as its source key. | Master-sync upserts must be keyed to AutoPlant ids for stable, idempotent reconciliation (§5.3). None exist today (`Company.source` is free-text only, `:63`). |
| 3a | **H** *(new — Rev 3)* | `plants` stores only `name` + FSM `zone_id`; no org-hierarchy attributes from the **authoritative** `mst_plant` | **Add org-hierarchy source attributes to `plants`**: `source_zone_id`, `source_zone_name`, `source_region_id`, `source_region_name`, `plant_state`, `plant_district`, `master_plant_id`, `master_plant_code`, `status`. **Clarify** `plants.zone_id` semantics = FSM *operational* zone (derived + override), **not** `mst_plant.zone_id`. `zones` table shape unchanged. | `mst_plant` is authoritative and denormalized — mirror it faithfully (single-table read) for audit, reporting drill-down, Floating-SE district resolution, and to drive/ cross-check the operational-zone derivation. See `zone-architecture-investigation.md` §Revision 3 (R3.4). |
| 4 | **H** | `plants` has no mirrored `status`; `company_master`, `vehicles`, `devices` likewise | **Add nullable `status`/`active` mirror columns** for company/plant/vehicle/device. | AutoPlant `status`/`deployment_status`/`vehicle_status` drive active-vs-inactive filtering without deleting rows (§5.5). |
| 4a | **H** *(Rev 3)* | `company_master` has **no `company_type`** (`schema.prisma:57-73`) | **Add `company_type String?`** (Shipper/Transporter/…). | `mst_company` mixes shippers **and** transporters; FSM `Company` must be the customer/shipper only (transporters → `transporters` table). Needed for the **scoping filter** — see Risk R14 and `zone-architecture-investigation.md` R3.8/R3.10. |
| 5 | **H** | `eligible_for_uptime` depends on `pgi_history` (SAP) which AutoPlant lacks | **Add an eligibility-source mechanism** (either seed synthetic `pgi_history` from deployment status, or add `device_states.eligibility_source`) — see §5.6. | Without it, `eligible_for_uptime=false` → **zero tickets** (`ticket-creation.service.ts:29-37`). Business-rule sign-off required. |
| 6 | **M** | `Device.currentVehicleId` denormalized only; `vehicle_device_mappings` history deferred (comment `:1428`) | Consider the time-windowed mapping table when historical re-fitment reporting is needed. Not required for v1 ingestion. | AutoPlant re-maps devices across vehicles (`INSTALLATION_REMARK='Re-Mapping'`); history has no home yet. |
| 7 | **M** | `RawDeviceSnapshot.device_id` has no FK to `devices` (`:1105`) | Keep as-is (intentional for partition/volume), but ensure **master-sync runs before ingestion** so `device_states` denormalization resolves. | Ingestion can land pings for devices not yet in `devices`; order matters (§4). |
| 8 | **M** | Config `AutoPlantMysqlConfig` single `database` (`autoplant-mysql.client.ts:22`) | **Support two schemas** (`ap_widgets` + `ap_masters`) — either two configs/pools or schema-qualified queries on one connection. | Discovery: masters and telemetry live in different databases (§0.2). |
| 9 | **L** | `snapshot_runs.cursor` written but not consumed (`worker:57`) | Implement cursor-resume in `AutoPlantSourceReader` (§6.2). | Incremental ingestion needs it. |
| 10 | **L** | No `master_sync_runs` table | Add one (mirror `snapshot_runs`) for master-sync observability. | Operational visibility of sync health (§5.7, §9). |

> **Do not modify Prisma until these are approved.** The device-id change (#1) is a coordinated migration touching
> ~8 models and the ingestion types; it must be sequenced first (Phase 2) because everything else depends on it.

---

## 8. FSM module review (reuse / extend / replace / remove)

| Module / file | Verdict | Action |
|---|---|---|
| `ingestion/autoplant/autoplant-mysql.client.ts` | **Extend** | Add two-schema support (§7 #8); keep the read-only guard + lazy pool. It already proves connectivity (`ping()`). |
| `ingestion/source-reader.ts` (`InMemorySourceReader`, `SOURCE_READER`) | **Extend** | Add `AutoPlantSourceReader implements SourceReader`; change `SourceSnapshotRow.deviceId` to `string` (§7 #1). Keep `InMemorySourceReader` for tests. Rebind `SOURCE_READER` in `ingestion.module.ts:28`. |
| `ingestion/normalize.ts` | **Reuse** | Reuse `normalizeSourceRow`/`normalizeGpsTimestamp` verbatim (IST +330). Only the `deviceId` type flows through. |
| `ingestion/snapshot-ingestion.worker.ts` | **Extend (minimal)** | Cursor-resume fix (§6.2) — or push resume into the reader (recommended, zero worker change). Device-id type flows through. |
| `ingestion/snapshot-ingestion.service.ts` / `snapshot-run.service.ts` / `snapshot-query.service.ts` | **Reuse** | No change beyond the `device_id` type. Idempotency, run lifecycle, data-as-of all correct. |
| `device-state/device-state.service.ts` (+ `eligibility.ts`, `sla-bucket.ts`) | **Reuse / Extend** | Reuse recompute. Extend only for interim eligibility (§5.6) and the never-pinged-device policy (§6.6). |
| `org/org-seed.ts` | **Replace (dev-only keep)** | Superseded by `MasterSyncService` for company/plant/vehicle/device. Keep its **SLA rules / scoring weights / common kit** seeding (FSM-owned config, not in AutoPlant). |
| `org/geography.service.ts` + `regions`/`districts` reference data | **Reuse** | FSM-owned Indian-admin geography for Floating-SE territory. **Not** sourced from `mst_region`. Full ~700-district load remains a separate reference task. |
| `org` (companies/plants services) | **Extend** | Add `source_*_id` handling; ensure Ops-Head overrides (`ops_override`, tier, Zone assignment) survive sync. |
| Dashboard / Recommender / Ticketing / Scheduling / Verification modules | **Reuse** | Pure consumers of `device_states`; no change once the contract (§1.3) is satisfied. |
| Auth / RBAC / Org overlay (`engineer_master`, `se_coverage`, territory MV) | **Reuse (preserve)** | FSM-owned; must survive every sync (stable ids). |
| Environment configuration (`app.config.ts`, `.env.example`) | **Extend** | Two-schema AutoPlant config + scheduler cadences (§10). |
| `test/env/book8/*` (Book Dataset) | **Remove** (per your instruction) | Delete after `MasterSyncService` + `AutoPlantSourceReader` land. Keep a small fixture-based `SourceReader` test (or reuse `InMemorySourceReader`) so worker tests survive. |

---

## 9. New modules required

| New module / component | Responsibility |
|---|---|
| **`MasterSyncService`** (`ingestion/autoplant/master-sync.service.ts`) | Read `ap_masters` (+ master columns of `tb_vehiclemaster`); upsert `company_master`, `plants`, `transporters`, `vehicles`, `devices` by `source_*_id`, in FK order, preserving FSM-owned columns (§5). |
| **`AutoPlantSourceReader`** (`ingestion/autoplant/autoplant-source-reader.ts`) | `implements SourceReader`. Query `ap_widgets.tb_vehiclemaster` + parse `gpssignal`; build `RawSourceRow`; `normalizeSourceRow(+330)`; return chunked `SourceChunk` with the `insertion_datetime`-based opaque cursor; resume from last `snapshot_runs.cursor` (§6.2). |
| **`AutoPlantMappingLayer`** (mapping/transform helpers) | Pure functions: `mst_* → FSM` field maps, `gpssignal` JSON → telemetry columns, deployment-status → interim eligibility, status normalization. Unit-testable in isolation. |
| **`IntegrationSchedulerService`** (`ingestion/integration-scheduler.service.ts`) | Owns cadence + ordering: master-sync → snapshot → recompute → ticket-creation → recommender/dispatch. Uses `@nestjs/schedule` or BullMQ. Respects single-in-flight guards. |
| **`AutoPlantHealthService`** (`ingestion/autoplant/health.service.ts`) | Periodic `ping()` + last-sync/last-snapshot freshness; exposes `GET /api/integration/health` for Ops-Head; feeds the FAILED/stale alerting the dashboard already surfaces. |
| **`master_sync_runs` table + service** | Observability for master sync (per-entity counts, status), mirroring `snapshot_runs`. |
| *(config)* **Two-schema AutoPlant config** | `readAutoPlantMysqlConfig` returns pools/handles for both `ap_widgets` and `ap_masters` (§10). |

All new code lives under `apps/backend/src/ingestion/autoplant/` alongside the existing client, keeping the source
integration cohesive and behind the `SourceReader`/service seams the rest of the app already depends on.

---

## 10. Environment configuration

### 10.1 Variables (production)

```bash
# ── AutoPlant upstream — read-only MySQL, reachable ONLY over the company VPN ─────────────
AUTOPLANT_MYSQL_HOST=10.0.0.25
AUTOPLANT_MYSQL_PORT=3306
AUTOPLANT_MYSQL_USER=fsm_readonly            # least-privilege read-only account
AUTOPLANT_MYSQL_PASSWORD=<secret>            # never committed (ADR-0025)
AUTOPLANT_MYSQL_DB_WIDGETS=ap_widgets        # live telemetry (tb_vehiclemaster)
AUTOPLANT_MYSQL_DB_MASTERS=ap_masters        # master data (mst_*)
AUTOPLANT_MYSQL_SSL=false                    # "true" if the server enforces TLS

# ── Integration scheduling (new) ─────────────────────────────────────────────────────────
AUTOPLANT_MASTER_SYNC_CRON="0 2 * * *"       # daily full master sync (off-peak IST)
AUTOPLANT_SNAPSHOT_CRON="*/20 * * * *"       # snapshot ingestion cadence
AUTOPLANT_INGEST_CHUNK_SIZE=1000
AUTOPLANT_SOURCE_UTC_OFFSET_MIN=330          # IST; keep configurable
```

> **Config change from today:** the single `AUTOPLANT_MYSQL_DATABASE` (`autoplant-mysql.client.ts:31`,
> `.env.example:15`) is replaced by **two** database vars. `readAutoPlantMysqlConfig` and `AutoPlantMysqlConfig`
> gain `dbWidgets` + `dbMasters` (or the client accepts a per-query schema). Keep the "leave unset ⇒ app boots,
> stays on the in-memory reader" behaviour so dev/test/CI are unaffected.

### 10.2 Operational concerns

- **VPN:** the host `10.0.0.25` is private and only resolvable/reachable on the company VPN. Production runtime
  (and any CI smoke that actually connects) must have VPN egress; otherwise the app boots and stays on the mock
  reader (lazy pool, `autoplant-mysql.client.ts:50-58`). **Establishing VPN + read-only credentials is
  external-access HITL** (Strategic HITL per `docs/agents/workflow.md`).
- **Read-only credentials:** least-privilege MySQL user with `SELECT` only on `ap_widgets` + `ap_masters`. The
  client's `READ_ONLY_PREFIXES` guard (`autoplant-mysql.client.ts:43,84-87`) is defence-in-depth on top of DB
  grants — keep it.
- **Connection pooling:** existing `connectionLimit:4`, `waitForConnections:true`, `dateStrings:true`
  (`autoplant-mysql.client.ts:62-72`). Consider a slightly larger pool for concurrent master-sync + snapshot, but
  keep it modest to avoid loading the production source.
- **Timeouts:** add `connectTimeout` and a statement timeout; fail fast on VPN drop rather than hanging a run.
- **Retries:** transient MySQL/network errors retried at the chunk level (existing worker) and the sync-phase
  level (new). Never retry into a write — the guard forbids non-reads.
- **Health checks:** `AutoPlantHealthService.ping()` on a schedule; surface last successful master-sync + snapshot
  `data_as_of` to Ops-Head (the dashboard already renders a FAILED/stale banner).

---

## 11. Implementation order (phased roadmap)

Each phase: **Objective · Files · Modules · Tests · Acceptance · Rollback.** No phase ships production code until
this blueprint is approved.

### Phase 1 — Production architecture (this document)
- **Objective:** approved blueprint; confirm data ownership, mapping, schema deltas, business-rule sign-offs
  (interim eligibility §5.6, never-pinged policy §6.6, Zone assignment §5.2).
- **Files:** `docs/architecture/autoplant-production-integration.md`.
- **Tests:** N/A (review artifact). **Acceptance:** stakeholders approve §7 schema deltas and §5.6/§6.6 rules.
- **Rollback:** N/A.

### Phase 2 — Schema foundation (device-id String + source-ids + transporters)
- **Objective:** land the §7 Critical/High schema changes behind a migration.
- **Files:** `apps/backend/prisma/schema.prisma`; new migration; `source-reader.ts`/`normalize.ts` type change
  (`deviceId: string`); `snapshot-ingestion.service.ts` map.
- **Modules:** `transporters` model; `source_*_id` columns; mirrored `status`; `master_sync_runs`.
- **Tests:** migration applies on a clean DB; existing ingestion/device-state/dashboard unit + e2e suites pass with
  the String device key (update fixtures); `InMemorySourceReader` tests updated.
- **Acceptance:** full backend test suite green; `npx prisma migrate` clean; no BigInt device references remain.
- **Rollback:** revert migration + type change (greenfield — no prod data yet).

> **Remediation prerequisites (from `ARCHITECTURE-REMEDIATION-PLAN.md`).** The plan explicitly sequences **R2
> (crash-safe ingest), R3 (monthly partition maintenance), R4 (incremental `device_states.latest_gps_datetime`
> upsert), R10 (cursor-resume)** to **land *before* the real AutoPlant `SourceReader` is wired**. Fold these into
> Phase 2/3 rather than treating Phase 3 as greenfield.

### Phase 3 — AutoPlant SourceReader (telemetry)
- **Objective:** real `readChunk` over `tb_vehiclemaster` + `gpssignal`, cursor-resume (R10), IST→UTC.
- **Files:** `ingestion/autoplant/autoplant-source-reader.ts`, `…/mapping.ts`; extend
  `autoplant-mysql.client.ts` (two-schema); rebind `SOURCE_READER` in `ingestion.module.ts`.
- **Tests:** unit tests on the mapper (leading-zero/alphanumeric/NULL device_id, `gpssignal` parse, future-ts
  guard) with recorded sample rows; reader chunk/cursor tests against a fixture; `autoplant:ping` smoke (behind
  VPN, manual). **Acceptance:** against a VPN connection, a run drains `tb_vehiclemaster` into
  `raw_device_snapshots` with correct UTC timestamps and preserved device ids; re-run inserts 0 (idempotent).
- **Rollback:** rebind `SOURCE_READER` to `InMemorySourceReader([])`; app returns to today's behaviour.

### Phase 4 — Master synchronizer
- **Objective:** populate `company_master`/`plants`/`transporters`/`vehicles`/`devices` from AutoPlant, FSM-owned
  columns preserved.
- **Files:** `ingestion/autoplant/master-sync.service.ts`, mapping helpers; `master_sync_runs` service.
- **Tests:** upsert-by-source-id idempotency; FSM-owned columns (`zone_id`, `deal_type`, `ops_override`) unchanged
  on re-sync; FK order; inactive/deleted handling (no destructive delete). **Acceptance:** a full sync yields a
  consistent org graph; SE coverage/territory MV FKs still resolve; a second sync is a no-op on FSM-owned data.
- **Rollback:** disable the sync cron; masters remain at last-good state.

### Phase 5 — Device states (+ interim eligibility)
- **Objective:** `device_states` correct end-to-end from AutoPlant; interim eligibility live (if approved).
- **Files:** extend `device-state.service.ts`/`eligibility.ts` for §5.6/§6.6.
- **Tests:** recompute produces rows for active + inactive devices (denominator rule); SLA buckets match
  `SLA_BANDS`; eligibility proxy behaves per approval. **Acceptance:** `device_states` counts reconcile with
  AutoPlant deployed-device counts; buckets sane.
- **Rollback:** revert eligibility extension; recompute reverts to PGI-only gate.

### Phase 6 — Dashboard verification
- **Objective:** confirm consumers render correctly on real data.
- **Files:** none (verification). **Tests:** `zoneOverview`/`companyPlantOverview`/`criticalQueue` against synced
  data; data-as-of banner reflects real `latest_gps_datetime`. **Acceptance:** dashboards match AutoPlant reality;
  freshness banner accurate. **Rollback:** N/A (read-only).

### Phase 7 — Recommendation engine
- **Objective:** confirm canonical sort + scoring on real buckets/ages; wire the orchestration chain.
- **Files:** `IntegrationSchedulerService`. **Tests:** recommender excludes null-bucket tickets; ordering by
  tier→bucket→rank→oldest; chain runs snapshot→recompute→ticket→recommender in order. **Acceptance:** Day Plans
  populate from real inactive devices. **Rollback:** disable scheduler; revert to manual triggers.

### Phase 8 — Production validation
- **Objective:** end-to-end smoke on VPN; health/alerting; cutover from Book Dataset.
- **Files:** delete `test/env/book8/*` (keep a minimal fixture reader for worker tests). **Tests:** production
  smoke (§13); health endpoint; failure injection (VPN drop → PARTIAL/FAILED, banner correct). **Acceptance:** the
  full checklist (§15) is green. **Rollback:** feature-flag ingestion off (unset AutoPlant env → mock reader).

---

## 12. Exact file-level change checklist

| File | Action | Reason |
|---|---|---|
| `docs/architecture/autoplant-production-integration.md` | **Create** | This blueprint |
| `apps/backend/prisma/schema.prisma` | **Modify** | Device id → String; add `transporters`, `source_*_id`, mirrored `status`, `master_sync_runs` (§7) |
| `apps/backend/prisma/migrations/**` | **Create** | Migration for the above |
| `apps/backend/src/ingestion/source-reader.ts` | **Modify** | `SourceSnapshotRow.deviceId: string`; keep `InMemorySourceReader` |
| `apps/backend/src/ingestion/normalize.ts` | **Modify** | `deviceId` type flows through (timestamp logic unchanged) |
| `apps/backend/src/ingestion/snapshot-ingestion.service.ts` | **Modify** | Map String `deviceId` into `raw_device_snapshots` |
| `apps/backend/src/ingestion/snapshot-ingestion.worker.ts` | **Modify (minimal)** | Cursor-resume (or none, if reader owns resume — §6.2) |
| `apps/backend/src/ingestion/autoplant/autoplant-mysql.client.ts` | **Modify** | Two-schema config (`ap_widgets` + `ap_masters`); timeouts |
| `apps/backend/src/ingestion/autoplant/autoplant-source-reader.ts` | **Create** | Real `SourceReader` over `tb_vehiclemaster` |
| `apps/backend/src/ingestion/autoplant/mapping.ts` | **Create** | Pure AutoPlant→FSM field/JSON/status/eligibility maps |
| `apps/backend/src/ingestion/autoplant/master-sync.service.ts` | **Create** | Master synchronizer (§5) |
| `apps/backend/src/ingestion/autoplant/health.service.ts` | **Create** | Connectivity + freshness health |
| `apps/backend/src/ingestion/integration-scheduler.service.ts` | **Create** | Cadence + ordering orchestrator |
| `apps/backend/src/ingestion/ingestion.module.ts` | **Modify** | Rebind `SOURCE_READER` → `AutoPlantSourceReader`; register new providers |
| `apps/backend/src/device-state/device-state.service.ts` | **Modify** | Interim eligibility + never-pinged policy (if approved) |
| `apps/backend/src/device-state/eligibility.ts` | **Modify** | Eligibility-source hook (§5.6) |
| `apps/backend/src/org/org-seed.ts` | **Modify** | Drop company/plant/vehicle/device seeding; keep SLA/scoring/kit config |
| `apps/backend/src/app.module.ts` | **Modify** | Register scheduler/health; ensure module wiring |
| `apps/backend/.env.example` | **Modify** | Two-schema vars + scheduler cadences (§10) |
| `apps/backend/package.json` | **Modify** | Add `@nestjs/schedule` (or `bullmq`); keep `mysql2` (present) |
| `apps/backend/src/generated/prisma/**` | **Regenerate** | `prisma generate` after schema change |
| `apps/backend/test/env/book8/*` | **Delete** | Book Dataset retired (your instruction) — Phase 8 |
| `apps/backend/test/fixtures/csv-source-reader.ts` | **Keep/Adapt** | Retain a fixture `SourceReader` for worker tests post-book |
| Dashboard / Recommender / Ticketing / Verification / Scheduling services | **No change** | Pure `device_states` consumers |
| Auth / RBAC / `engineer_master` / `se_coverage` / territory MV | **No change (preserve)** | FSM-owned overlay |

---

## 13. Testing strategy

- **Unit tests**
  - Mapping layer: leading-zero (`0869925073271551`), alphanumeric (`AP03TC0959`), NULL `device_id`; NULL/future
    `latest_gps_datetime`; `gpssignal` JSON extraction (`power.mainstatus/mainvoltage`); IST→UTC (`normalize.ts`
    already tested — extend with AutoPlant-shaped inputs).
  - Master-sync upsert: idempotency by `source_*_id`; FSM-owned columns untouched on re-sync; FK order; inactive
    handling (no delete).
  - Interim eligibility proxy (deployment status → eligible).
- **Integration tests** (FSM Postgres, mock/fixture `SourceReader`)
  - snapshot → `raw_device_snapshots` (idempotent re-run = 0 inserts); recompute → `device_states` (rows for
    active + inactive); ticket creation from inactive+eligible; dashboard queries; recommender ordering.
  - Master-sync → org graph → coverage/territory MV FKs resolve.
- **Production smoke tests** (behind VPN, manual/gated)
  - `npm run autoplant:ping` (extend to both schemas); a bounded snapshot run (LIMIT) writes real rows with
    correct UTC + preserved device ids; `data_as_of` reflects real `latest_gps_datetime`.
- **Database validation:** row counts reconcile FSM vs AutoPlant (companies/plants/vehicles/devices active
  counts); no orphan FKs; `source_*_id` uniqueness holds.
- **Snapshot validation:** `(device_id, gps_datetime)` uniqueness; partition routing by month; PARTIAL/FAILED
  paths leave `data_as_of` correct (NULL on full FAIL).
- **Dashboard validation:** buckets/rollups/critical-queue match source reality; freshness banner accurate on
  SUCCESS/PARTIAL/FAILED.
- **Synchronization validation:** re-run master-sync = no FSM-owned drift; cursor-resume ingests only changed rows;
  scheduler ordering holds; single-in-flight guard 409s overlapping ticks.

---

## 14. Risks & mitigations

| # | Risk | Sev | Mitigation |
|---|---|---|---|
| R1 | **Device-id type mismatch** silently corrupts leading-zero/alphanumeric ids | **C** | §7 #1 String key; unit tests on exact id round-trip; do it in Phase 2 before anything depends on it |
| R2 | **No PGI source → zero tickets** (eligibility gate) | **C** | §5.6 interim proxy from deployment status; **business-rule HITL sign-off**; monitor ticket-creation counts post-cutover |
| R3 | **VPN connectivity** loss stalls/loses runs | **H** | Lazy pool + fail-fast timeouts; PARTIAL/FAILED semantics + cursor-resume; health monitor + banner; app stays on mock reader if unset |
| R4 | **Master-sync clobbers FSM-owned data** (Zone assignment, dealType, tier, coverage) | **H** | Structural: FSM-owned columns excluded from `DO UPDATE SET`; idempotency tests assert no drift |
| R5 | **Performance** — full scans of ~50k `tb_vehiclemaster` + master tables load production source | **H** | Incremental cursor by `insertion_datetime`; chunked reads; modest pool; off-peak master sync; statement timeouts |
| R6 | **Zone-model mismatch** — wrong plant→FSM-Zone assignment mis-scopes ZM authority/dashboards | **H** | **Auto-derive `plants.zone_id` from `plant_state` via an FSM-owned `state → zone` table** (do NOT copy AutoPlant `zone_name` — per-company/inconsistent); unmappable → `UNZONED` + Ops-Head exception queue; overrides never auto-overwritten. Validate data quality first with the read-only queries in `zone-architecture-investigation.md` §5 (esp. Q6 state↔zone consistency). |
| R7 | **Never-pinged / stale-timestamp devices** mis-classified (dead looks active or vice-versa) | **M** | §6.6 policy + future-ts guard + clamp; explicit business-rule decision on never-pinged deployed devices |
| R8 | **Data consistency** — ingestion lands device_id absent from `devices` | **M** | Master-sync before snapshot (ordering); `raw_device_snapshots` has no FK by design; recompute tolerates it |
| R9 | **Two-schema config regression** breaks dev/test boot | **M** | Preserve "unset ⇒ mock reader" behaviour; unit-test `readAutoPlantMysqlConfig` for both-set/partial/unset |
| R10 | **No scheduler today** — manual cadence, stale data | **M** | `IntegrationSchedulerService`; single-in-flight guards; data-as-of banner makes staleness visible |
| R11 | **Telemetry gaps** (`gpssignal` missing modem fields) | **L** | Non-load-bearing fields (§1.3); store what exists; Technical Hints degrade gracefully ("Telemetry unavailable") |
| R12 | **Rollback** after cutover | **L** | Feature-flag: unset AutoPlant env → app reverts to mock reader; migration revertible (greenfield) |
| R13 | **No company tier/rank in AutoPlant** → Recommender canonical sort degenerates (all companies equal) | **M** | Tier/rank are CRM/SAP- or Ops-Head-owned (§5.2); seed defaults + Ops-Head override; flag as business-rule until a CRM/SAP feed lands |
| R14 | **Master scoping undefined** — `mst_company`/`mst_plant` include transporters, INACTIVE, and test rows; mirroring verbatim pollutes FSM operations + Fleet-Uptime denominator | **H** | Apply a **scoping filter** (which companies/plants are FSM's fleet) — a **business rule**, not schema-derivable. Add `company_type`+`status` to filter; **open questions for AutoPlant + Ops Head** (`zone-architecture-investigation.md` R3.8/R3.10 Q1–Q2). Do not invent the rule. |

---

## 15. Final deliverable — implementation checklist

```
☐  Review & approve this architecture (data ownership, mapping, §7 schema deltas)
☐  Sign off business rules: interim eligibility (§5.6), never-pinged policy (§6.6), plant→FSM-Zone assignment (§5.2)
☐  Provision VPN egress + least-privilege read-only MySQL account on ap_widgets + ap_masters (external-access HITL)
☐  Validate Prisma deltas → migrate: device_id String, transporters, source_*_id, status mirrors, master_sync_runs
☐  Two-schema AutoPlant config + npm run autoplant:ping green on both schemas
☐  Build AutoPlant SourceReader (tb_vehiclemaster + gpssignal, IST→UTC, cursor-resume) → rebind SOURCE_READER
☐  Verify Snapshot ingestion (idempotent; UTC correct; device ids preserved; data_as_of accurate)
☐  Build Master Synchronizer (upsert by source-id; FSM-owned columns preserved; no destructive delete)
☐  Verify Master Data (row counts reconcile; SE coverage/territory MV FKs resolve; re-sync = no FSM drift)
☐  Verify Device States (rows for active + inactive; SLA buckets; eligibility proxy)
☐  Verify Dashboards (queues/rollups/critical-queue + freshness banner)
☐  Verify Recommendations (canonical sort + scoring; orchestration chain ordered)
☐  Wire IntegrationScheduler (master daily / snapshot 15–30 min → recompute → ticket → recommender)
☐  Health + alerting (connectivity + freshness); failure injection (VPN drop → PARTIAL/FAILED, banner correct)
☐  Retire Book Dataset (delete test/env/book8/*; keep a fixture SourceReader for worker tests)
☐  PRODUCTION READY
```

---

### Appendix A — evidence index (primary files read)

- Ingestion seam: `apps/backend/src/ingestion/{source-reader,normalize,snapshot-ingestion.worker,
  snapshot-ingestion.service,snapshot-run.service,snapshot-query.service,snapshots.controller,ingestion.module}.ts`;
  `ingestion/autoplant/{autoplant-mysql.client,autoplant-ping}.ts`.
- Schema: `apps/backend/prisma/schema.prisma` (models `Company:57`, `Zone:159`, `Plant:180`, `Region:204`,
  `District:216`, `SnapshotRun:1061`, `SnapshotRunChunk:1080`, `RawDeviceSnapshot:1102`, `Device:1429`,
  `Vehicle:1453`, `DeviceState:1477`, `PgiHistory:1690`).
- Consumers: `dashboard/dashboard.service.ts`, `recommender/{recommender.service,canonical-sort,scoring,
  hard-filters}.ts`, `ticketing/ticket-creation.service.ts`, `device-state/{device-state.service,eligibility,
  sla-bucket}.ts`, `packages/shared/src/index.ts` (`SLA_BANDS`).
- Org/overlay: `org/{org-seed,geography.service,plant-eligible-floating-se.service}.ts`,
  `test/env/book8/{book8-dataset,book8-seeder,book8-source-reader}.ts`.
- Domain authority: `CONTEXT.md` (§Snapshot, §Device, §Device GPS Ping, §Technical Hint, §Data Layers,
  §Company Master, §Transporter), `apps/backend/.env.example`.
- AutoPlant source: `docs/autoplant_databaseData.md` (`ap_widgets`/`ap_masters` schemas + sample rows).
```

### Appendix B — backlog reconciliation

| Existing issue | State | Relation to this blueprint |
|---|---|---|
| **04** — Snapshot ingestion + data-as-of banner | **done** (mock source; real AutoPlant source deferred behind `SOURCE_READER`, HITL) | Phase 3 wires the real reader this issue anticipated |
| **05** — Device state + inactivity + SLA + ticket creation | **done** (pipeline unscheduled; SAP PGI external/deferred) | Phase 5–7 verify + orchestrate on real data |
| **02** — Org / reference config + Settings | **done** (idempotent seed of `zones/plants/companies`) | Phase 4 master-sync **supersedes** the seed for AutoPlant-owned masters; keep SLA/scoring/kit config |
| **65** — Vehicle readiness from AutoPlant LR-Date/Next-Trip + ZM Readiness Conflicts | **ready-for-agent** (not built) | Adjacent AutoPlant source path (trip data); coordinate the reader/connection reuse; out of scope for v1 ingestion but shares the seam |
| **84** — Technical Hints API (derived telemetry) | not built (blocked-by #04) | Consumes `raw_device_snapshots` this blueprint fills; unblocked after Phase 3 |
| **91** — Postgres-backed auth (retire in-memory user/token stores) | needs-triage (HITL) | The *SE/user* "Book harness" replacement — **distinct from the AutoPlant Book Dataset**; not part of this blueprint but the same "retire test harness" theme |

**Confirmed gap:** the backlog has **no dedicated issue for an AutoPlant `ap_masters` → FSM org-master sync**
(company/zone/region/plant/vehicle/transporter). Org master is currently the Issue-02 seed only. **This is the
primary backlog-ownership item to file** (Strategic HITL), alongside the Phase-2 device-id migration.

*Note: implementation slices should be filed as issues in `.scratch/fsm-platform-v1/INDEX.md` per the
issue-tracker rules. The two items to raise first are **Phase 2's device-id → String migration** (overturns a
documented LLD decision — needs sign-off) and **Phase 4's master synchronizer** (currently un-issued).*
