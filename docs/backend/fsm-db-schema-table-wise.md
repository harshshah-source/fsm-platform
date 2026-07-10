# FSM Database Schema — Table-wise Structured Version

## Source

This document is restructured from the original **Database Schema Blueprint** (`docs/backend/fsm-database-schema-blueprint.md`). The original document remains the **source of truth**. Nothing here is a new design — every table, column, constraint, business rule, writer/reader, audit rule, and retention rule below is carried over from the original. Where the original left something implicit, this version only re-organises it for readability; it does not invent schema.

> If this document and the original blueprint ever disagree, **the original blueprint wins.**

## How to Read This Document

The FSM system is a **state-machine-and-audit system over a high-volume GPS telemetry stream**. The end-to-end flow that the tables support:

```
GPS raw data        →  raw_device_snapshots   (telemetry pings ingested by Snapshot runs)
   ↓
device state        →  device_states          (derived current inactivity + SLA bucket, 1 row/device)
   ↓
failure cycle       →  failure_cycles         (immutable inactivity episode opens; SLA primary clock starts)
   ↓
ticket              →  tickets                (one actionable work item per failure cycle)
   ↓
SE assignment       →  recommendations / work_schedules / plant_batch_assignments
                        (deterministic Recommender routes the ticket to a Service Engineer)
   ↓
SE submission       →  troubleshooting_submissions (offline-idempotent field work capture)
   ↓
verification        →  verification_runs      (three-phase auto-GPS verification of recovery pings)
   ↓
closure             →  tickets / failure_cycles transition to CLOSED / VERIFIED
   ↓
audit               →  audit_logs + ticket_events (append-only record of every transition)
```

Supporting flows hang off this spine: **soft_states** capture real-time field progress (VIEWED / ON_SITE / TROUBLESHOOT_STARTED) without locking the ticket; **component_requests** pause the SLA clock when a part is unavailable; **inventory_transactions** move stock without double-counting on retry; **non_operational_markings** exclude dead devices from the uptime KPI and spawn Recovery tickets; **fleet_uptime_monthly** stores the contractual SLA number.

### How each table block is laid out

Every table below uses the same fixed sections: **Purpose → Basic Info → Columns → Foreign Keys → Constraints → Indexes → Used By → Audit & Retention → Notes**. Empty cells mean the original blueprint did not specify that item for that table.

## Phase-wise Implementation

Phase 1 Core is taken **verbatim** from the task requirements. Phase 2 / Phase 3 are a readability grouping of the remaining tables, aligned with the original blueprint's migration plan (M0–M7) and domain map — they do **not** change any table or rule.

| Phase | Tables | Purpose |
| ----- | ------ | ------- |
| **Phase 1 — Core** | `users`, `zones`, `plants`, `vehicles`, `devices`, `vehicle_device_mappings`, `snapshot_runs`, `raw_device_snapshots`, `device_states`, `failure_cycles`, `tickets`, `soft_states`, `troubleshooting_submissions`, `verification_runs`, `ticket_events`, `audit_logs` | The minimum spine that runs the whole loop: ingest GPS → derive state → open failure cycle → raise ticket → capture SE work → verify → close, with full audit. |
| **Phase 2 — Important** | `regions`, `districts`, `transporters`, `company_master`, `warehouses`, `engineer_master`, `se_coverage`, `engineer_territory_coverage`, `snapshot_run_chunks`, `data_quality_errors`, `pgi_history`, `install_details`, `troubleshoot_details`, `expected_components`, `work_schedules`, `plant_batch_assignments`, `batch_assignment_tickets`, `recommendations`, `se_planner`, `se_availability`, `leave_requests`, `vehicle_readiness_state`, `vehicle_availability_signal`, `vehicle_unavailability_reports`, `submission_components`, `offline_submission_receipts`, `component_master`, `component_serial`, `common_kit_definition`, `se_van_stock`, `warehouse_stock`, `inventory_transactions`, `component_requests`, `system_settings`, `sla_config`, `priority_rule_config` | Routing, coverage, availability, readiness, inventory, component requests, offline idempotency, and the config registry — everything needed for real dispatch and field operations at scale. |
| **Phase 3 — Advanced** | `device_uptime_daily`, `fleet_uptime_monthly`, `recovery_details`, `intraday_insertions`, `cross_zone_escalations`, `recommender_runtime_state`, `role_unavailability`, `expense_vouchers`, `expense_voucher_items`, `non_operational_markings`, `notifications` | Contractual KPI rollups, recovery/non-op lifecycle, cross-zone escalation, intra-day acceptance flow, vouchers, and notification delivery — value-add layers on top of the working core. |
| **Phase 7 — Analytics & Summary (D16)** | `device_downtime_summary_monthly`, `root_cause_summary_monthly`, `system_efficiency_summary_daily`, `zm_performance_summary_monthly`, `se_troubleshooting_summary_monthly` | Read-only Layer-2 aggregates populated by nightly/monthly workers for Device Lifetime Downtime Trend, Root Cause Analytics %, System Efficiency Report, and the Operations-Head ZM Performance Scorecard. Dashboards/scorecards read these — **never** raw telemetry or multi-year `ticket_events`. Retention: summaries permanent; raw/event/audit history archived to cold storage per the layered retention policy (`raw_device_snapshots` 3 months hot; `audit_logs`/`ticket_events` 12–24 months hot; closed `tickets`/`failure_cycles` 24 months hot). |

> Phase tags on individual tables below match this grouping. `engineer_master` is grouped in Phase 2 but the original blueprint migrates it early (migration **M1**, right after `users`) because every SE-typed foreign key references it — see its Notes.

> **Convention carried from the original:** every table has `created_at` / `updated_at timestamptz default now()` (omitted from the column lists below, exactly as in the original). PK is `id bigserial` unless noted otherwise.

---

# Phase 1 — Core Tables

---

## Table: `users`

### Purpose

Every system account; the RBAC actor and audit subject for the whole system. There is intentionally **no `ADMIN` role** — Operations Head is the configurator.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D1 — Identity & Org          |
| Primary Key  | `user_id uuid`               |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | Operations Head (account management) |
| Main Readers | AuthService, every service (actor lookup), dashboards |
| Phase        | Phase 1                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| user_id | uuid | No | — | Primary key |
| name | text | No | — | Account holder name |
| role | role (enum) | No | — | RBAC role; tops out at `OPERATIONS_HEAD` (no ADMIN) |
| zone_id | bigint | Yes | — | NULL for fleet-wide roles |
| phone | text | No | — | Contact phone |
| email | text | No | — | Login / contact email |
| status | user_status (enum) | No | `'ACTIVE'` | `ACTIVE` / `DISABLED` |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| zone_id | zones | Zone scoping for zone-bound roles |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique | `(email)` | One account per email |
| Unique | `(phone)` | One account per phone |
| Check | `role IN (...)` | Valid role enum |
| Check (deferred trigger) | `zone_id IS NOT NULL` when `role='ZONAL_MANAGER'` | A ZM must own a zone |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(role)` | Role-based lookup |
| `(zone_id)` | Zone scoping |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | auth/login, user-management page, `acted_as_role` banner |
| Worker      | heartbeat → `role_unavailability` for manager roles |
| Frontend    | Auth/login screen, user-management page |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Yes (account create / disable) |
| Retention      | Permanent; `DISABLED` accounts are not deleted |

### Notes

No `ADMIN` role exists — Operations Head is the configurator persona.

---

## Table: `zones`

### Purpose

Coarse rollup of Plants; the unit of Zonal Manager authority and row-level scoping.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D1 — Identity & Org          |
| Primary Key  | `zone_id bigserial`          |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | Operations Head              |
| Main Readers | Recommender, dashboards, escalation routing, `ZoneScopeGuard` |
| Phase        | Phase 1                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| zone_id | bigserial | No | — | Primary key |
| name | text | No | — | Zone name |
| zonal_manager_user_id | uuid | Yes | — | Owning ZM |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| zonal_manager_user_id | users | Role-polymorphic actor — references `users` (not `engineer_master`) |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique | `(name)` | Unique zone name |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(zonal_manager_user_id)` | ZM lookup |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | Recommender, escalation routing, `ZoneScopeGuard` |
| Worker      | — |
| Frontend    | Dashboards (zone drill-down) |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Yes |
| Retention      | Permanent |

### Notes

`zonal_manager_user_id` is a role-polymorphic actor column and therefore references `users`, not `engineer_master`.

---

## Table: `plants`

### Purpose

Physical site; the primary clustering unit. Carries geography (`geometry`) for Floating-SE territory membership lookups.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D1 — Identity & Org          |
| Primary Key  | `plant_id bigserial`         |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | Operations Head              |
| Main Readers | Recommender, coverage MV, dashboards (zone→plant drill-down) |
| Phase        | Phase 1                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| plant_id | bigserial | No | — | Primary key |
| name | text | No | — | Plant name |
| zone_id | bigint | No | — | Owning zone |
| district_id | bigint | No | — | Admin geography |
| location | geometry(Point,4326) | Yes | — | PostGIS point for territory membership |
| lat | double precision | Yes | — | Latitude |
| lon | double precision | Yes | — | Longitude |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| zone_id | zones | Zone rollup |
| district_id | districts | Admin geography for Floating-SE coverage |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Check | `lat BETWEEN -90 AND 90` | Geo bounds |
| Check | `lon BETWEEN -180 AND 180` | Geo bounds |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(zone_id)` | Zone scoping |
| GIST `(location)` | Spatial `ST_Contains` for territory membership |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | Recommender, coverage MV |
| Worker      | — |
| Frontend    | Dashboards (zone→plant drill-down) |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Yes (config) |
| Retention      | Permanent |

### Notes

Geometry is used by `plant_eligible_floating_se` MV (PostGIS `ST_Contains`).

---

## Table: `vehicles`

### Purpose

A vehicle carrying one or more devices; the coordination anchor for transporter, company, and plant.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D2 — Assets                  |
| Primary Key  | `vehicle_id bigserial`       |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | integration / install        |
| Main Readers | TicketCreation, SE mobile, verification, QR resolve |
| Phase        | Phase 1                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| vehicle_id | bigserial | No | — | Primary key |
| vehicle_no | text | No | — | Registration number |
| plant_id | bigint | No | — | Home plant |
| transporter_id | bigint | Yes | — | Logistics operator |
| company_id | bigint | No | — | Owning company |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| plant_id | plants | Plant association |
| transporter_id | transporters | Vehicle-access contact |
| company_id | company_master | Company/tier association |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique | `(vehicle_no)` | Unique vehicle registration |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(plant_id)` | Plant filter |
| `(company_id)` | Company filter |
| `(transporter_id)` | Transporter filter |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | TicketCreation, verification, QR resolve |
| Worker      | — |
| Frontend    | SE mobile |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Integration-sourced; changes audited |
| Retention      | Permanent |

### Notes

—

---

## Table: `devices`

### Purpose

A single GPS unit. This is the **per-device-id verification anchor** — verification always tracks the named `device_id`, never the vehicle.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D2 — Assets                  |
| Primary Key  | `device_id bigint` (business id from source) |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | integration / install / Operations Head |
| Main Readers | DeviceState, verification, Recovery (deal_type gate), eligibility |
| Phase        | Phase 1                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| device_id | bigint | No | — | Business id from source system (not surrogate) |
| current_vehicle_id | bigint | Yes | — | Currently fitted vehicle |
| deal_type | deal_type (enum) | Yes | — | `RECURRING`/`ONE_TIME`; NULL → Ops-Head manual tag fallback |
| device_type | text | Yes | — | Device model/type |
| sim_id | text | Yes | — | SIM identifier |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| current_vehicle_id | vehicles | Current fitment |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| — | — | — |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(current_vehicle_id)` | Fitment lookup |
| `(deal_type)` | Recovery deal-type gate |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | DeviceState, verification, Recovery (deal_type gate), eligibility |
| Worker      | — |
| Frontend    | — |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | `deal_type` override audited |
| Retention      | Permanent |

### Notes

`device_id` is a business bigint PK (not a surrogate), matching the AutoPlant source-of-truth id space — accepted coupling, documented in the original §2 conventions.

---

## Table: `vehicle_device_mappings`

### Purpose

Time-windowed Vehicle↔Device association with a role. One vehicle → many devices. Enforces the invariant "**one active mapping per device**".

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D2 — Assets                  |
| Primary Key  | `mapping_id bigserial`       |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | Install ACTIVATED, integration |
| Main Readers | DeviceState, verification (per-device-id, never per-vehicle) |
| Phase        | Phase 1                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| mapping_id | bigserial | No | — | Primary key |
| vehicle_id | bigint | No | — | Mapped vehicle |
| device_id | bigint | No | — | Mapped device |
| device_role | device_role (enum) | No | — | `PRIMARY`/`SECONDARY`/`BACKUP`/`COMPANY_SPECIFIC`/`TEMPORARY`/`UNKNOWN` — an attribute of the mapping, not a separate entity |
| from_ts | timestamptz | No | — | Window start |
| to_ts | timestamptz | Yes | — | Window end; NULL = active |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| vehicle_id | vehicles | Mapped vehicle |
| device_id | devices | Mapped device |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique (partial) | `(device_id) WHERE to_ts IS NULL` | One active mapping per device (invariant I3) |
| Check | `to_ts IS NULL OR to_ts > from_ts` | Valid window |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(vehicle_id, to_ts)` | Vehicle's mappings |
| `(device_id, from_ts DESC)` | Device fitment history |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | DeviceState, verification (per-device-id) |
| Worker      | — |
| Frontend    | — |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Yes (mapping open/close) |
| Retention      | Permanent (history of fitments) |

### Notes

Verification is anchored **per-device-id, never per-vehicle** (invariant I5).

---

## Table: `snapshot_runs`

### Purpose

One row per Snapshot ingestion run; drives the "data-as-of" banner and the single-in-flight guard.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D4 — Ingestion               |
| Primary Key  | `run_id bigserial`           |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | SnapshotIngestionWorker      |
| Main Readers | dashboards (data-as-of, red alert on FAILED/stale), ops alerts |
| Phase        | Phase 1                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| run_id | bigserial | No | — | Primary key |
| started_at | timestamptz | No | — | Run start |
| finished_at | timestamptz | Yes | — | Run finish |
| status | snapshot_status (enum) | No | `'RUNNING'` | `RUNNING`/`SUCCESS`/`FAILED`/`PARTIAL` |
| cursor | text | Yes | — | Ingestion cursor |
| data_as_of | timestamptz | Yes | — | Banner timestamp |
| chunk_stats | jsonb | Yes | — | Per-run chunk statistics |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| — | — | — |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique (partial) | `(status) WHERE status='RUNNING'` | Single in-flight run (backed by advisory lock — invariant I12) |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(status, started_at DESC)` | Latest-run / status scan |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | `GET /api/snapshots/latest\|runs`, `POST /api/snapshots/run` |
| Worker      | SnapshotIngestionWorker |
| Frontend    | Data-as-of banner; red alert on FAILED/stale |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Yes (run lifecycle: start/finish/fail) |
| Retention      | 13 months, then archive |

### Notes

Single in-flight run is also guarded by a Postgres advisory lock (`pg_try_advisory_lock`).

---

## Table: `raw_device_snapshots`

### Purpose

Point-in-time telemetry per device — the highest-volume table. Source for inactivity derivation, verification pings, and Technical Hints. **Monthly range-partitioned.**

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D4 — Ingestion               |
| Primary Key  | `(id, gps_datetime)` (partition key must be in PK) |
| Append-only  | Yes                          |
| Partitioned  | Yes (RANGE by `gps_datetime`, monthly) |
| Main Writer  | SnapshotIngestionWorker      |
| Main Readers | DeviceStateService, VerificationWorker, Technical Hints (display) |
| Phase        | Phase 1                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| id | bigserial | No | — | Part of composite PK |
| run_id | bigint | No | — | Owning snapshot run |
| device_id | bigint | No | — | Reporting device |
| gps_datetime | timestamptz | No | — | Ping time; partition key |
| lat | double precision | Yes | — | Latitude |
| lon | double precision | Yes | — | Longitude |
| mains_status | smallint | Yes | — | Mains power flag |
| mains_voltage | numeric | Yes | — | Mains voltage |
| gps_validity | text | Yes | — | GPS fix validity |
| gps_mode | text | Yes | — | GPS mode |
| ignition_status | text | Yes | — | Ignition state |
| speed | numeric | Yes | — | Speed |
| creg | text | Yes | — | Network registration |
| cgreg | text | Yes | — | GPRS registration |
| csq | smallint | Yes | — | Signal quality |
| ip_address | inet | Yes | — | Device IP |
| port_no | int | Yes | — | Port |
| sim_subscriber_name | text | Yes | — | SIM subscriber |
| unit_no | text | Yes | — | Unit number |
| device_type | text | Yes | — | Device type |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| run_id | snapshot_runs | Owning ingestion run |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique | `(device_id, gps_datetime)` | `INSERT … ON CONFLICT DO NOTHING` makes chunk re-runs idempotent |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(device_id, gps_datetime DESC)` | Hot path: verification + latest-ping lookup |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | Technical Hints (display only) |
| Worker      | SnapshotIngestionWorker (write), VerificationWorker, DeviceStateService |
| Frontend    | Technical Hints (advisory display) |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | No |
| Retention      | Hot 3 months in PG, then detach + archive to cold storage (S3/Parquet); 13-month online window configurable |

### Notes

Largest table (~50k devices × multiple pings/day). Technical Hints derived from the latest row are **advisory only — never stored, never affect lifecycle**.

---

## Table: `device_states`

### Purpose

Derived current state, one row per device (upsert). The queue/dashboard hot table. Holds derived fields `is_inactive` and `sla_bucket`.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D5 — Device State & KPI      |
| Primary Key  | `device_id bigint`           |
| Append-only  | No (upsert)                  |
| Partitioned  | No                           |
| Main Writer  | DeviceStateService, SoftInactiveCountWorker |
| Main Readers | TicketCreation, Recommender, dashboards, Soft Inactive Count, Fleet Uptime feed |
| Phase        | Phase 1                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| device_id | bigint | No | — | Primary key (FK → devices) |
| latest_gps_datetime | timestamptz | Yes | — | Last ping time |
| is_inactive | bool | No | `false` | Derived from `latest_gps_datetime` vs threshold |
| inactivity_hours | numeric | Yes | — | Hours since last ping |
| sla_bucket | sla_bucket (enum) | Yes | — | Stored derived field; pure function of `inactivity_hours` |
| eligible_for_uptime | bool | No | `false` | Uptime-denominator eligibility |
| has_open_failure_cycle | bool | No | `false` | Open-episode flag |
| vehicle_id | bigint | Yes | — | Denormalised |
| plant_id | bigint | Yes | — | Denormalised |
| company_id | bigint | Yes | — | Denormalised |
| transporter_id | bigint | Yes | — | Denormalised |
| computed_at | timestamptz | No | — | Compute timestamp (staleness visibility) |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| device_id | devices | One state row per device |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Check | `inactivity_hours >= 0` | Non-negative |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(is_inactive, sla_bucket)` | Inactive-device queue by bucket |
| `(plant_id)` | Plant filter |
| `(company_id)` | Company filter |
| `(eligible_for_uptime)` | Uptime feed |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | TicketCreation, Recommender, queues |
| Worker      | DeviceStateService, SoftInactiveCountWorker, Fleet Uptime feed |
| Frontend    | Dashboards / queues |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | No (derived) |
| Retention      | Live (one row per device) |

### Notes

Mirrored to Redis `DEVICE_STATE_CACHE` (15-min TTL for open-ticket devices). `sla_bucket` is **stored** (not a view) for fast queue filtering, but authoritative only at `computed_at` and always recomputable.

---

## Table: `failure_cycles`

### Purpose

Immutable audit record of one inactivity episode; parent of exactly one Troubleshoot Ticket; the SLA primary-clock anchor. First-class state machine.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D6 — Ticketing               |
| Primary Key  | `cycle_id uuid`              |
| Append-only  | Semi (immutable once `VERIFIED`) |
| Partitioned  | No                           |
| Main Writer  | TicketCreation, VerificationWorker, ComponentRequest, SLA logic |
| Main Readers | Recommender, dashboards, reports |
| Phase        | Phase 1                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| cycle_id | uuid | No | — | Primary key |
| device_id | bigint | No | — | Affected device |
| state | failure_cycle_state (enum) | No | `'OPEN'` | `OPEN`/`WAITING_COMPONENT`/`SUBMITTED`/`VERIFIED`/`FAILED`/`REPEAT`/`ESCALATED` |
| opened_at | timestamptz | No | — | Episode open time |
| closed_at | timestamptz | Yes | — | Episode close time |
| previous_failure_cycle_id | uuid | Yes | — | Self-FK for repeat chain |
| repeat_failure | bool | No | `false` | Repeat flag |
| sla_paused | bool | No | `false` | SLA primary clock paused |
| sla_pause_reason | sla_pause_reason (enum) | Yes | — | `WAITING_COMPONENT`/`VEHICLE_UNAVAILABLE` |
| sla_paused_at | timestamptz | Yes | — | Pause start |
| sla_pause_source | text | Yes | — | Pause source |
| sla_accumulated_pause_seconds | bigint | No | `0` | Total paused seconds |
| version | int | No | `0` | Optimistic-concurrency token |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| device_id | devices | Affected device |
| previous_failure_cycle_id | failure_cycles (self) | Repeat-failure chain |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique (partial) | `(device_id) WHERE state IN ('OPEN','WAITING_COMPONENT','SUBMITTED')` | One active episode per device (invariant I1) |
| Check | `sla_paused = (sla_pause_reason IS NOT NULL)` | Pause flag/reason coupling |
| Check | `closed_at IS NULL OR closed_at >= opened_at` | Valid close time |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(state)` | State filter |
| `(device_id, opened_at DESC)` | Device episode history |
| `(previous_failure_cycle_id)` | Repeat chain |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | Recommender, reports |
| Worker      | TicketCreation, VerificationWorker, ComponentRequest, SLA logic |
| Frontend    | Dashboards |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Yes — every transition (with `acted_as_role`) |
| Retention      | Permanent |

### Notes

**Immutability:** UPDATE is refused on `VERIFIED` rows except audit-neutral fields, enforced by both a service guard and a DB trigger (`trg_fc_immutable`) — invariant I4.

---

## Table: `tickets`

### Purpose

The unified actionable work item. A single table with a `work_type` discriminator (`TROUBLESHOOT`/`INSTALL`/`RECOVERY`) and sub-type fields split into 1:1 child tables. Shares the Recommender, Day Plan, and capacity logic across all work types.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D6 — Ticketing               |
| Primary Key  | `ticket_id uuid`             |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | TicketCreation, Install, Recovery, verification, schedule services |
| Main Readers | Recommender, SE mobile (Day Plan, Shared Pool, scan), dashboards |
| Phase        | Phase 1                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| ticket_id | uuid | No | — | Primary key |
| work_type | work_type (enum) | No | — | Discriminator; immutable |
| status | ticket_status (union) | No | — | Gated by `work_type` via CHECK (see union below) |
| failure_cycle_id | uuid | Yes | — | NULL for INSTALL/RECOVERY |
| device_id | bigint | No | — | Target device |
| vehicle_id | bigint | Yes | — | Target vehicle |
| plant_id | bigint | No | — | Plant |
| company_id | bigint | No | — | Company |
| se_id | uuid | Yes | — | Current assignee (SE-typed FK → engineer_master) |
| assignment_state | assignment_state (enum) | No | `'UNASSIGNED'` | `UNASSIGNED`/`FORMALLY_ASSIGNED` |
| install_trigger_source | install_trigger (enum) | Yes | — | `MANUAL_OPERATIONS`/`EXTERNAL_API` |
| created_by | uuid | Yes | — | Actor (role-polymorphic → users) |
| created_by_role | role (enum) | Yes | — | Creating role |
| closure_type | closure_type (enum) | Yes | — | Closure category |
| company_tier | company_tier (enum) | No | — | Denormalised at creation from `company_master`; powers Platinum aging scan + Company-Tier-gate skip report without a join |
| import_batch_ref | uuid | Yes | — | Stamped identically on all rows of one Install CSV upload (Decision §11) |
| last_state_changed_at | timestamptz | No | — | Set on **every lifecycle status transition only** (not incidental edits) — true no-progress clock |
| repeat_failure | bool | No | `false` | Repeat flag |
| version | int | No | `0` | Optimistic-concurrency token |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| failure_cycle_id | failure_cycles | One ticket per cycle |
| device_id | devices | Target device |
| vehicle_id | vehicles | Target vehicle |
| plant_id | plants | Plant |
| company_id | company_master | Company |
| se_id | engineer_master(engineer_id) | SE-typed FK — guarantees assignee is a SERVICE_ENGINEER |
| created_by | users | Role-polymorphic creator |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique | `(failure_cycle_id)` | One Ticket per Failure Cycle (invariant I2) |
| Check | `work_type='TROUBLESHOOT' ⇒ failure_cycle_id IS NOT NULL` | TS must link a cycle |
| Check | `work_type='INSTALL' ⇒ created_by IS NOT NULL AND created_by_role IS NOT NULL` | Install provenance |
| Check (function) | `status ∈ work_type`'s allowed set | Status/work_type coupling |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(status, plant_id)` | Queue by plant |
| `(se_id, status)` | SE Day Plan / "assigned to me" |
| `(work_type, status)` | Work-type queue |
| `(company_id)` | Company filter |
| partial `(plant_id) WHERE status='OPEN' AND assignment_state='UNASSIGNED'` | Shared Pool |
| partial `(created_at) WHERE status='OPEN' AND assignment_state='UNASSIGNED' AND company_tier='PLATINUM'` | `ix_tk_escalate` — Platinum cross-zone auto-escalation scan |
| partial `(last_state_changed_at) WHERE work_type='RECOVERY' AND status NOT IN ('CLOSED','FAILED_RECOVERY')` | `ix_tk_recovery_stale` — 14-day no-progress scan |
| partial `(device_id, plant_id) WHERE status NOT IN (closed set)` | `ix_tk_device_active` — QR resolve |
| partial `(vehicle_id, plant_id) WHERE status NOT IN (closed set)` | `ix_tk_vehicle_active` — QR resolve |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | `/api/tickets/*`, `/api/me/day-plan`, `/api/me/shared-pool` |
| Worker      | TicketCreation, Verification, IntraDay, RepeatFailureScan |
| Frontend    | SE mobile (Day Plan, Shared Pool, scan), dashboards |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Yes — every transition (+ `ticket_events`) |
| Retention      | Permanent |

### Notes

**`ticket_status` union** (validated against `work_type` by CHECK + service guard):
- **TROUBLESHOOT** → `OPEN | SUBMITTED | VERIFICATION_PENDING | CLOSED | CLOSED_AUTO_RECOVERY | FAILED_VERIFICATION | ESCALATED | CLOSED_NON_OPERATIONAL`
- **INSTALL** → `REQUESTED | SCHEDULED | ON_SITE | FITTED | ACTIVATED | CLOSED | FAILED_ACTIVATION | CLOSED_NON_OPERATIONAL`
- **RECOVERY** → `REQUESTED | SCHEDULED | ON_SITE | COLLECTED | RECEIVED_AT_WAREHOUSE | CLOSED | FAILED_RECOVERY`

---

## Table: `soft_states`

### Purpose

Temporary SE field-progress signals (VIEWED / ON_SITE / TROUBLESHOOT_STARTED). **Not** a lifecycle state and **not** a lock — multiple SEs may hold them concurrently. Primary input to the derived SE Activity Status.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D7 — Soft State              |
| Primary Key  | `soft_state_id bigserial`    |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | SE mobile, ZM (force-resolve), SYSTEM (valid closure) |
| Main Readers | ZM dashboard (Activity Status, override conflict checks) |
| Phase        | Phase 1                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| soft_state_id | bigserial | No | — | Primary key |
| ticket_id | uuid | No | — | Subject ticket |
| se_id | uuid | No | — | Holding SE (SE-typed FK → engineer_master) |
| type | soft_state_type (enum) | No | — | `VIEWED`/`ON_SITE`/`TROUBLESHOOT_STARTED` |
| onsite_source | onsite_source (enum) | Yes | — | `AUTO_GEOFENCE`/`MANUAL` (ON_SITE only) |
| set_at | timestamptz | No | `now()` | Set time |
| timeout_at | timestamptz | Yes | — | VIEWED only |
| resolved_at | timestamptz | Yes | — | Resolution time |
| resolved_by | text | Yes | — | `SE`/`ZM`/`SYSTEM` |
| resolution_reason | text | Yes | — | Mandatory for ZM force-resolve |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| ticket_id | tickets | Subject ticket |
| se_id | engineer_master(engineer_id) | Holding SE |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique (partial) | `(ticket_id, se_id, type) WHERE resolved_at IS NULL` (`ux_ss_active`) | One active soft state of each type per SE per ticket (invariant I24) |
| Check | `type='VIEWED' ⇒ timeout_at IS NOT NULL` | VIEWED expires |
| Check | `type<>'VIEWED' ⇒ timeout_at IS NULL` | ON_SITE/TROUBLESHOOT_STARTED never time-expire |
| Check | `onsite_source IS NULL OR type='ON_SITE'` | Source only for ON_SITE |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| partial `(ticket_id) WHERE resolved_at IS NULL` | Active soft states on a ticket |
| `(se_id, resolved_at)` | SE's soft states |
| partial `(timeout_at) WHERE resolved_at IS NULL AND type='VIEWED'` | `ix_ss_viewed_timeout` — SoftStateTimeoutWorker |
| partial `(set_at) WHERE resolved_at IS NULL` | `ix_ss_stale` — stale-work warning sweep |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | `/api/tickets/{id}/soft-state*` |
| Worker      | SoftStateTimeoutWorker, stale-work sweep |
| Frontend    | ZM dashboard (Activity Status, override conflict checks) |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | ZM force-resolve audited (`OVERRIDE_AFTER_ON_SITE`) |
| Retention      | Keep resolved rows ≥ 1 year for audit trail, then archive |

### Notes

Multiple *different* SEs may hold concurrently; a double-tap/retry cannot create a duplicate (partial UQ). Non-locking by design — the race is handled at submission via Shadow Use + 409, not via locks.

---

## Table: `troubleshooting_submissions`

### Purpose

SE form submission; a 1-to-many child of a Ticket (one cycle → one ticket → 1+ submissions). Carries the Phase-1 verification GPS anchor. Offline-idempotent.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D11 — Forms & Idempotency    |
| Primary Key  | `submission_id uuid`         |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | SE mobile, OfflineSync       |
| Main Readers | VerificationWorker (Phase-1 anchor), audit, SE-productivity report |
| Phase        | Phase 1                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| submission_id | uuid | No | — | Primary key |
| ticket_id | uuid | No | — | Parent ticket |
| failure_cycle_id | uuid | No | — | Parent cycle |
| submission_type | submission_type (enum) | No | — | CHECK-constrained to `{TROUBLESHOOTING_FORM, COMPONENT_RESUBMIT}` |
| client_submission_id | uuid | No | — | Client idempotency id |
| se_id | uuid | No | — | Submitting SE (SE-typed FK → engineer_master) |
| se_gps_lat | double precision | Yes | — | SE latitude |
| se_gps_lon | double precision | Yes | — | SE longitude |
| presence_source | presence_source (enum) | No | — | `GEOFENCE_AUTO`/`MANUAL_ONSITE`/`FORM_GPS`/`NONE` |
| onsite_capture_gps | geometry(Point,4326) | Yes | — | PostGIS on-site capture |
| component_unavailable | bool | No | `false` | Triggers WAITING_COMPONENT |
| component_unavailable_item | bigint | Yes | — | FK → component_master |
| root_cause_category | root_cause_category (enum) | No | — | `POWER_ISSUE`/`SIM_NETWORK_ISSUE`/`GPS_ANTENNA_ISSUE`/`DEVICE_HARDWARE_FAULT`/`WIRING_ISSUE`/`CONFIGURATION_ISSUE`/`VEHICLE_ACCESS_ISSUE`/`INSTALLATION_ISSUE`/`CUSTOMER_SIDE_ISSUE`/`UNKNOWN` — **the** source for Root Cause Analytics |
| root_cause_subcategory | text | Yes | — | Finer classification |
| root_cause_notes | text | Yes | — | Structured root-cause notes |
| action_taken_category | text | Yes | — | What the SE did (structured) |
| action_taken_notes | text | Yes | — | Notes on action taken |
| diagnosis_notes | text | Yes | — | Free-text SE notes — supplementary only; **not** the source for root-cause analytics |
| submitted_at | timestamptz | No | — | Submission time |
| photo_refs | text[] | Yes | — | Photo references |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| ticket_id | tickets | Parent ticket |
| failure_cycle_id | failure_cycles | Parent cycle |
| se_id | engineer_master(engineer_id) | Submitting SE |
| component_unavailable_item | component_master | Unavailable part |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique | `(se_id, client_submission_id)` | Storage-level idempotency for troubleshoot forms |
| Check | `component_unavailable ⇒ component_unavailable_item IS NOT NULL` | Must name the part |
| Check | `submission_type IN {TROUBLESHOOTING_FORM, COMPONENT_RESUBMIT}` | Only two types this table holds |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(ticket_id, submitted_at DESC)` | Latest submission per ticket |
| `(failure_cycle_id)` | Cycle lookup |
| `(root_cause_category, submitted_at)` | Feeds RootCauseSummaryWorker / Root Cause Analytics |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | `/api/tickets/{id}/troubleshoot` |
| Worker      | VerificationWorker (Phase-1 anchor) |
| Frontend    | SE mobile |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Yes |
| Retention      | Permanent |

### Notes

**Component-wait / resubmit flow (Decision §8):**
1. **Initial form** → `client_submission_id = A`, type `TROUBLESHOOTING_FORM`. If `component_unavailable=true`, cycle goes `OPEN → WAITING_COMPONENT` (no verification queued) and a `component_requests` row is auto-created **in the same tx, reusing `client_submission_id = A`** — guarded by a second `offline_submission_receipts(se, COMPONENT_REQUEST, A)` row so a retry re-derives the same request.
2. **Resubmit** (after part arrives + ZM-confirmed binding) → **new** `client_submission_id = B`, type `COMPONENT_RESUBMIT`, `component_unavailable=false`. Cycle `WAITING_COMPONENT → SUBMITTED`.
3. **VerificationWorker reads the latest `COMPONENT_RESUBMIT`** for its Phase-1 GPS anchor; the initial submission never reached verification.

---

## Table: `verification_runs`

### Purpose

Three-phase auto-GPS verification of recovery pings; fraud flag; the source of the `PARTIAL_RECOVERY` badge.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D14 — Verification           |
| Primary Key  | `run_id bigserial`           |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | VerificationWorker           |
| Main Readers | Ticket close logic, ZM dashboard, fraud-flags view, reports |
| Phase        | Phase 1                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| run_id | bigserial | No | — | Primary key |
| ticket_id | uuid | No | — | Subject ticket |
| submission_id | uuid | Yes | — | Phase-1 anchor; NULL for auto-recovery |
| device_id | bigint | No | — | Verified device (named device_id, never vehicle) |
| started_at | timestamptz | No | — | Run start |
| se_gps_lat | double precision | Yes | — | SE latitude |
| se_gps_lon | double precision | Yes | — | SE longitude |
| phase | verify_phase (enum) | No | `'PENDING'` | `PENDING`/`PHASE_1_PASS`/`PHASE_2_PASS` |
| phase1_passed_at | timestamptz | Yes | — | Phase-1 pass time |
| phase2_passed_at | timestamptz | Yes | — | Phase-2 pass time |
| first_ping_distance_meters | numeric | Yes | — | Phase-1 distance |
| fraud_flag | bool | No | `false` | Fraud indicator |
| pings_received_count | int | No | `0` | Drives PARTIAL_RECOVERY badge |
| outcome | verify_outcome (enum) | Yes | — | `CLOSED`/`FAILED_VERIFICATION`/`PARTIAL_RECOVERY`/`CLOSED_AUTO_RECOVERY`/`FAILED_ACTIVATION` |
| outcome_at | timestamptz | Yes | — | Outcome time |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| ticket_id | tickets | Subject ticket |
| submission_id | troubleshooting_submissions | Phase-1 GPS anchor |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique (partial) | `(ticket_id) WHERE outcome IS NULL` (`ux_vr_active`) | One in-flight verification run per ticket (invariant I22) |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(device_id)` | Device lookup |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | `/api/tickets/{id}/verification`, `/api/verification/fraud-flags` |
| Worker      | VerificationWorker (5-min scan, 24h window) |
| Frontend    | ZM dashboard, fraud-flags view |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Outcome audited |
| Retention      | Permanent |

### Notes

`PARTIAL_RECOVERY` is a **badge** derived from `pings_received_count`/`outcome`, not a stored lifecycle state.

---

## Table: `ticket_events`

### Purpose

Ticket lifecycle history — complements `audit_logs`, but narrower and faster for the history UI. Append-only.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D6 — Ticketing               |
| Primary Key  | `event_id bigserial`         |
| Append-only  | Yes                          |
| Partitioned  | No                           |
| Main Writer  | All Ticket-mutating services |
| Main Readers | history UI, reports (plant clearance, starve depth) |
| Phase        | Phase 1                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| event_id | bigserial | No | — | Primary key |
| ticket_id | uuid | No | — | Subject ticket |
| from_state | text | Yes | — | Prior state |
| to_state | text | No | — | New state |
| actor_id | uuid | Yes | — | Acting user (→ users) |
| actor_role | role (enum) | Yes | — | Actor's role |
| acted_as_role | role (enum) | Yes | — | Acting-as role (backup cascade) |
| reason_code | text | Yes | — | Transition reason |
| at | timestamptz | No | `now()` | Event time |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| ticket_id | tickets | Subject ticket |
| actor_id | users | Role-polymorphic actor |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Append-only | No UPDATE/DELETE (grants + trigger) | Immutable history |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(ticket_id, at)` | History timeline |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | history UI, reports |
| Worker      | written by all Ticket-mutating services |
| Frontend    | Ticket history timeline |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Is itself audit-adjacent |
| Retention      | Permanent |

### Notes

—

---

## Table: `audit_logs`

### Purpose

Immutable record of every state change, approval, override, and close — written in the **same DB transaction** as the mutation. Append-only; INSERT+SELECT only.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D17 — Notify, Audit, Config  |
| Primary Key  | `audit_id bigserial`         |
| Append-only  | Yes                          |
| Partitioned  | Optional (monthly RANGE on `at`) |
| Main Writer  | AuditService (all services, in-tx) |
| Main Readers | reports, compliance, dashboards |
| Phase        | Phase 1                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| audit_id | bigserial | No | — | Primary key |
| entity_type | text | No | — | Audited entity type |
| entity_id | text | No | — | Audited entity id |
| action | text | No | — | Action performed |
| actor_id | uuid | Yes | — | Acting user (→ users) |
| actor_role | role (enum) | Yes | — | Actor's role |
| acted_as_role | role (enum) | Yes | — | Acting-as role |
| reason | text | Yes | — | Reason |
| before | jsonb | Yes | — | Pre-image |
| after | jsonb | Yes | — | Post-image |
| at | timestamptz | No | `now()` | Mutation time |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| actor_id | users | Role-polymorphic actor |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Grants | INSERT + SELECT only; **no UPDATE/DELETE** | Immutability (invariant I17) |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(entity_type, entity_id, at)` | Entity audit trail |
| `(actor_id, at)` | Actor audit trail |
| `(acted_as_role)` | Backup-acting report |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | reports, compliance, dashboards |
| Worker      | AuditService (in-tx with every mutation) |
| Frontend    | Compliance / audit views |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Is the audit |
| Retention      | Permanent (optionally monthly-partitioned for volume) |

### Notes

Written in the same `$transaction` as the mutation it records (invariant I17).

---

# Phase 2 — Important Tables

---

## Table: `regions`

### Purpose

Indian administrative geography (region level) for Floating-SE hierarchical coverage.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D1 — Identity & Org          |
| Primary Key  | `region_id bigserial`        |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | Operations Head / seed       |
| Main Readers | territory lookup, `plant_eligible_floating_se` MV |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| region_id | bigserial | No | — | Primary key |
| name | text | No | — | Region name |
| state | text | No | — | State |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| — | — | — |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique | `(name)` | Unique region name |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| — | — |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | territory lookup |
| Worker      | `plant_eligible_floating_se` MV refresh |
| Frontend    | — |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Config-change only |
| Retention      | Permanent (reference) |

### Notes

—

---

## Table: `districts`

### Purpose

Indian administrative geography (district level, ~700 districts) for Floating-SE hierarchical coverage.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D1 — Identity & Org          |
| Primary Key  | `district_id bigserial`      |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | Operations Head / seed       |
| Main Readers | territory lookup, `plant_eligible_floating_se` MV |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| district_id | bigserial | No | — | Primary key |
| name | text | No | — | District name |
| state | text | No | — | State |
| region_id | bigint | Yes | — | Parent region |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| region_id | regions | Parent region |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique | `(name, state)` | Unique district per state |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(region_id)` | Region rollup |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | territory lookup |
| Worker      | `plant_eligible_floating_se` MV refresh |
| Frontend    | — |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Config-change only |
| Retention      | Permanent (reference) |

### Notes

~700 districts seeded.

---

## Table: `transporters`

### Purpose

Logistics operator at a Plant; the SE's field contact for vehicle access. PII is surfaced only on Ticket Detail.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D1 — Identity & Org          |
| Primary Key  | `transporter_id bigserial`   |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | Operations Head / integration |
| Main Readers | SE mobile Ticket Detail, dashboards |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| transporter_id | bigserial | No | — | Primary key |
| name | text | No | — | Transporter name |
| plant_id | bigint | No | — | Plant |
| contact_phone | text | Yes | — | Contact phone (PII) |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| plant_id | plants | Plant association |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| — | — | — |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(plant_id)` | Plant filter |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | dashboards |
| Worker      | — |
| Frontend    | SE mobile Ticket Detail (required for Vehicle Unavailability Report) |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Config |
| Retention      | Permanent |

### Notes

**Security:** `contact_phone` is exposed only to authorised SE/ZM on Ticket Detail.

---

## Table: `company_master`

### Purpose

Reference of all companies; the top-level scoring gate (tier) plus tie-break (rank). Supersedes the root-PRD `CUSTOMER_MASTER`.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D1 — Identity & Org          |
| Primary Key  | `company_id bigserial`       |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | integration + Operations Head override |
| Main Readers | Recommender (canonical sort), reports (per-company uptime) |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| company_id | bigserial | No | — | Primary key |
| name | text | No | — | Company name |
| company_tier | company_tier (enum) | No | — | `PLATINUM`/`GOLD`/`SILVER` |
| company_priority_rank | text | No | — | `A`/`B`/… tie-break rank |
| contract_ref | text | Yes | — | Contract reference |
| source | text | Yes | — | CRM/SAP |
| ops_override | bool | No | `false` | Operations Head override flag |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| — | — | — |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Check | `company_priority_rank ~ '^[A-Z]$'` | Single uppercase letter |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(company_tier, company_priority_rank)` | Canonical sort precompute |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | Recommender (canonical sort), reports |
| Worker      | — |
| Frontend    | Reports (per-company uptime) |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Yes on override |
| Retention      | Permanent |

### Notes

Tier and rank are columns (scoring gates), not separate tables.

---

## Table: `warehouses`

### Purpose

Master of physical stock points (a national/regional **Mother** warehouse + one **Zone** Warehouse per zone). Added to fix the orphan `warehouse_id` FK that `warehouse_stock` / `inventory_transactions` referenced.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D1 — Identity & Org          |
| Primary Key  | `warehouse_id bigserial`     |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | Operations Head              |
| Main Readers | InventoryService, Recommender (Zone-Warehouse pickup planning), Warehouse Manager dashboards |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| warehouse_id | bigserial | No | — | Primary key |
| name | text | No | — | Warehouse name |
| warehouse_type | warehouse_type (enum) | No | — | `MOTHER`/`ZONE` |
| zone_id | bigint | Yes | — | NULL for MOTHER |
| manager_user_id | uuid | Yes | — | Warehouse Manager |
| location | geometry(Point,4326) | Yes | — | PostGIS point |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| zone_id | zones | Zone association (ZONE type) |
| manager_user_id | users | Warehouse Manager |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique (partial) | `(zone_id) WHERE warehouse_type='ZONE'` | One Zone Warehouse per zone |
| Check | `warehouse_type='ZONE' ⇒ zone_id IS NOT NULL` | Zone warehouse must have a zone |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| — | — |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | InventoryService, Recommender |
| Worker      | — |
| Frontend    | Warehouse Manager dashboards |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Config |
| Retention      | Permanent |

### Notes

**Added table** (not in the LLD's prior data-model pass) — fixes the orphan `warehouse_id` FK. Still part of the original blueprint.

---

## Table: `engineer_master`

### Purpose

SE-only profile plus the SE Activity Ping timestamp. Kept off `users` to avoid wide nullable rows on manager accounts. **Target of every SE-typed FK.**

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D3 — Coverage                |
| Primary Key  | `engineer_id uuid` (= user_id) |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | Operations Head (profile), ActivityPing handler (`last_activity_at`) |
| Main Readers | `v_se_activity_status` (only) |
| Phase        | Phase 2 (migrates in M1 — see Notes) |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| engineer_id | uuid | No | — | Primary key, FK → users |
| coverage_type | coverage_type (enum) | No | — | `DEDICATED`/`MULTI_PLANT`/`FLOATING` |
| zone_id | bigint | No | — | Home zone |
| daily_capacity | int | No | — | Daily ticket capacity |
| shift_start | time | Yes | — | Shift start |
| shift_end | time | Yes | — | Shift end |
| preferred_notification_channel | notify_channel (enum) | Yes | — | Preferred channel |
| last_activity_at | timestamptz | Yes | — | SE Activity Ping; never a background timer |
| is_active | bool | No | `true` | Active flag |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| engineer_id | users | 1:1 SE profile |
| zone_id | zones | Home zone |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Check | `daily_capacity > 0` | Positive capacity |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(zone_id)` | Zone filter |
| `(last_activity_at)` | Activity lookup |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | `v_se_activity_status` (1h OFFLINE label) only |
| Worker      | ActivityPing handler |
| Frontend    | — |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Profile changes audited; `last_activity_at` updates not audited (telemetry) |
| Retention      | Permanent |

### Notes

**Migration order:** migrates in **M1** (right after `users`) so every SE-typed FK resolves — SE onboarding inserts the `engineer_master` row before any assignment can reference the SE. `last_activity_at` is **visibility/audit only** and **never** gates Recommender scoring, Morning Batch, Day Plan, assignment, intra-day update, or CRITICAL insertion (the prior 15-min intra-day Hard Filter was removed; unreachable SEs are handled by the Acceptance Timeout + reroute).

---

## Table: `se_coverage`

### Purpose

Plant coverage for Dedicated / Multi-Plant SEs — the responsibility assignment, not the geography.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D3 — Coverage                |
| Primary Key  | `id bigserial`               |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | Operations Head              |
| Main Readers | Recommender precedence, `CoverageScopeGuard` (Shared Pool), dashboards |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| id | bigserial | No | — | Primary key |
| se_id | uuid | No | — | SE (SE-typed FK → engineer_master) |
| plant_id | bigint | No | — | Covered plant |
| coverage_type | coverage_type (enum) | No | — | `DEDICATED`/`MULTI_PLANT` |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| se_id | engineer_master(engineer_id) | Covering SE |
| plant_id | plants | Covered plant |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique | `(se_id, plant_id)` | One coverage row per SE/plant |
| Unique (partial) | `(se_id) WHERE coverage_type='DEDICATED'` | A Dedicated SE holds only one row |
| Check | `coverage_type <> 'FLOATING'` | Floating uses territory table instead |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(plant_id)` | Plant scoping |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | Recommender precedence, `CoverageScopeGuard` |
| Worker      | — |
| Frontend    | Dashboards |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Config |
| Retention      | Permanent |

### Notes

—

---

## Table: `engineer_territory_coverage`

### Purpose

Floating-SE Territory — hierarchical (state/region/district) **and/or** polygon. Membership is the union of all conditions.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D3 — Coverage                |
| Primary Key  | `id bigserial`               |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | Operations Head              |
| Main Readers | Recommender (PostGIS `ST_Contains`), `plant_eligible_floating_se` MV refresh |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| id | bigserial | No | — | Primary key |
| se_id | uuid | No | — | SE (SE-typed FK → engineer_master) |
| district_id | bigint | Yes | — | District membership |
| region_id | bigint | Yes | — | Region membership |
| state | text | Yes | — | State membership |
| polygon | geometry(MultiPolygon,4326) | Yes | — | Polygon membership |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| se_id | engineer_master(engineer_id) | Covering SE |
| district_id | districts | District membership |
| region_id | regions | Region membership |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Check | At least one of `district_id`/`region_id`/`state`/`polygon` non-null | Must define some territory |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(se_id)` | SE lookup |
| GIST `(polygon)` | `ST_Contains` membership |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | Recommender (PostGIS `ST_Contains`) |
| Worker      | `plant_eligible_floating_se` MV refresh |
| Frontend    | — |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Config |
| Retention      | Permanent |

### Notes

—

---

## Table: `snapshot_run_chunks`

### Purpose

Per-chunk retry tracking without restarting the whole snapshot run.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D4 — Ingestion               |
| Primary Key  | `id bigserial`               |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | SnapshotIngestionWorker      |
| Main Readers | SnapshotIngestionWorker      |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| id | bigserial | No | — | Primary key |
| run_id | bigint | No | — | Owning run |
| chunk_no | int | No | — | Chunk index |
| status | chunk_status (enum) | No | `'PENDING'` | `PENDING`/`SUCCESS`/`FAILED` |
| retry_count | int | No | `0` | Retries |
| error | text | Yes | — | Error detail |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| run_id | snapshot_runs | Owning run |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique | `(run_id, chunk_no)` | One row per chunk per run |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(run_id, status)` | Retry scan |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | — |
| Worker      | SnapshotIngestionWorker |
| Frontend    | — |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | No (engineering telemetry) |
| Retention      | Purge with parent run |

### Notes

—

---

## Table: `data_quality_errors`

### Purpose

Engineering-owned silent queue of telemetry data-quality issues; never surfaced to business users.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D4 — Ingestion               |
| Primary Key  | `id bigserial`               |
| Append-only  | Yes                          |
| Partitioned  | No                           |
| Main Writer  | DeviceStateService           |
| Main Readers | engineering only             |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| id | bigserial | No | — | Primary key |
| device_id | bigint | Yes | — | Affected device |
| severity | dq_severity (enum) | No | — | `BLOCKING`/`WARNING`/`INFO` |
| field | text | Yes | — | Offending field |
| detail | text | Yes | — | Description |
| resolved | bool | No | `false` | Resolution flag |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| — | — | — |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| — | — | — |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(resolved, severity)` | Unresolved-by-severity scan |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | — |
| Worker      | DeviceStateService (write) |
| Frontend    | — (engineering only) |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | No |
| Retention      | 90 days |

### Notes

—

---

## Table: `pgi_history`

### Purpose

SAP Post-Goods-Issue events; proof of active commercial use that feeds device eligibility.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D4 — Ingestion               |
| Primary Key  | `id bigserial`               |
| Append-only  | Yes                          |
| Partitioned  | No                           |
| Main Writer  | SAP integration              |
| Main Readers | `device_eligibility` MV      |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| id | bigserial | No | — | Primary key |
| device_id | bigint | No | — | Device |
| pgi_date | date | No | — | PGI event date |
| order_ref | text | Yes | — | SAP order reference |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| device_id | devices | Device |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| — | — | — |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(device_id, pgi_date DESC)` | Latest PGI per device |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | — |
| Worker      | `device_eligibility` MV |
| Frontend    | — |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | No |
| Retention      | 24 months (covers eligibility windows + reporting) |

### Notes

Active PGI ≤ 15 days is the eligibility gate consumed by `device_eligibility`.

---

## Table: `install_details`

### Purpose

Install-specific sub-type fields, 1:1 child of `tickets` (keyed by `ticket_id`).

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D6 — Ticketing               |
| Primary Key  | `ticket_id uuid` (FK PK)     |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | Install service              |
| Main Readers | verification, dashboards, reports |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| ticket_id | uuid | No | — | PK, FK → tickets |
| device_serial | text | Yes | — | Installed device serial |
| sim_serial | text | Yes | — | Installed SIM serial |
| target_date | date | Yes | — | Planned install date |
| fitted_at | timestamptz | Yes | — | Fitment time |
| activated_at | timestamptz | Yes | — | Activation time (warranty anchor) |
| notes | text | Yes | — | Notes |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| ticket_id | tickets | 1:1 parent |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Check | `activated_at IS NULL OR device_serial IS NOT NULL` | No activation without serials (invariant I15) |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| — | — |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | dashboards, reports |
| Worker      | verification |
| Frontend    | Install ticket detail |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Closure fields mandatory-audited |
| Retention      | Permanent |

### Notes

`activated_at` is the warranty anchor.

---

## Table: `troubleshoot_details`

### Purpose

Troubleshoot-specific sub-type fields, 1:1 child of `tickets`.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D6 — Ticketing               |
| Primary Key  | `ticket_id uuid` (FK PK)     |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | Troubleshoot service         |
| Main Readers | verification, dashboards, reports |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| ticket_id | uuid | No | — | PK, FK → tickets |
| diagnosis_summary | text | Yes | — | Diagnosis summary |
| last_submission_id | uuid | Yes | — | FK → troubleshooting_submissions |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| ticket_id | tickets | 1:1 parent |
| last_submission_id | troubleshooting_submissions | Latest submission |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| — | — | — |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| — | — |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | dashboards, reports |
| Worker      | verification |
| Frontend    | Troubleshoot ticket detail |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Closure fields mandatory-audited |
| Retention      | Permanent |

### Notes

—

---

## Table: `expected_components`

### Purpose

Components the system predicts a Ticket needs — a Hard-Filter input for the Recommender and the Expected-Component leg. Decision §12 multi-row child.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D6 — Ticketing               |
| Primary Key  | `id bigserial`               |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | TicketCreation, RepeatFailureScan, ComponentRequest |
| Main Readers | Recommender Hard Filter, Component-Blocked Queue |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| id | bigserial | No | — | Primary key |
| ticket_id | uuid | No | — | Parent ticket |
| component_id | bigint | No | — | Predicted component |
| source | expected_src (enum) | No | — | `REPEAT_FAILURE`/`PARTIAL_DIAGNOSIS`/`INSTALL_SETUP`/`WAITING_COMPONENT_RESUBMIT` |
| quantity | int | No | `1` | Quantity needed |
| resolved | bool | No | `false` | Resolution flag |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| ticket_id | tickets | Parent ticket |
| component_id | component_master | Predicted component |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique | `(ticket_id, component_id)` | One row per ticket/component |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(ticket_id) WHERE resolved=false` | Unresolved-expected scan |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | Recommender Hard Filter, Component-Blocked Queue |
| Worker      | TicketCreation, RepeatFailureScan, ComponentRequest |
| Frontend    | — |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | No |
| Retention      | With ticket |

### Notes

**Added table** (Decision §12) — was inline-only in the LLD.

---

## Table: `work_schedules`

### Purpose

The primary scheduling entity; groups batches for an SE over a date/range. Auto-dispatched with **no approval gate**.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D8 — Scheduling / Recommender |
| Primary Key  | `schedule_id bigserial`      |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | BatchAssignmentWorker, ScheduleService, ZonalOverride |
| Main Readers | SE mobile Day Plan, ZM dashboard |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| schedule_id | bigserial | No | — | Primary key |
| se_id | uuid | No | — | SE (SE-typed FK → engineer_master) |
| zone_id | bigint | No | — | Zone |
| date_from | date | No | — | Range start |
| date_to | date | No | — | Range end |
| status | schedule_status (enum) | No | `'ACTIVE'` | `ACTIVE`/`OVERRIDDEN`/`COMPLETED`/`PARTIAL` |
| source | text | No | — | `SYSTEM_GENERATED`/`ZM_MANUAL` |
| dispatched_at | timestamptz | Yes | — | Dispatch time |
| last_overridden_by | uuid | Yes | — | Overriding actor |
| last_overridden_at | timestamptz | Yes | — | Override time |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| se_id | engineer_master(engineer_id) | Scheduled SE |
| zone_id | zones | Zone |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Check | `date_to >= date_from` | Valid range |
| Check | No `DRAFT`/`PENDING_REVIEW`/`APPROVED` value exists | No approval gate (invariant I6) |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(se_id, date_from)` | SE schedule lookup |
| `(zone_id, status)` | Zone status scan |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | `/api/schedules/*`, `/api/me/day-plan` |
| Worker      | BatchAssignment, IntraDay |
| Frontend    | SE mobile Day Plan, ZM dashboard |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Override audited |
| Retention      | 13 months, then archive |

### Notes

—

---

## Table: `plant_batch_assignments`

### Purpose

A Plant's open Tickets assigned as a unit to one SE — the Work Schedule building block.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D8 — Scheduling / Recommender |
| Primary Key  | `batch_id bigserial`         |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | BatchAssignment, ScheduleService, ZonalOverride |
| Main Readers | SE mobile, ZM dashboard, batch-completion report |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| batch_id | bigserial | No | — | Primary key |
| schedule_id | bigint | No | — | Owning schedule |
| plant_id | bigint | No | — | Plant |
| se_id | uuid | No | — | SE (SE-typed FK → engineer_master) |
| status | batch_status (enum) | No | `'AUTO_ASSIGNED'` | `AUTO_ASSIGNED`/`OVERRIDDEN`/`COMPLETED`/`PARTIAL` |
| stop_sequence | int | Yes | — | Visit order |
| override_reason | text | Yes | — | Reason for override |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| schedule_id | work_schedules | Owning schedule |
| plant_id | plants | Plant |
| se_id | engineer_master(engineer_id) | Assigned SE |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Check | `status IN ('AUTO_ASSIGNED','OVERRIDDEN','COMPLETED','PARTIAL')` | No approval gate |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(schedule_id)` | Schedule's batches |
| `(se_id, status)` | SE batch status |
| `(plant_id)` | Plant filter |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | `/api/batches/{id}/override` |
| Worker      | BatchAssignment |
| Frontend    | SE mobile, ZM dashboard |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Override reason-coded + audited |
| Retention      | With schedule |

### Notes

—

---

## Table: `batch_assignment_tickets`

### Purpose

Join of Tickets into a batch with ordering; enforces "one active batch membership per ticket".

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D8 — Scheduling / Recommender |
| Primary Key  | `id bigserial`               |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | BatchAssignment, ScheduleService, ZonalOverride |
| Main Readers | SE mobile, ZM dashboard      |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| id | bigserial | No | — | Primary key |
| batch_id | bigint | No | — | Owning batch |
| ticket_id | uuid | No | — | Member ticket |
| sort_order | int | No | — | Order within batch |
| deferred_to_date | date | Yes | — | Deferral date |
| removed_at | timestamptz | Yes | — | Removal time |
| removed_by | uuid | Yes | — | Removing actor |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| batch_id | plant_batch_assignments | Owning batch |
| ticket_id | tickets | Member ticket |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique (partial) | `(ticket_id) WHERE removed_at IS NULL` | A ticket is in one active batch at a time |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(batch_id, sort_order)` | Ordered batch members |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | as parent batch |
| Worker      | BatchAssignment |
| Frontend    | SE mobile, ZM dashboard |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Remove/defer audited |
| Retention      | With batch |

### Notes

—

---

## Table: `recommendations`

### Purpose

System-generated SE↔Ticket binding committed directly as Formal Assignment; the "why suggested?" explainability record and intra-day retry chain. Append-only.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D8 — Scheduling / Recommender |
| Primary Key  | `recommendation_id bigserial` |
| Append-only  | Yes                          |
| Partitioned  | No                           |
| Main Writer  | BatchAssignment, IntraDay    |
| Main Readers | ZM "why suggested?" panel, starve-depth report, audit |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| recommendation_id | bigserial | No | — | Primary key |
| ticket_id | uuid | No | — | Recommended ticket |
| se_id | uuid | Yes | — | SE (SE-typed FK → engineer_master) |
| company_tier | company_tier (enum) | Yes | — | Tier at recommendation |
| device_bucket | sla_bucket (enum) | Yes | — | Bucket at recommendation |
| score_breakdown | jsonb | No | — | Weighted components + multipliers + `weight_set_ref` |
| processing_rank | int | Yes | — | Processing rank |
| status | text | No | — | Recommendation status (genuinely open — text) |
| path | rec_path (enum) | No | — | `MORNING_BATCH`/`INTRADAY` |
| retry_chain | jsonb | Yes | — | Intra-day retry chain |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| ticket_id | tickets | Recommended ticket |
| se_id | engineer_master(engineer_id) | Recommended SE |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Append-only | Corrections create new rows | Immutable explainability |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(ticket_id)` | Ticket recommendations |
| `(se_id)` | SE recommendations |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | ZM "why suggested?" panel, starve-depth report |
| Worker      | BatchAssignment, IntraDay |
| Frontend    | "Why suggested?" panel |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Immutable — corrections create new rows |
| Retention      | 13 months, then archive |

### Notes

Each batch run records the active `weight_set_ref` inside `score_breakdown`.

---

## Table: `se_planner`

### Purpose

ZM-authored plant-vs-date visit intent; a bias signal to the Morning Batch, not a hard constraint.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D8 — Scheduling / Recommender |
| Primary Key  | `id bigserial`               |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | ZM                           |
| Main Readers | BatchAssignment (bias), Day Plan |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| id | bigserial | No | — | Primary key |
| se_id | uuid | No | — | SE (SE-typed FK → engineer_master) |
| plant_id | bigint | No | — | Planned plant |
| planned_date | date | No | — | Planned visit date |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| se_id | engineer_master(engineer_id) | Planned SE |
| plant_id | plants | Planned plant |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique | `(se_id, plant_id, planned_date)` | One plan row per SE/plant/date |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(planned_date)` | Date scan |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | Day Plan |
| Worker      | BatchAssignment (bias) |
| Frontend    | ZM planner |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | No |
| Retention      | 6 months |

### Notes

Bias only — never a hard constraint.

---

## Table: `se_availability`

### Purpose

The single time-windowed SE availability table. Only `AVAILABLE` lets the Recommender include the SE.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D9 — Availability            |
| Primary Key  | `id bigserial`               |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | ZM, SE (soft-unavailable only), LeaveAvailability, heartbeat (OFFLINE) |
| Main Readers | Recommender Hard Filter, `v_se_activity_status`, dashboards |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| id | bigserial | No | — | Primary key |
| engineer_id | uuid | No | — | SE (SE-typed FK → engineer_master) |
| from_ts | timestamptz | No | — | Window start |
| to_ts | timestamptz | Yes | — | Window end |
| status | availability_status (enum) | No | — | `AVAILABLE`/`ON_LEAVE`/`OFF_SHIFT`/`WEEKLY_OFF`/`SOFT_UNAVAILABLE`/`OFFLINE` |
| reason_code | avail_reason (enum) | Yes | — | Reason |
| set_by | uuid | Yes | — | Setter (→ users) |
| set_by_role | role (enum) | Yes | — | Setter's role |
| activity_sourced | bool | No | `false` | Heartbeat OFFLINE; excluded from leave reports |
| notes | text | Yes | — | Notes |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| engineer_id | engineer_master(engineer_id) | SE |
| set_by | users | Role-polymorphic setter |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Exclude | `(engineer_id WITH =, tstzrange(from_ts,to_ts) WITH &&)` per status family | No overlapping windows |
| Check (service guard) | SE may only self-write `SOFT_UNAVAILABLE`/`OFFLINE` | SE cannot write `ON_LEAVE`/`WEEKLY_OFF` (invariant I11) |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| GIST `(engineer_id, tstzrange(from_ts, coalesce(to_ts,'infinity')))` | Window intersection |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | `/api/me/soft-unavailable`, leave decision |
| Worker      | heartbeat (OFFLINE), LeaveAvailability |
| Frontend    | Recommender input, dashboards |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | ZM-set leave audited with `set_by_role` |
| Retention      | 24 months |

### Notes

—

---

## Table: `leave_requests`

### Purpose

SE-initiated planned absence; ZM approval writes a time-windowed `se_availability` row.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D9 — Availability            |
| Primary Key  | `request_id bigserial`       |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | SE mobile, ZM               |
| Main Readers | LeaveAvailability, dashboards |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| request_id | bigserial | No | — | Primary key |
| se_id | uuid | No | — | SE (SE-typed FK → engineer_master) |
| leave_type | leave_type (enum) | No | — | `ON_LEAVE`/`WEEKLY_OFF` |
| start_date | date | No | — | Leave start |
| end_date | date | No | — | Leave end |
| reason | text | Yes | — | Reason |
| status | leave_status (enum) | No | `'SUBMITTED'` | `SUBMITTED`/`APPROVED`/`REJECTED` |
| decided_by | uuid | Yes | — | Deciding ZM |
| decided_reason | text | Yes | — | Decision reason |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| se_id | engineer_master(engineer_id) | Requesting SE |
| decided_by | users | Deciding actor |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Check | `end_date >= start_date` | Valid range |
| Check (service) | `decided_by <> se_id` | SE cannot self-approve |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(se_id, status)` | SE leave lookup |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | `/api/leave-requests/*` |
| Worker      | LeaveAvailability |
| Frontend    | SE mobile, ZM dashboard |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Decision audited |
| Retention      | 24 months |

### Notes

—

---

## Table: `vehicle_readiness_state`

### Purpose

Current confidence-scored reachability per vehicle, derived from append-only signals.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D10 — Readiness              |
| Primary Key  | `vehicle_id bigint`          |
| Append-only  | No (upsert)                  |
| Partitioned  | No                           |
| Main Writer  | ReadinessService             |
| Main Readers | Recommender Hard Filter, dashboards |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| vehicle_id | bigint | No | — | PK, FK → vehicles |
| readiness | readiness (enum) | No | `'UNKNOWN'` | `AT_PLANT`/`UPCOMING_TRIP`/`ON_TRIP`/`STALE`/`UNKNOWN`/`WAITING_CONFIRMATION`/`AVAILABLE_FOR_REPAIR` (**`EXPECTED_BACK` removed**) |
| confidence | numeric | Yes | — | Confidence score |
| last_signal_at | timestamptz | Yes | — | Last evidence time |
| computed_at | timestamptz | No | — | Compute time |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| vehicle_id | vehicles | One state row per vehicle |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| — | — | — |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(readiness)` | Readiness filter |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | Recommender Hard Filter (**only `ON_TRIP` drops**; `UPCOMING_TRIP` = colour hint; `STALE`/`UNKNOWN` = conflict signal, not drop) |
| Worker      | ReadinessService (derives `UPCOMING_TRIP`/`ON_TRIP` from LR Date / Next Trip) |
| Frontend    | Dashboards; SE Ticket Detail readiness colour hint |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | No (derived) |
| Retention      | Live |

### Notes

`ON_TRIP` blocks normal assignment (derived from the external LR Date / Next Trip signal + current system time). `UPCOMING_TRIP` (planned trip soon) and `STALE`/`UNKNOWN` are colour hints / conflict signals, **never** assignment blockers and **never** an SE-confirmation gate. `AT_PLANT` is confirmed **only by SE field action** — never inferred from LR Date. `EXPECTED_BACK` is **removed**. Raw readiness / LR Date **never** pauses SLA — only `vehicle_unavailability_reports` does.

---

## Table: `vehicle_availability_signal`

### Purpose

Raw readiness evidence; confidence = trust × freshness-decay; >120min ⇒ STALE. Append-only.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D10 — Readiness              |
| Primary Key  | `id bigserial`               |
| Append-only  | Yes                          |
| Partitioned  | No                           |
| Main Writer  | ingestion, ZM, SE submission, geofence |
| Main Readers | ReadinessService             |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| id | bigserial | No | — | Primary key |
| vehicle_id | bigint | No | — | Vehicle |
| source | text | No | — | Signal source — incl. `LR_NEXT_TRIP_EXTERNAL` (external LR Date / Next Trip app), Inplant/Gate, Fleet App, ZM, GPS geofence, SE submission |
| signal | text | No | — | Signal value |
| lr_date | date | Yes | — | LR (loading-receipt) date from the external app — planning hint only |
| next_trip_at | timestamptz | Yes | — | Next planned trip time — feeds `UPCOMING_TRIP`/`ON_TRIP` derivation |
| trust_score | numeric | Yes | — | Source trust |
| received_at | timestamptz | No | — | Receipt time |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| vehicle_id | vehicles | Vehicle |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| — | — | — |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(vehicle_id, received_at DESC)` | Latest signal per vehicle |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | — |
| Worker      | ReadinessService |
| Frontend    | — |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | No |
| Retention      | 90 days |

### Notes

Only the latest signals matter; old evidence is purged. The **external LR Date / Next Trip** signal (`source = LR_NEXT_TRIP_EXTERNAL`, ingested via `POST /api/vehicle-availability/lr-next-trip`) is a **planning hint only**: it feeds `UPCOMING_TRIP` and (with current system time) `ON_TRIP`, but must **not** become the only source of truth, must **not** pause SLA, and must **not** confirm `AT_PLANT`.

---

## Table: `vehicle_unavailability_reports`

### Purpose

The **only** vehicle-side SLA-pause trigger (raw readiness never pauses). An auditable human signal.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D10 — Readiness              |
| Primary Key  | `id bigserial`               |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | SE mobile, ScheduleService   |
| Main Readers | ZM/CSM/Operations Head dashboards, SLA pause logic, VehicleUnavailResurfaceWorker |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| id | bigserial | No | — | Primary key |
| ticket_id | uuid | No | — | Subject ticket |
| se_id | uuid | No | — | Reporting SE (SE-typed FK → engineer_master) |
| reason_code | veh_unavail_reason (enum) | No | — | `VEHICLE_ON_TRIP`/`VEHICLE_NOT_AT_PLANT`/`DRIVER_NOT_AVAILABLE`/`CUSTOMER_REFUSED`/`OTHER` |
| transporter_contacted | bool | No | — | Was transporter contacted |
| transporter_name | text | Yes | — | Transporter name |
| transporter_contact | text | Yes | — | Transporter contact |
| expected_available_from | timestamptz | Yes | — | Expected availability start |
| expected_available_to | timestamptz | Yes | — | Expected availability end |
| notes | text | Yes | — | Notes |
| se_lat | double precision | Yes | — | SE latitude |
| se_lon | double precision | Yes | — | SE longitude |
| confirmed_by | uuid | Yes | — | Confirming actor |
| resumed_at | timestamptz | Yes | — | SLA resume time |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| ticket_id | tickets | Subject ticket |
| se_id | engineer_master(engineer_id) | Reporting SE |
| confirmed_by | users | Confirming actor |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| — | — | — |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(ticket_id)` | Ticket lookup |
| `(expected_available_to) WHERE resumed_at IS NULL` | Resurfacing scan |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | `/api/tickets/{id}/vehicle-unavailable\|vehicle-availability` |
| Worker      | VehicleUnavailResurface (hourly) |
| Frontend    | ZM/CSM/Operations Head dashboards |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Pause/resume audited |
| Retention      | With ticket |

### Notes

Pauses primary SLA with `pause_reason=VEHICLE_UNAVAILABLE`.

---

## Table: `submission_components`

### Purpose

Components used in a submission; drives inventory movement and Shadow Use forensics.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D11 — Forms & Idempotency    |
| Primary Key  | `id bigserial`               |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | SE mobile                    |
| Main Readers | InventoryService, Shadow Use |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| id | bigserial | No | — | Primary key |
| submission_id | uuid | No | — | Parent submission |
| component_id | bigint | No | — | Component used |
| quantity_used | int | No | — | Quantity |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| submission_id | troubleshooting_submissions | Parent submission |
| component_id | component_master | Component used |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique | `(submission_id, component_id)` | One row per component per submission |
| Check | `quantity_used > 0` | Positive quantity |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| — | — |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | — |
| Worker      | InventoryService, Shadow Use |
| Frontend    | SE mobile |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Via inventory |
| Retention      | Permanent |

### Notes

—

---

## Table: `offline_submission_receipts`

### Purpose

The canonical server-side idempotency ledger across all submission types. Append-only.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D11 — Forms & Idempotency    |
| Primary Key  | `id bigserial`               |
| Append-only  | Yes                          |
| Partitioned  | No                           |
| Main Writer  | IdempotencyInterceptor, OfflineSync |
| Main Readers | IdempotencyInterceptor, OfflineSync |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| id | bigserial | No | — | Primary key |
| se_id | uuid | No | — | Submitting SE |
| submission_type | submission_type (enum) | No | — | Submission type |
| client_submission_id | uuid | No | — | Client idempotency id |
| result_ref | text | Yes | — | Created entity id |
| outcome | receipt_outcome (enum) | No | — | `CREATED`/`DUPLICATE`/`CONFLICT` |
| responded_at | timestamptz | No | `now()` | Response time |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| — | — | — |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique | `(se_id, submission_type, client_submission_id)` | **The canonical idempotency key** (invariant I7) |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| UQ serves lookups | Idempotency resolve |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | IdempotencyInterceptor |
| Worker      | OfflineSync |
| Frontend    | — |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | No |
| Retention      | 12 months (covers offline retention windows) |

### Notes

—

---

## Table: `component_master`

### Purpose

Master list of all components referenced anywhere in the system.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D12 — Inventory              |
| Primary Key  | `component_id bigserial`     |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | Operations Head              |
| Main Readers | everywhere a component is referenced |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| component_id | bigserial | No | — | Primary key |
| name | text | No | — | Component name |
| category | text | Yes | — | Category |
| serial_tracked | bool | No | `false` | GPS/SIM = true |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| — | — | — |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique | `(name)` | Unique component name |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| — | — |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | everywhere component-referenced |
| Worker      | — |
| Frontend    | — |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | (not specified) |
| Retention      | Permanent |

### Notes

—

---

## Table: `component_serial`

### Purpose

Serial-number tracking for serial-tracked GPS/SIM components.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D12 — Inventory              |
| Primary Key  | `id bigserial`               |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | Warehouse Manager, Install   |
| Main Readers | Recovery verification, warehouse reconcile |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| id | bigserial | No | — | Primary key |
| component_id | bigint | No | — | Component |
| serial_no | text | No | — | Serial number |
| current_location | text | Yes | — | Warehouse/SE/installed ref (genuinely open — text) |
| status | text | Yes | — | Serial status (genuinely open — text) |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| component_id | component_master | Component |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique | `(component_id, serial_no)` | Unique serial per component |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| — | — |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | Recovery verification, warehouse reconcile |
| Worker      | — |
| Frontend    | — |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Movement audited |
| Retention      | Permanent |

### Notes

`current_location`/`status` stay `text` (genuinely open value sets) — see Open Question Q7 about promoting to typed FKs.

---

## Table: `common_kit_definition`

### Purpose

Configuration list of components an SE must carry in the Common Kit; input to the Recommender Common-Kit Hard Filter.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D12 — Inventory              |
| Primary Key  | `id bigserial`               |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | Operations Head              |
| Main Readers | Recommender Common-Kit Hard Filter |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| id | bigserial | No | — | Primary key |
| component_id | bigint | No | — | Kit component |
| min_qty | int | No | — | Minimum quantity to carry |
| active | bool | No | `true` | Active flag |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| component_id | component_master | Kit component |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique | `(component_id)` | One row per component |
| Check | `min_qty > 0` | Positive minimum |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| — | — |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | Recommender Common-Kit Hard Filter |
| Worker      | — |
| Frontend    | — |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Config |
| Retention      | Permanent |

### Notes

—

---

## Table: `se_van_stock`

### Purpose

Components physically carried per SE; the Common-Kit source. Decremented on consumption (including Shadow Use). Read-only to the SE; written only via inventory transactions.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D12 — Inventory              |
| Primary Key  | `id bigserial`               |
| Append-only  | No (upsert qty)              |
| Partitioned  | No                           |
| Main Writer  | InventoryService (via transactions only) |
| Main Readers | Recommender Hard Filter, reports |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| id | bigserial | No | — | Primary key |
| se_id | uuid | No | — | SE (SE-typed FK → engineer_master) |
| component_id | bigint | No | — | Component |
| qty | int | No | `0` | Quantity carried |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| se_id | engineer_master(engineer_id) | Owning SE |
| component_id | component_master | Component |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique | `(se_id, component_id)` | One stock row per SE/component |
| Check | `qty >= 0` | Non-negative stock |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| — | — |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | Recommender Hard Filter, reports |
| Worker      | InventoryService |
| Frontend    | SE mobile (read-only) |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Via `inventory_transactions` |
| Retention      | Live |

### Notes

Shadow Use decrements van stock regardless of a 409 (invariant I9).

---

## Table: `warehouse_stock`

### Purpose

Per-warehouse component stock levels.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D12 — Inventory              |
| Primary Key  | `id bigserial`               |
| Append-only  | No (upsert qty)              |
| Partitioned  | No                           |
| Main Writer  | Warehouse Manager, InventoryService |
| Main Readers | Recommender (expected-component leg), reports |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| id | bigserial | No | — | Primary key |
| warehouse_id | bigint | No | — | Warehouse |
| component_id | bigint | No | — | Component |
| qty | int | No | `0` | Quantity |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| warehouse_id | warehouses | Stock point |
| component_id | component_master | Component |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique | `(warehouse_id, component_id)` | One row per warehouse/component |
| Check | `qty >= 0` | Non-negative stock |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| — | — |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | Recommender (expected-component leg: van OR Zone Warehouse), reports |
| Worker      | InventoryService |
| Frontend    | Warehouse Manager |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Via transactions |
| Retention      | Live |

### Notes

—

---

## Table: `inventory_transactions`

### Purpose

Every inventory movement; an append-only ledger. References the parent submission lineage so retries never double-move stock; carries Shadow Use.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D12 — Inventory              |
| Primary Key  | `txn_id bigserial`           |
| Append-only  | Yes                          |
| Partitioned  | No                           |
| Main Writer  | InventoryService, OfflineSync |
| Main Readers | Warehouse Manager queues, reports |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| txn_id | bigserial | No | — | Primary key |
| type | inv_txn_type (enum) | No | — | Movement category |
| status | inv_txn_status (enum) | No | — | Movement status |
| component_id | bigint | No | — | Component |
| quantity_delta | int | No | — | Sign = direction |
| se_id | uuid | Yes | — | SE (SE-typed FK → engineer_master) |
| ticket_id | uuid | Yes | — | Related ticket |
| submission_id | uuid | Yes | — | Parent submission (lineage) |
| warehouse_id | bigint | Yes | — | Warehouse |
| rejection_reason | text | Yes | — | Rejection reason |
| created_by | uuid | Yes | — | Creating actor |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| component_id | component_master | Component |
| se_id | engineer_master(engineer_id) | SE |
| ticket_id | tickets | Related ticket |
| submission_id | troubleshooting_submissions | Idempotency lineage |
| warehouse_id | warehouses | Warehouse |
| created_by | users | Creating actor |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Append-only | No UPDATE/DELETE (grants) | Financial/forensic immutability |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| partial `(status) WHERE status='SHADOW_USE'` | Shadow Use Queue |
| `(ticket_id)` | Ticket movements |
| `(se_id)` | SE movements |
| `(submission_id)` | Lineage lookup |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | `/api/inventory/shadow-use-queue`, `/reconcile` |
| Worker      | InventoryService, OfflineSync |
| Frontend    | Warehouse Manager queues, reports |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Every row is audit-grade; reconcile audited |
| Retention      | Permanent (financial/forensic) |

### Notes

**Lifecycle:** accepted form → `PRE_VERIFICATION`; GPS VERIFIED → `DEDUCTED`; FAILED → ZM picks `ROLLED_BACK`/`DEDUCTED_UNVERIFIED`; 409 with components → `SHADOW_USE` + van stock decremented regardless. Accounting categories are enum *values*, not separate tables.

---

## Table: `component_requests`

### Purpose

Formal warehouse request raised when `component_unavailable=true`; pauses SLA (`WAITING_COMPONENT`). Sized for the Phase-2 courier model.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D13 — Component Requests     |
| Primary Key  | `request_id uuid`            |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | SE mobile, Warehouse Manager, ComponentRequestService |
| Main Readers | ZM dashboard (read-only), SLA pause logic, ComponentSlaWorker |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| request_id | uuid | No | — | Primary key |
| ticket_id | uuid | No | — | Subject ticket |
| failure_cycle_id | uuid | No | — | Subject cycle |
| client_submission_id | uuid | No | — | Originating form's UUID (reused) |
| se_id | uuid | No | — | Requesting SE (SE-typed FK → engineer_master) |
| component_id | bigint | No | — | Requested component |
| quantity_requested | int | No | — | Quantity |
| status | comp_req_status (enum) | No | `'REQUESTED'` | `REQUESTED`/`APPROVED`/`REJECTED`/`SHIPPED`/`RECEIVED` (+ Phase-2 states) |
| delivery_destination | delivery_dest (enum) | Yes | — | `SE_LOCATION`/`PLANT_WAREHOUSE` |
| approved_by | uuid | Yes | — | Approver |
| reject_reason | text | Yes | — | Rejection reason |
| shipped_at | timestamptz | Yes | — | Ship time |
| received_at | timestamptz | Yes | — | Receipt time |
| tracking_ref | text | Yes | — | Tracking ref (v2) |
| in_transit_at | timestamptz | Yes | — | In-transit time (v2) |
| delivered_at | timestamptz | Yes | — | Delivered time (v2) |
| version | int | No | `0` | Optimistic-concurrency token |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| ticket_id | tickets | Subject ticket |
| failure_cycle_id | failure_cycles | Subject cycle |
| se_id | engineer_master(engineer_id) | Requesting SE |
| component_id | component_master | Requested component |
| approved_by | users | Approver |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique | `(se_id, client_submission_id)` | Idempotency; a form retry never opens a duplicate request |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(ticket_id)` | Ticket lookup |
| `(status)` | Component-wait escalation scan |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | `/api/component-requests/*` |
| Worker      | ComponentSla (7-day → ZM Action Required) |
| Frontend    | ZM dashboard (read-only) |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Decision/ship/receipt audited |
| Retention      | Permanent |

### Notes

`client_submission_id` is the originating troubleshooting form's UUID (the auto-created request reuses it; distinguished in `offline_submission_receipts` by `submission_type = COMPONENT_REQUEST`). SLA resumes at the **ZM-confirmed resubmit binding** (Decision §8), not on warehouse receipt.

---

## Table: `system_settings`

### Purpose

Typed registry — the home for every "configurable default". No magic numbers anywhere else.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D17 — Notify, Audit, Config  |
| Primary Key  | `key text`                   |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | Operations Head              |
| Main Readers | all services                 |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| key | text | No | — | Setting key (PK) |
| value | jsonb | No | — | Setting value |
| scope | settings_scope (enum) | No | — | `GLOBAL`/`ZONE` |
| zone_id | bigint | Yes | — | Zone (for ZONE scope) |
| value_type | text | No | — | Value type (genuinely open — text) |
| updated_by | uuid | Yes | — | Updating actor |
| updated_at | timestamptz | No | `now()` | Update time |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| zone_id | zones | Zone-scoped settings |
| updated_by | users | Updating actor |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Check | `scope='ZONE' ⇒ zone_id IS NOT NULL` | Zone scope needs a zone |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| — | — |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | all services |
| Worker      | all workers |
| Frontend    | Config screens |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Config changes audited |
| Retention      | Permanent |

### Notes

Registry contents (launch defaults) include: `inactivity_threshold_hours=24`, `verify_phase1_radius_m=500`, `acceptance_timeout_min=10`, `component_wait_escalation_days=7`, `recovery_no_progress_escalation_days=14`, `deficit_mode_threshold_pct=2`, `non_op_default_window_days=90/365`, `non_op_confirm_token_ttl_days=7`, `platinum_autoescalation_*`, etc.

---

## Table: `sla_config`

### Purpose

Typed SLA timing configuration per bucket / company tier.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D17 — Notify, Audit, Config  |
| Primary Key  | `id bigserial`               |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | Operations Head              |
| Main Readers | SLA engine                   |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| id | bigserial | No | — | Primary key |
| scope | text | No | — | `bucket`/`company_tier` |
| key | text | No | — | Scope key |
| submit_within_minutes | int | Yes | — | Submit SLA |
| verify_within_minutes | int | Yes | — | Verify SLA |
| escalate_after_minutes | int | Yes | — | Escalation SLA |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| — | — | — |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique | `(scope, key)` | One row per scope/key |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| — | — |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | SLA engine |
| Worker      | SLA engine |
| Frontend    | Config screens |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Config |
| Retention      | Permanent |

### Notes

Modelled global (`scope=bucket|company_tier`); per-zone scope is additive if needed (Open Question Q6).

---

## Table: `priority_rule_config`

### Purpose

Versioned, tunable Recommender scoring weights.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D17 — Notify, Audit, Config  |
| Primary Key  | `id bigserial`               |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | Operations Head              |
| Main Readers | Recommender                  |
| Phase        | Phase 2                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| id | bigserial | No | — | Primary key |
| weight_set_ref | text | No | — | Weight-set version reference |
| component | text | No | — | Scoring component |
| weight | numeric | No | — | Weight value |
| active | bool | No | `true` | Active flag |
| effective_from | timestamptz | Yes | — | Effective date |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| — | — | — |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| — | — | — |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(weight_set_ref, active)` | Active weight set lookup |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | Recommender |
| Worker      | BatchAssignment |
| Frontend    | Config screens |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Config |
| Retention      | Permanent (versioned) |

### Notes

Each batch run records the active `weight_set_ref` in `recommendations.score_breakdown`.

---

# Phase 3 — Advanced Tables

---

## Table: `device_uptime_daily`

### Purpose

Per-device per-day online fraction — the integrable time-series that the monthly time-weighted Fleet Uptime KPI requires (which `device_states`, a single-row upsert, cannot provide). Monthly range-partitioned.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D5 — Device State & KPI      |
| Primary Key  | `(device_id, day)`           |
| Append-only  | Yes                          |
| Partitioned  | Yes (RANGE by `day`, monthly) |
| Main Writer  | DeviceStateService (daily roll) |
| Main Readers | FleetUptimeMonthlyWorker     |
| Phase        | Phase 3                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| device_id | bigint | No | — | Device (part of PK) |
| day | date | No | — | Day (part of PK; partition key) |
| online_seconds | int | No | `0` | Seconds online |
| measured_seconds | int | No | `0` | Seconds measured |
| eligible | bool | No | — | Uptime eligibility for the day |
| zone_id | bigint | Yes | — | Denormalised |
| company_id | bigint | Yes | — | Denormalised |
| plant_id | bigint | Yes | — | Denormalised |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| — | — | (denormalised scope columns; no FK noted in source) |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Check | `online_seconds BETWEEN 0 AND measured_seconds` | Valid fraction |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(day, zone_id)` | Monthly KPI rollup by zone |
| `(day, company_id)` | Monthly KPI rollup by company |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | — |
| Worker      | DeviceStateService (write), FleetUptimeMonthlyWorker (read) |
| Frontend    | — |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | No |
| Retention      | 24 months online; archive beyond |

### Notes

**Added table** — the time-series source for time-weighted Fleet Uptime.

---

## Table: `fleet_uptime_monthly`

### Purpose

The stored, reproducible monthly Fleet Uptime % per reporting scope — the contractual number on company SLA reports.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D5 — Device State & KPI      |
| Primary Key  | `id bigserial`               |
| Append-only  | No (recompute-replace)       |
| Partitioned  | No                           |
| Main Writer  | FleetUptimeMonthlyWorker     |
| Main Readers | `/reports`, company SLA export |
| Phase        | Phase 3                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| id | bigserial | No | — | Primary key |
| period_month | date | No | — | First-of-month |
| scope | uptime_scope (enum) | No | — | `FLEET`/`ZONE`/`COMPANY`/`PLANT` |
| scope_id | bigint | Yes | — | Scope id |
| eligible_device_count | int | No | — | Denominator |
| uptime_pct | numeric(5,2) | No | — | Uptime percentage |
| computed_at | timestamptz | No | — | Compute time |
| weight_set_ref | text | Yes | — | Weight-set reference |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| — | — | — |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique | `(period_month, scope, scope_id)` | One row per scope per month |
| Check | `uptime_pct BETWEEN 0 AND 100` | Valid percentage |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(period_month)` | Period scan |
| `(scope, scope_id)` | Scope lookup |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | `/reports`, company SLA export |
| Worker      | FleetUptimeMonthlyWorker (recompute-replace, idempotent on `(zone,month)`) |
| Frontend    | Reports |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Recompute logged |
| Retention      | Permanent (contractual) |

### Notes

**Added table.** Denominator = Eligible Devices only (invariant I20). Per-device monthly breakdown is derivable from `device_uptime_daily` on demand — no per-device monthly table (Open Question Q1).

---

## Table: `device_downtime_summary_monthly`

### Purpose

Per-device per-month downtime rollup powering the **Device Lifetime Downtime Trend** on Device Detail. Recent detailed downtime comes from hot operational records (`failure_cycles`/`tickets`/`ticket_events`/`troubleshooting_submissions`/`verification_runs`); this table serves the lifetime trend so dashboards never scan multi-year raw history.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D16 — Analytics & Summary    |
| Primary Key  | `(device_id, month)`         |
| Append-only  | No (recompute-replace)       |
| Partitioned  | No                           |
| Main Writer  | DeviceDowntimeSummaryWorker  |
| Main Readers | `/api/devices/{id}/downtime-trend`, reports |
| Phase        | Phase 7                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| device_id | bigint | No | — | Device (part of PK) |
| month | date | No | — | First-of-month (part of PK) |
| downtime_cycles | int | No | `0` | Failure Cycles in the month |
| downtime_hours | numeric | No | `0` | Total downtime hours |
| avg_time_to_recover_hours | numeric | Yes | — | Mean time to recover |
| longest_episode_hours | numeric | Yes | — | Longest single downtime episode |
| auto_recovery_count | int | No | `0` | Auto-recovery closures |
| se_repaired_count | int | No | `0` | SE-repaired closures |
| repeat_failure_count | int | No | `0` | Repeat-failure cycles |
| component_related_hours | numeric | Yes | — | Downtime attributable to component blocks |
| zone_id | bigint | Yes | — | Denormalised filter |
| company_id | bigint | Yes | — | Denormalised filter |
| plant_id | bigint | Yes | — | Denormalised filter |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(device_id, month)` | Device lifetime trend |
| `(month, zone_id)` / `(month, company_id)` / `(month, plant_id)` | Scoped rollups |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | `/api/devices/{id}/downtime-trend` |
| Worker      | DeviceDowntimeSummaryWorker (write) |
| Frontend    | Device Detail trend views |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | No |
| Retention      | Permanent (summary) |

### Notes

**Added table** (2026-06-09). Lifetime trend source; never a multi-year raw scan.

---

## Table: `root_cause_summary_monthly`

### Purpose

Monthly root-cause distribution for **Root Cause Analytics %** — built from the structured `troubleshooting_submissions.root_cause_category`, **not** free-text `diagnosis_notes`.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D16 — Analytics & Summary    |
| Primary Key  | `id bigserial`               |
| Append-only  | No (recompute-replace)       |
| Partitioned  | No                           |
| Main Writer  | RootCauseSummaryWorker       |
| Main Readers | `/api/reports/root-cause`    |
| Phase        | Phase 7                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| id | bigserial | No | — | Primary key |
| month | date | No | — | First-of-month |
| root_cause_category | root_cause_category (enum) | No | — | The category counted |
| count | int | No | `0` | Submissions in the cell |
| zone_id | bigint | Yes | — | Filter scope |
| company_id | bigint | Yes | — | Filter scope |
| plant_id | bigint | Yes | — | Filter scope |
| device_type | text | Yes | — | Filter scope |
| se_id | uuid | Yes | — | Filter scope |
| fleet_id | bigint | Yes | — | Filter scope |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(month, root_cause_category)` | Distribution lookup |
| `(month, zone_id)` / `(month, company_id)` / `(month, plant_id)` | Scoped filters |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | `/api/reports/root-cause` |
| Worker      | RootCauseSummaryWorker (write) |
| Frontend    | Root Cause Analytics |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | No |
| Retention      | Permanent (summary) |

### Notes

**Added table** (2026-06-09). Filterable by fleet/zone/company/plant/device-type/SE/period.

---

## Table: `system_efficiency_summary_daily`

### Purpose

Daily end-to-end operational metrics for the **System Efficiency Report** — measures whether the FSM system reduces downtime and improves operations. Served from this table for long ranges.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D16 — Analytics & Summary    |
| Primary Key  | `id bigserial`               |
| Append-only  | No (recompute-replace)       |
| Partitioned  | No                           |
| Main Writer  | SystemEfficiencySummaryWorker |
| Main Readers | `/api/reports/system-efficiency` |
| Phase        | Phase 7                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| id | bigserial | No | — | Primary key |
| day | date | No | — | Metric day |
| zone_id | bigint | Yes | — | Filter scope |
| company_id | bigint | Yes | — | Filter scope |
| plant_id | bigint | Yes | — | Filter scope |
| device_type | text | Yes | — | Filter scope |
| se_id | uuid | Yes | — | Filter scope |
| fleet_id | bigint | Yes | — | Filter scope |
| inactive_detected | int | No | `0` | Devices detected inactive |
| failure_cycles_created | int | No | `0` | Cycles opened |
| tickets_auto_created | int | No | `0` | Auto-created tickets |
| auto_assignment_success_rate | numeric | Yes | — | Auto-assignment success |
| manual_assignment_rate | numeric | Yes | — | Manual assignment share |
| zm_override_rate | numeric | Yes | — | ZM override share |
| detection_to_ticket_min | numeric | Yes | — | Avg detection→ticket |
| ticket_to_assignment_min | numeric | Yes | — | Avg ticket→assignment |
| assignment_to_onsite_min | numeric | Yes | — | Avg assignment→ON_SITE |
| onsite_to_submission_min | numeric | Yes | — | Avg ON_SITE→submission |
| submission_to_verification_min | numeric | Yes | — | Avg submission→verification |
| total_downtime_hours | numeric | Yes | — | Total downtime |
| avg_downtime_per_device_hours | numeric | Yes | — | Avg per device |
| sla_compliance_pct | numeric | Yes | — | SLA compliance % |
| primary_sla_pause_count | int | No | `0` | Primary-SLA pauses |
| secondary_sla_aging_count | int | No | `0` | Secondary-SLA aging |
| component_blocked_aging | numeric | Yes | — | Component-blocked aging |
| vehicle_unavailable_aging | numeric | Yes | — | Vehicle-unavailable aging |
| repeat_failure_rate | numeric | Yes | — | Repeat-failure rate |
| first_time_fix_rate | numeric | Yes | — | First-time-fix rate |
| failed_verification_rate | numeric | Yes | — | Failed-verification rate |
| auto_recovery_rate | numeric | Yes | — | Auto-recovery rate |
| warehouse_fulfilment_min | numeric | Yes | — | Component fulfilment time |
| recovery_closure_min | numeric | Yes | — | Recovery closure time |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(day)` | Range scan |
| `(day, zone_id)` / `(day, company_id)` / `(day, plant_id)` | Scoped filters |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | `/api/reports/system-efficiency` |
| Worker      | SystemEfficiencySummaryWorker (write) |
| Frontend    | System Efficiency Report |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | No |
| Retention      | Permanent (summary) |

### Notes

**Added table** (2026-06-09). End-to-end efficiency; filterable by fleet/zone/company/plant/device-type/SE/period.

---

## Table: `zm_performance_summary_monthly`

### Purpose

Per-ZM monthly aggregate for the **Zonal Manager Performance Scorecard** — visible to **Operations Head / Operations Manager only**. Measures the quality and impact of ZM decisions; computed from assignment history, audit logs, ticket events, SLA outcomes, and override records. **The ZM never writes scores and never sees this as a self-score / planning view.**

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D16 — Analytics & Summary    |
| Primary Key  | `id bigserial`               |
| Append-only  | No (recompute-replace)       |
| Partitioned  | No                           |
| Main Writer  | ZmPerformanceSummaryWorker   |
| Main Readers | `/api/reports/zm-scorecard` (OpsHead / Operations Manager only) |
| Phase        | Phase 7                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| id | bigserial | No | — | Primary key |
| zm_user_id | bigint | No | — | The Zonal Manager |
| zone_id | bigint | No | — | Their zone |
| month | date | No | — | First-of-month |
| assignments_reviewed | int | No | `0` | System assignments reviewed |
| overrides | int | No | `0` | ZM overrides |
| override_rate | numeric | Yes | — | Override share |
| override_after_onsite | int | No | `0` | Overrides after SE ON_SITE |
| reassignments | int | No | `0` | Reassignment count |
| split_batches | int | No | `0` | Split-batch count |
| deferrals | int | No | `0` | Deferred ticket count |
| manual_assignments | int | No | `0` | Manual assignment count |
| avg_time_to_intervention_min | numeric | Yes | — | Avg system-assignment→ZM intervention |
| sla_impact | numeric | Yes | — | SLA impact of overrides |
| tickets_improved | int | No | `0` | Tickets improved by intervention |
| tickets_delayed | int | No | `0` | Tickets delayed after intervention |
| se_overload_events | int | Yes | — | SE overload caused/reduced |
| long_pending_reduction | int | Yes | — | Long-pending reduction after planning |
| escalations_handled | int | No | `0` | Component/vehicle/repeat/recovery escalations handled |
| zone_sla_compliance_pct | numeric | Yes | — | Zone SLA compliance under this ZM |
| se_utilization_balance | numeric | Yes | — | SE utilization balance |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(month, zone_id)` | ZM-wise / zone comparison |
| `(zm_user_id, month)` | Per-ZM trend |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | `/api/reports/zm-scorecard` (RoleGuard: OpsHead / Operations Manager only) |
| Worker      | ZmPerformanceSummaryWorker (write) |
| Frontend    | Operations Head dashboard — ZM-wise comparison, zone drill-down, weekly/monthly trend. **Not on SE mobile; not a ZM self-score.** |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | No |
| Retention      | Permanent (summary) |

### Notes

**Added table** (2026-06-09). Scorecard is an Operations-Head/Operations-Manager tool only — never exposed to the ZM as a planning view.

---

## Table: `se_troubleshooting_summary_monthly`

### Purpose

Per-SE monthly troubleshooting aggregate (productivity, first-time-fix, failed-verification, auto-recovery split, root-cause mix). Feeds reports and ZM-scorecard inputs.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D16 — Analytics & Summary    |
| Primary Key  | `id bigserial`               |
| Append-only  | No (recompute-replace)       |
| Partitioned  | No                           |
| Main Writer  | SeTroubleshootingSummaryWorker |
| Main Readers | reports, ZM scorecard inputs |
| Phase        | Phase 7                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| id | bigserial | No | — | Primary key |
| se_id | uuid | No | — | The SE |
| month | date | No | — | First-of-month |
| submissions | int | No | `0` | Troubleshooting submissions |
| first_time_fix_rate | numeric | Yes | — | First-time-fix rate |
| failed_verification_rate | numeric | Yes | — | Failed-verification rate |
| auto_recovery_split | numeric | Yes | — | Auto-recovery vs repair split |
| root_cause_mix | jsonb | Yes | — | Root-cause distribution for this SE |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(se_id, month)` | Per-SE trend |
| `(month)` | Period scan |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | reports |
| Worker      | SeTroubleshootingSummaryWorker (write) |
| Frontend    | Reports |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | No |
| Retention      | Permanent (summary) |

### Notes

**Added table** (2026-06-09).

---

## Table: `recovery_details`

### Purpose

Recovery-specific sub-type fields, 1:1 child of `tickets`; carries mandatory Recovery closure-audit data.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D6 — Ticketing               |
| Primary Key  | `ticket_id uuid` (FK PK)     |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | Recovery service             |
| Main Readers | verification, dashboards, reports |
| Phase        | Phase 3                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| ticket_id | uuid | No | — | PK, FK → tickets |
| collected_device_serial | text | Yes | — | Collected device serial |
| condition_notes | text | Yes | — | Device condition notes |
| collected_at | timestamptz | Yes | — | Collection time |
| received_at_warehouse_at | timestamptz | Yes | — | Warehouse receipt time |
| warehouse_id | bigint | Yes | — | Receiving warehouse |
| unable_reason_code | unable_reason (enum) | Yes | — | `COMPANY_REFUSED`/`VEHICLE_UNREACHABLE`/`DEVICE_MISSING`/`OTHER` |
| closure_reason | text | Yes | — | Closure reason |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| ticket_id | tickets | 1:1 parent |
| warehouse_id | warehouses | Receiving warehouse |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| — | — | — |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| — | — |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | dashboards, reports |
| Worker      | verification |
| Frontend    | Recovery ticket detail |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Closure fields mandatory-audited (CONTEXT §Recovery) |
| Retention      | Permanent |

### Notes

**Added table.** Manual Recovery close records full audit (`closure_type`, reason, prev_state, serial); CSM only while acting (invariant I16).

---

## Table: `intraday_insertions`

### Purpose

The SE-Acceptance flow for urgent CRITICAL/HIGH_CRITICAL insertions; timeout / reroute / escalate.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D8 — Scheduling / Recommender |
| Primary Key  | `id bigserial`               |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | IntraDayWorker               |
| Main Readers | ZM Intra-day Queue, SE accept/decline |
| Phase        | Phase 3                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| id | bigserial | No | — | Primary key |
| ticket_id | uuid | No | — | Offered ticket |
| current_se_id | uuid | Yes | — | Current offeree (SE-typed FK → engineer_master) |
| state | insertion_state (enum) | No | `'OFFERED'` | `OFFERED`/`ACCEPTED`/`DECLINED`/`TIMED_OUT`/`REROUTED`/`ESCALATED` |
| offered_at | timestamptz | No | — | Offer time |
| acceptance_deadline | timestamptz | No | — | Acceptance deadline |
| decline_reason_code | decline_reason (enum) | Yes | — | `AT_CAPACITY`/`TRAVEL_TOO_FAR`/`VEHICLE_TROUBLE`/`OTHER` |
| retry_no | int | No | `0` | Retry number |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| ticket_id | tickets | Offered ticket |
| current_se_id | engineer_master(engineer_id) | Current offeree |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| — | — | — |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(ticket_id, retry_no)` | Retry chain |
| `(state)` | State scan |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | `/api/insertions/{id}/accept\|decline` |
| Worker      | IntraDay (Acceptance Timeout, ×3 retry → escalate) |
| Frontend    | ZM Intra-day Queue, SE accept/decline |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Yes |
| Retention      | 13 months |

### Notes

—

---

## Table: `cross_zone_escalations`

### Purpose

Platinum auto-escalation plus manual cross-zone requests; a capacity-planning signal.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D8 — Scheduling / Recommender |
| Primary Key  | `escalation_id bigserial`    |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | IntraDay, ZM, CSM            |
| Main Readers | Operations Head reports, dashboards |
| Phase        | Phase 3                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| escalation_id | bigserial | No | — | Primary key |
| ticket_id | uuid | No | — | Escalated ticket |
| trigger | escalation_trigger (enum) | No | — | `AUTO`/`MANUAL` |
| trigger_reason | text | Yes | — | Trigger reason |
| home_zone_id | bigint | No | — | Home zone |
| target_zone_id | bigint | Yes | — | Target zone |
| requesting_role | role (enum) | Yes | — | Requesting role |
| approving_role | role (enum) | Yes | — | Approving role |
| decision | escalation_decision (enum) | Yes | — | `APPROVED`/`DENIED`/`DEFERRED` |
| decided_at | timestamptz | Yes | — | Decision time |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| ticket_id | tickets | Escalated ticket |
| home_zone_id | zones | Home zone |
| target_zone_id | zones | Target zone |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| — | — | — |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(home_zone_id)` | Home-zone scan |
| `(ticket_id)` | Ticket lookup |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | `/api/tickets/{id}/escalate-cross-zone` |
| Worker      | IntraDay |
| Frontend    | Operations Head reports, dashboards |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Yes |
| Retention      | Permanent (governance) |

### Notes

—

---

## Table: `recommender_runtime_state`

### Purpose

The home for the twice-daily **Soft Inactive Count** and the **`DEFICIT`/`PREVENTIVE`** mode the Recommender reads at run start. `device_states` is per-device and cannot hold a fleet/zone aggregate; this is the only sink. Daily rows double as the §15 Q4 Soft-Inactive trend series.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D8 — Scheduling / Recommender |
| Primary Key  | `id bigserial`               |
| Append-only  | Yes (daily rows)             |
| Partitioned  | No                           |
| Main Writer  | SoftInactiveCountWorker (twice daily; idempotent on `(scan_slot, date)`) |
| Main Readers | BatchAssignmentWorker (mode gate at run start), `/reports` |
| Phase        | Phase 3                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| id | bigserial | No | — | Primary key |
| scope | text | No | — | `FLEET`/`ZONE` |
| scope_id | bigint | Yes | — | zone_id when `scope='ZONE'` |
| computed_at | timestamptz | No | — | Compute time |
| soft_inactive_count | int | No | — | Soft Inactive Count |
| eligible_count | int | No | — | Eligible device count |
| mode | recommender_mode (enum) | No | — | `DEFICIT`/`PREVENTIVE` |
| threshold_pct | numeric | No | — | Mode threshold |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| — | — | — |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique | `(scope, scope_id, computed_at)` | One row per scope per run |
| Check | `scope='ZONE' ⇒ scope_id IS NOT NULL` | Zone scope needs an id |
| Check | `soft_inactive_count >= 0` | Non-negative |
| Check | `eligible_count >= 0` | Non-negative |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(scope, scope_id, computed_at DESC)` | Recommender mode lookup |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | `/reports` (Soft Inactive trend) |
| Worker      | SoftInactiveCountWorker (write), BatchAssignmentWorker (read) |
| Frontend    | Reports |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | No (operational telemetry) |
| Retention      | 13 months, then archive |

### Notes

**Added table** (2026-06-08 grill). **Hard boundary:** this is a planning/scoring **bias only**. It must never override canonical assignment gates — Company Tier → Device (SLA) Bucket order (Decision §17), SE coverage scope, SE availability (`AVAILABLE`), Daily Capacity, `ON_TRIP` readiness blocking, component availability (Common Kit + expected-component Hard Filter), or ZM override authority. Mode never promotes an ineligible candidate, never reorders the tier/bucket gate, and never assigns outside coverage.

---

## Table: `role_unavailability`

### Purpose

Backup-cascade availability for ZM/CSM/Operations Head — distinct routing semantics from `se_availability`.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D9 — Availability            |
| Primary Key  | `id bigserial`               |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | self, higher role, heartbeat |
| Main Readers | escalation routing, acting-role resolution (`acted_as_role`) |
| Phase        | Phase 3                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| id | bigserial | No | — | Primary key |
| user_id | uuid | No | — | Subject user (role-polymorphic → users) |
| role | role (enum) | No | — | Role being made unavailable |
| from_ts | timestamptz | No | — | Window start |
| to_ts | timestamptz | Yes | — | Window end |
| set_by | uuid | Yes | — | Setter |
| reason | text | Yes | — | Reason |
| source | text | No | — | `SELF`/`HIGHER_ROLE`/`HEARTBEAT` |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| user_id | users | Role-polymorphic subject |
| set_by | users | Setter |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| — | — | — |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(user_id, from_ts)` | User window lookup |
| `(role)` | Role scan |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | escalation routing, acting-role resolution |
| Worker      | heartbeat |
| Frontend    | — |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Yes (activation up/down notifications) |
| Retention      | 24 months |

### Notes

`user_id` is role-polymorphic and references `users`, not `engineer_master`.

---

## Table: `expense_vouchers`

### Purpose

SE reimbursement header; reviewed by ZM, marked PAID by Operations Head, exported to Finance Excel.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D15 — Vouchers               |
| Primary Key  | `voucher_id uuid`            |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | SE mobile, ZM (review), Operations Head (mark PAID) |
| Main Readers | Finance Excel export, reports |
| Phase        | Phase 3                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| voucher_id | uuid | No | — | Primary key |
| se_id | uuid | No | — | SE (SE-typed FK → engineer_master) |
| client_submission_id | uuid | No | — | Client idempotency id |
| status | voucher_status (enum) | No | `'DRAFT'` | `DRAFT`/`SUBMITTED`/`ZONAL_MANAGER_REVIEW`/`APPROVED`/`REJECTED`/`NEEDS_CLARIFICATION`/`PAID` |
| plant_id | bigint | Yes | — | Plant |
| ticket_id | uuid | Yes | — | Related ticket |
| vehicle_id | bigint | Yes | — | Related vehicle |
| total_amount | numeric(12,2) | No | `0` | Total amount |
| reviewed_by | uuid | Yes | — | Reviewing ZM |
| review_notes | text | Yes | — | Review notes |
| paid_batch_ref | text | Yes | — | Payment batch reference |
| paid_at | timestamptz | Yes | — | Payment time |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| se_id | engineer_master(engineer_id) | Claiming SE |
| plant_id | plants | Plant |
| ticket_id | tickets | Related ticket |
| vehicle_id | vehicles | Related vehicle |
| reviewed_by | users | Reviewing actor |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique | `(se_id, client_submission_id)` | Idempotency |
| Check (service) | SE cannot self-approve | Separation of duties |
| Check | `status='PAID' ⇒` previously APPROVED | Valid payment path |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(status)` | Status filter |
| `(se_id)` | SE vouchers |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | `/api/vouchers/*` |
| Worker      | — |
| Frontend    | Finance Excel export, reports |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Review/pay audited |
| Retention      | 7 years (financial) |

### Notes

—

---

## Table: `expense_voucher_items`

### Purpose

Voucher line items; at least one photo across items is mandatory.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D15 — Vouchers               |
| Primary Key  | `item_id bigserial`          |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | SE mobile                    |
| Main Readers | ZM review (per-category limit check), export |
| Phase        | Phase 3                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| item_id | bigserial | No | — | Primary key |
| voucher_id | uuid | No | — | Parent voucher |
| category | expense_category (enum) | No | — | `TRAVEL`/`ACCOMMODATION`/`PARTS`/`TOOLS`/`MEAL`/`OTHER` |
| amount | numeric(12,2) | No | — | Line amount |
| merchant_vendor_name | text | Yes | — | Merchant/vendor |
| expense_datetime | timestamptz | Yes | — | Expense time |
| photo_ref | text | Yes | — | Photo reference |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| voucher_id | expense_vouchers | Parent voucher |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Check | `amount >= 0` | Non-negative amount |
| Check (service) | ≥1 photo across items | Receipt evidence |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(voucher_id)` | Voucher items |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | export |
| Worker      | — |
| Frontend    | ZM review (per-category limit check) |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | With voucher |
| Retention      | 7 years |

### Notes

—

---

## Table: `non_operational_markings`

### Purpose

Dual-confirmation exclusion of a Device from Fleet Uptime. On CONFIRMED it blocks new cycles, closes in-flight tickets, and spawns Recovery for RECURRING deals.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D16 — Non-Op & Recovery      |
| Primary Key  | `marking_id uuid`            |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | ZM, Operations Head, customer (tokenized), system |
| Main Readers | `device_eligibility` MV, TicketCreation block, Recovery auto-create, NonOpExpiryWorker |
| Phase        | Phase 3                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| marking_id | uuid | No | — | Primary key |
| device_id | bigint | No | — | Device |
| state | nonop_state (enum) | No | `'REQUESTED'` | `REQUESTED`/`AWAITING_CUSTOMER_CONFIRMATION`/`AWAITING_ZM_CONFIRMATION`/`CONFIRMED`/`ACTIVE`/`EXPIRED`/`UNMARKED` |
| initiated_by_role | role (enum) | Yes | — | Initiating role |
| awaiting_role | role (enum) | Yes | — | Awaiting role |
| confirmed_by_role | role (enum) | Yes | — | Confirming role |
| confirmed_at | timestamptz | Yes | — | Confirmation time |
| override_confirm | bool | No | `false` | Override-confirm flag |
| reason_code | nonop_reason (enum) | No | — | `VEHICLE_SCRAPPED`/`VEHICLE_SOLD`/`VEHICLE_ACCIDENT`/`COMPANY_PAUSED`/`DEVICE_REPLACEMENT_PENDING`/`COMPLIANCE_HOLD`/`OTHER` |
| notes | text | Yes | — | Notes |
| effective_from | timestamptz | Yes | — | Effective start |
| effective_to | timestamptz | Yes | — | Effective end |
| customer_confirm_token | text | Yes | — | High-entropy, **stored hashed**; manager-initiated branch only |
| customer_confirm_token_expires_at | timestamptz | Yes | `now() + non_op_confirm_token_ttl_days` | Token expiry (config default 7 days) |
| customer_confirm_token_used_at | timestamptz | Yes | — | Set on consumption; rejected if expired or already used |
| version | int | No | `0` | Optimistic-concurrency token |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| device_id | devices | Device |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Check | `reason_code='OTHER' ⇒ notes IS NOT NULL` | OTHER requires notes |
| Unique (partial) | `(device_id) WHERE state IN ('CONFIRMED','ACTIVE')` | One active marking per device (invariant I13) |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(device_id, state)` | Device marking lookup |
| `(state, effective_to)` | Expiry scan |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | TicketCreation block, Recovery auto-create |
| Worker      | NonOpExpiry (daily; effective_to → EXPIRED) |
| Frontend    | `device_eligibility` MV |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Every transition + override-confirm flagged |
| Retention      | Permanent (governance) |

### Notes

Takes effect only at CONFIRMED (dual-party). Recovery auto-created only for RECURRING deals + qualifying reason (invariant I14).

---

## Table: `notifications`

### Purpose

Per-channel notification delivery rows; idempotent under at-least-once redelivery.

### Basic Info

| Field        | Value                       |
| ------------ | --------------------------- |
| Domain       | D17 — Notify, Audit, Config  |
| Primary Key  | `notification_id bigserial`  |
| Append-only  | No                           |
| Partitioned  | No                           |
| Main Writer  | NotificationWorker           |
| Main Readers | dashboards, SE mobile, audit |
| Phase        | Phase 3                      |

### Columns

| Column Name | Type | Null? | Default | Description |
| ----------- | ---- | ----- | ------- | ----------- |
| notification_id | bigserial | No | — | Primary key |
| notification_event_id | text | No | — | Triggering domain event |
| recipient_user_id | uuid | No | — | Recipient |
| event_type | text | No | — | Event type |
| channel | notify_channel (enum) | No | — | `IN_APP`/`PUSH`/`SMS`/`WHATSAPP`/`EMAIL` |
| delivery_status | notify_status (enum) | No | `'QUEUED'` | `QUEUED`/`SENT`/`DELIVERED`/`FAILED` |
| payload | jsonb | Yes | — | Notification payload |
| fallback_step | int | Yes | — | Fallback chain step |
| sent_at | timestamptz | Yes | — | Send time |

### Foreign Keys

| Column | References | Purpose |
| ------ | ---------- | ------- |
| recipient_user_id | users | Recipient |

### Constraints

| Type | Rule / Columns | Purpose |
| ---- | -------------- | ------- |
| Unique | `(notification_event_id, channel)` | NotificationWorker idempotency key (invariant I23) |

### Indexes

| Index / Columns | Purpose |
| --------------- | ------- |
| `(recipient_user_id, sent_at DESC)` | Recipient timeline |
| `(delivery_status)` | Delivery-status scan |

### Used By

| Layer       | Usage |
| ----------- | ----- |
| Backend API | dashboards, SE mobile, audit |
| Worker      | Notification (fallback chain; WhatsApp first-class on SE Acceptance) |
| Frontend    | SE mobile, dashboards |

### Audit & Retention

| Item           | Rule   |
| -------------- | ------ |
| Audit Required | Delivery logged |
| Retention      | 6 months |

### Notes

—

---

# Views & Materialized Views (not tables — carried over for completeness)

These are **not** physical tables, but the original blueprint defines them and they are central to several flows above. Listed here so nothing is lost; see the original §7 for full definitions.

### Materialized Views (precomputed; refreshed)

| MV | Columns | Definition (summary) | Refresh trigger |
| -- | ------- | -------------------- | --------------- |
| `plant_eligible_floating_se` | `plant_id, se_id` | Precomputed `ST_Contains(polygon, plant.location)` ∪ district/region/state membership over `engineer_territory_coverage` | Nightly + on coverage edit |
| `device_eligibility` | `device_id, eligible_for_uptime, as_of_date` | Active PGI ≤15d **AND NOT** Non-Op CONFIRMED/ACTIVE | Daily + on PGI/Non-Op change |
| `mv_zone_dashboard_rollup` | `zone_id, bucket counts, open_tickets, blocked, waiting_component, at_risk` | Aggregate over `device_states` + `tickets` + `component_requests` per zone | On relevant writes / 1-min cadence; Redis-cached by zone |

### Query-time Views (always-fresh; never stored)

| View | Purpose |
| ---- | ------- |
| `v_se_activity_status` | Derives `AVAILABLE/ON_SITE/BUSY/SHIFT_ENDING/OFFLINE` from `se_availability.status` + active `soft_states` + `engineer_master.last_activity_at` + shift. **Never stored.** |
| `v_shared_pool` | `tickets WHERE status=OPEN AND assignment_state=UNASSIGNED AND plant_id ∈ caller's coverage`. Shared Pool is a scoped query, not an entity. |
| `v_sla_clocks` | Primary elapsed = `(now−opened_at) − accumulated_pause_seconds`; secondary = `now−opened_at`. |
| `v_technical_hints` | Latest `raw_device_snapshots` row per device mapped to advisory hint rules. Advisory only — never stored, never affects lifecycle. |

> **Shared Pool** is deliberately a view/query, **not a table** (no row to keep in sync). Technical Hints and SE Activity Status are likewise never stored.

---

# Naming Notes

> Read this section **before** writing any migration. The new blueprint and the current/existing backend may differ in table naming, and renaming production tables is not a no-op.

| # | Note |
| - | ---- |
| 1 | **`raw_device_snapshot` (singular) may exist in the current backend / live database.** The existing Prisma schema and DB may use the **singular** form. |
| 2 | **This blueprint uses `raw_device_snapshots` (plural).** All references in this document — and in the source blueprint — use the plural, partitioned form. |
| 3 | **Before migrating, check the current Prisma schema and the actual database tables.** Confirm the real table name in `schema.prisma` and in PostgreSQL (`\dt`) before assuming either name. Do not assume the plural form already exists. |
| 4 | **Do not blindly rename production tables.** A rename needs migration planning: a forward-only migration, FK/index/partition recreation, application-code updates (Prisma `@@map`), and a rollback path. Renaming a partitioned, high-volume table like `raw_device_snapshots` is especially sensitive — coordinate it as a deliberate, reviewed migration, never an ad-hoc rename. |
| 5 | **Other conventions to verify against the live schema before migrating:** SE-typed FKs target `engineer_master(engineer_id)` (not `users`) — per-table listings that still read "FK→users" for an SE-semantic column are overridden by this convention. `company_master` (not `CUSTOMER_MASTER`), `LONG_PENDING` (not `AGED_CRITICAL`), `OPERATIONS_HEAD` (no `ADMIN` role), and the `WAITING_COMPONENT` failure-cycle state (not a `VERIFICATION_PENDING_COMPONENT` ticket state) are the canonical names; older sources may use the superseded forms. |

---

## Suggested / Not in Original

*No tables have been added, renamed, or invented in this document beyond what the original blueprint already contains.* The tables the original itself flagged as **added** relative to the LLD's prior data-model pass (and which are therefore part of this blueprint, not new here) are: `warehouses`, `expected_components`, `device_uptime_daily`, `fleet_uptime_monthly`, `recovery_details`, and `recommender_runtime_state`. They are marked "Added table" in their Notes above.

Potential future tables the original lists only as **open questions** (NOT modelled, NOT created here):

- `install_upload_batches` — Install CSV provenance (Open Question Q8); interim solution is `tickets.import_batch_ref` + per-ticket `created_by`.
- A per-device monthly uptime table (Open Question Q1) — currently derivable from `device_uptime_daily`; not created.

---

*End of table-wise structured version. Source of truth remains `docs/backend/fsm-database-schema-blueprint.md`.*
