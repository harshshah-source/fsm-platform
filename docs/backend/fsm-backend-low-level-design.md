# FSM GPS Field Service Management — Backend Low-Level Design

> ⚠️ **DESIGN-TIME DOC (banner added 2026-07-12).** The Redis 7 / BullMQ / S3 / worker-process runtime this LLD assumes was **not adopted**: the shipped backend is a NestJS modular monolith with in-process `@nestjs/schedule` cron and no Redis/BullMQ/S3 (see `docs/SYSTEM-STATE-2026-07.md` §1.3). Business rules herein remain valid design reference; runtime/infra sections are historical.
> **Status:** Build blueprint · **Date:** 2026-06-08 · **Audience:** Senior backend engineers
> **Document type:** Backend architecture / low-level design. No production code in this document.

---

## 0. Source Hierarchy & How to Read This Document

This LLD is derived strictly from the canonical sources, in this precedence order. When two
sources conflict, the **higher** source wins and the lower is ignored.

| Precedence | Source | Authority |
|---|---|---|
| 1 (highest) | `CONTEXT.md` | Domain rules, glossary, resolved **Decisions §1–§18**, flagged-ambiguity resolutions |
| 2 | `docs/PRD-fsm-admin-dashboard.md` | Product / UI / API behaviour, page inventory, role matrix |
| 3 | `docs/workflows/fsm-business-technical-workflow.md` | End-to-end business + technical flow, worker/table/API/state-machine catalogue |
| 4 | Updated ADRs (`docs/adr/*`) | Decision history & rationale only |
| 5 (lowest) | Root `prd.md` | **Legacy / superseded** — used only for historical reference, never overrides 1–4 |

**Superseded rules that this document deliberately does NOT implement** (resolved in CONTEXT.md
*Flagged ambiguities* and Decisions; ADR-0011, ADR-0019, ADR-0020 are superseded):

- ❌ Root-PRD "shared pool is primary" → ✅ **Day Plan / Formal Assignment is primary**; Shared Pool is always-visible *secondary* work scoped to covered Plants.
- ❌ Root-PRD `REVIEW_PENDING` ticket state for uncertain readiness → ✅ **dropped**; presence is multi-signal, no ZM review gate.
- ❌ Root-PRD `VERIFICATION_PENDING_COMPONENT` literal → ✅ Failure Cycle `WAITING_COMPONENT` is the canonical signal; Ticket stays `OPEN`.
- ❌ Root-PRD `trust_score = 0.85` SE-confirmation screen → ✅ removed; `presence_source` multi-signal.
- ❌ Root-PRD blanket "every ping within ±500m" verification → ✅ three-phase; ±500m only on Phase-1 first ping.
- ❌ Root-PRD "Zone Head approves batches" / 08:00 gate → ✅ **no approval gate**; auto-dispatch + post-hoc override.
- ❌ Root-PRD "Admin persona" → ✅ **Operations Head** is the sole configurator.
- ❌ Root-PRD "SLA never pauses for vehicle unavailability" (ADR-0020) → ✅ a filed **Vehicle Unavailability Report** pauses primary SLA; raw readiness never does.
- ❌ Root-PRD "Zone Head" terminology → ✅ canonical term is **Zonal Manager**.
- ❌ Root-PRD "Customer/CUSTOMER_MASTER/customer_tier" → ✅ **Company** is canonical everywhere.
- ❌ Root-PRD "NG / Drishti" source → ✅ **AutoPlant DB**.

**Configurable-default convention.** Where the canonical sources leave a numeric/timing value
"implementation-defined" (Open Questions §31), this LLD models it as a row in a typed
`system_settings` registry (§7.x) with a stated launch default — never hard-coded, never left
as "TBD". The five genuinely business-blocked items from §31 are listed in §19.

---

## 1. Architecture Overview

### 1.1 Technology stack

| Concern | Choice | Rationale (grounded in sources) |
|---|---|---|
| Language / runtime | **Node.js 20 LTS + TypeScript (strict)** | `Prisma` is named in the build brief; dashboard (React/TS) and mobile (React Native/TS) share the TS ecosystem and DTO types. |
| HTTP framework | **NestJS** (modular monolith) | Module boundaries map 1:1 to the service catalogue (§24 of workflow). DI + guards give clean RBAC. |
| ORM | **Prisma** | Mandated. Typed schema, migrations, relation safety. |
| Primary DB | **PostgreSQL 16** | Relational integrity for state machines + audit; partial/unique indexes used heavily. |
| Geospatial | **PostGIS** extension | Hard dependency (CONTEXT.md Decision §6) for Floating-SE `ST_Contains` territory lookups. Prisma uses `Unsupported("geometry")` + raw SQL for geo queries. |
| Cache / ephemeral | **Redis 7** | Device-state cache, dashboard aggregates, rate limits, WebSocket fan-out, dedup fast-path. |
| Job queue / workers | **BullMQ** (Redis-backed) | Delayed jobs, repeatable cron jobs, retries with backoff, idempotent job keys for all workers. |
| Realtime | **WebSocket gateway** (`socket.io`) + **30s polling fallback** | PRD real-time sync requirement. |
| Object storage | **S3-compatible** (signed-URL upload) | Photo/receipt upload direct from mobile. |
| Push / messaging | **FCM/APNs**, **WhatsApp Business API**, SMS gateway, SMTP | NotificationService fallback chain + first-class WhatsApp on SE Acceptance. |
| Auth | **JWT access + refresh**, role + zone claims | Stateless API auth; mobile stores token in keychain. |

> The stack above is the chosen architecture, not a placeholder. Swapping the HTTP framework
> (NestJS) is reversible; swapping PostgreSQL/PostGIS/Prisma/Redis is treated as fixed because
> the domain (geo territory, time-series device states, audit immutability, offline idempotency
> ledger) depends on their guarantees.

### 1.2 Modular-monolith service map

One deployable, internally partitioned into modules with explicit boundaries. Each module owns
its tables (writers) and exposes typed services to others (readers). This matches the
worker/service catalogue in workflow §24 and keeps the Recommender's hot path in-process.

```
┌─────────────────────────────────────────────────────────────────────┐
│ API layer (NestJS controllers + guards: AuthGuard → RoleGuard →     │
│            ZoneScopeGuard → IdempotencyInterceptor)                  │
├─────────────────────────────────────────────────────────────────────┤
│ ingestion    │ device-state │ ticketing   │ recommender/scheduling   │
│ inventory    │ verification │ component   │ sla-clock                │
│ availability │ readiness    │ vouchers    │ non-operational/recovery │
│ notifications│ audit        │ reporting   │ settings/config          │
├─────────────────────────────────────────────────────────────────────┤
│ Workers (BullMQ): SnapshotIngestion · DeviceState · TicketCreation · │
│   BatchAssignment · IntraDay · Verification · ComponentSla ·         │
│   RepeatFailureScan · SoftInactiveCount · FleetUptimeMonthly ·       │
│   NonOpExpiry · Notification · AuditFlush                            │
├─────────────────────────────────────────────────────────────────────┤
│ PostgreSQL+PostGIS  │  Redis (cache + BullMQ)  │  S3  │  external APIs│
└─────────────────────────────────────────────────────────────────────┘
                         ▲
                         │ cursor-based pull
                  ┌──────┴───────┐
                  │ AutoPlant DB │ (read-only source of GPS telemetry)
                  └──────────────┘
```

### 1.3 End-to-end data flow (one sentence per hop)

1. `SnapshotIngestionWorker` pulls AutoPlant DB rows (cursor, chunked) → `raw_device_snapshots`.
2. `DeviceStateService` normalizes → upserts `device_states` (latest_gps, is_inactive, sla_bucket).
3. `TicketCreationService` opens `failure_cycles` + `tickets` for newly-inactive eligible devices.
4. `BatchAssignmentWorker` scores candidates → dispatches `work_schedules`/`plant_batch_assignments` directly to SE Day Plan.
5. SE mobile acts (soft states → form submission), online or via offline queue.
6. `VerificationWorker` watches device pings → closes Ticket / flags fraud.
7. `AuditService` records every transition; `ReportingService` rolls up Fleet Uptime monthly.

---

## 2. Cross-Cutting Conventions

| Convention | Rule |
|---|---|
| **Time** | All timestamps stored UTC (`timestamptz`). IST is a display concern only. Source GPS timestamps normalized to UTC at ingestion. |
| **IDs** | Business identifiers (`device_id`, `vehicle_no`) come from source; internal surrogate keys are `bigint` PKs (or `uuid` where externally referenced, e.g. tickets). `client_submission_id` is a client UUID. |
| **Enums** | Modelled as Postgres native enums via Prisma `enum`. Adding a value is an additive migration; never reuse a retired value. |
| **Soft delete** | Not used for domain objects; lifecycle is captured by state machines + immutable event logs. Config rows use `active` flags. |
| **Audit** | Every state-mutating service call emits an `audit_logs` row through `AuditService` in the same DB transaction as the mutation (outbox-free, single-tx) so audit can never silently drop (workflow §24 AuditService). |
| **Money** | `numeric(12,2)`; never float. |
| **Geometry** | `geometry(Point,4326)` for plant/device locations; `geometry(MultiPolygon,4326)` for Floating-SE polygons; GIST indexes. |
| **Optimistic concurrency** | `version int` column on hot mutable rows (`tickets`, `failure_cycles`, `component_requests`, `non_operational_markings`) guards lost updates under concurrent SE/ZM/worker writes. |
| **Naming** | DB = snake_case; CONTEXT.md UPPERCASE names map 1:1 (e.g. `SE_AVAILABILITY` → `se_availability`). |

---

## 3. Data Model — Schema by Module

Conventions for the tables below: **PK** is `id bigserial` unless noted; `created_at`/`updated_at`
(`timestamptz default now()`) exist on every table and are omitted. **W** = writers, **R** = readers.
The Idx line lists non-PK indexes; **UQ** = unique constraint.

### 3.1 Reference / Org module

#### `users`
| Column | Type | Notes |
|---|---|---|
| user_id | uuid PK | |
| name | text | |
| role | enum `OPERATIONS_HEAD \| CENTRAL_SERVICE_MANAGER \| ZONAL_MANAGER \| WAREHOUSE_MANAGER \| SERVICE_ENGINEER` | No `ADMIN` role — Operations Head is configurator. |
| zone_id | bigint FK→zones, nullable | NULL for fleet-wide roles. |
| phone, email | text | |
| status | enum `ACTIVE \| DISABLED` | |
| **UQ** | (email), (phone) | |
| **Idx** | (role), (zone_id) | |
- **W:** Operations Head (account mgmt). **R:** auth, all services (actor lookup).

#### `zones`
`zone_id` PK · `name` · `zonal_manager_user_id` FK→users. **UQ** (name). **W:** Operations Head. **R:** Recommender, dashboards, escalation routing.

#### `plants`
`plant_id` PK · `name` · `zone_id` FK · `district_id` FK→districts · `location geometry(Point,4326)` · `lat` · `lon`.
**Idx:** (zone_id); **GIST** (location). **W:** Operations Head. **R:** Recommender, coverage MV, dashboards.

#### `districts` / `regions`
Indian administrative units (≈700 districts). `district_id`, `name`, `state`, `region_id`. Used by Floating-SE hierarchical coverage. **W:** Operations Head / seed. **R:** territory lookup.

#### `transporters`
`transporter_id` PK · `name` · `plant_id` FK · `contact_phone`. **R:** SE mobile (Ticket Detail — name+contact required for Vehicle Unavailability Report), dashboards.

#### `company_master`
| Column | Type | Notes |
|---|---|---|
| company_id | bigint PK | |
| name | text | |
| company_tier | enum `PLATINUM \| GOLD \| SILVER` | Top-level scoring gate (Decision §3, §17). |
| company_priority_rank | text (`A`/`B`/`C`…) | Tie-break within tier. |
| contract fields | … | Sourced CRM/SAP; Operations Head can override. |
**Idx:** (company_tier, company_priority_rank). **W:** integration + Operations Head override. **R:** Recommender, reports.

#### `vehicles`
`vehicle_id` PK · `vehicle_no` (**UQ**) · `plant_id` FK · `transporter_id` FK · `company_id` FK · `readiness` enum (see §10). **W:** integration / install. **R:** TicketCreation, SE mobile, verification.

#### `devices`
`device_id` PK (business id from source) · `current_vehicle_id` FK→vehicles · `deal_type` enum `RECURRING \| ONE_TIME` (nullable → Operations Head manual tag fallback) · `device_type` · `sim_id`. **Idx:** (current_vehicle_id), (deal_type). **W:** integration / install / Operations Head. **R:** DeviceState, verification, Recovery logic.

#### `vehicle_device_mappings`
Time-windowed Vehicle↔Device with role; one vehicle → many devices.
`mapping_id` · `vehicle_id` FK · `device_id` FK · `device_role` enum `PRIMARY \| SECONDARY \| BACKUP \| COMPANY_SPECIFIC \| TEMPORARY \| UNKNOWN` · `from_ts` · `to_ts` (null = active).
**UQ partial:** `(device_id) WHERE to_ts IS NULL` — a device has exactly one active mapping.
**Idx:** (vehicle_id, to_ts). **W:** Install ACTIVATED, integration. **R:** DeviceState, **verification (per-device-id, never per-vehicle)**.

> **Rule (CONTEXT.md):** verification tracks the **specific `device_id`** named in the Ticket.
> A BACKUP device pinging never closes a PRIMARY device's Ticket.

### 3.2 Ingestion module

#### `snapshot_runs`
`run_id` PK · `started_at` · `finished_at` · `status` enum `RUNNING \| SUCCESS \| FAILED \| PARTIAL` · `cursor` (last processed AutoPlant cursor/max snapshot ts) · `data_as_of timestamptz` · `chunk_stats jsonb`.
**UQ partial:** `(status) WHERE status = 'RUNNING'` enforced via advisory lock (single in-flight run guard). **W:** SnapshotIngestionWorker. **R:** dashboards (data-as-of banner), ops alerts.

#### `snapshot_run_chunks`
`id` · `run_id` FK · `chunk_no` · `status` (`PENDING/SUCCESS/FAILED`) · `retry_count` · `error`. Enables per-chunk retry without restarting the run.

#### `raw_device_snapshots`
Point-in-time telemetry per device.
`id` · `run_id` FK · `device_id` · `gps_datetime timestamptz` · `lat` · `lon` · `mains_status` · `mains_voltage` · `gps_validity` · `gps_mode` · `ignition_status` · `speed` · `creg` · `cgreg` · `csq` · `ip_address` · `port_no` · `sim_subscriber_name` · `unit_no` · `device_type`.
**UQ:** (device_id, gps_datetime) → `INSERT … ON CONFLICT DO NOTHING` makes chunk re-runs idempotent.
**Idx:** (device_id, gps_datetime DESC) — hot path for verification ping queries.
**Partitioning:** range-partition by `gps_datetime` (monthly) — this is the highest-volume table (~50k devices × multiple pings/day). **W:** SnapshotIngestionWorker. **R:** DeviceState, VerificationWorker, Technical Hints.

#### `data_quality_errors` (engineering-owned, not surfaced to operations)
`id` · `device_id` · `severity` (`BLOCKING/WARNING/INFO`) · `field` · `detail` · `resolved`. Per CONTEXT.md flagged-ambiguity: handled silently; Operations Head never sees it.

### 3.3 Device-state module

#### `device_states`
Derived current state, one row per device (upsert).
`device_id` PK · `latest_gps_datetime` · `is_inactive bool` · `inactivity_hours numeric` · `sla_bucket` enum (see §9) · `eligible_for_uptime bool` · `has_open_failure_cycle bool` · `vehicle_id` · `plant_id` · `company_id` · `transporter_id` · `computed_at`.
**Idx:** (is_inactive, sla_bucket), (plant_id), (company_id), (eligible_for_uptime). **W:** DeviceStateService. **R:** TicketCreation, Recommender, dashboards. Mirrored into Redis `DEVICE_STATE_CACHE` (15-min TTL for open-ticket devices).

#### `device_eligibility` (materialized view, refreshed daily + on PGI/Non-Op change)
`device_id` · `eligible_for_uptime bool` · `as_of_date`. Derived from `pgi_history` (active PGI ≤15 days) AND not `non_operational_markings` CONFIRMED/ACTIVE. Denominator for Fleet Uptime %.

#### `pgi_history`
`id` · `device_id` · `pgi_date` · `order_ref`. Source: SAP. **R:** eligibility view.

### 3.4 Ticketing module

#### `failure_cycles`
| Column | Type | Notes |
|---|---|---|
| cycle_id | uuid PK | |
| device_id | bigint FK | |
| state | enum `OPEN \| WAITING_COMPONENT \| SUBMITTED \| VERIFIED \| FAILED \| REPEAT \| ESCALATED` | §13.1 |
| opened_at | timestamptz | SLA primary clock anchor. |
| closed_at | timestamptz null | |
| previous_failure_cycle_id | uuid null FK→self | repeat linkage |
| repeat_failure | bool | true if device re-failed ≤24h after a prior VERIFIED cycle |
| sla_paused | bool | |
| sla_pause_reason | enum `WAITING_COMPONENT \| VEHICLE_UNAVAILABLE` null | |
| sla_paused_at / sla_pause_source | timestamptz / enum | |
| sla_accumulated_pause_seconds | bigint | for primary-clock math |
| version | int | optimistic lock |

**UQ partial:** `(device_id) WHERE state IN ('OPEN','WAITING_COMPONENT','SUBMITTED')` — **one active episode per device** (duplicate-prevention invariant).
**Idx:** (state), (device_id, opened_at DESC), (previous_failure_cycle_id).
**W:** TicketCreation, VerificationWorker, ComponentRequest, SLA logic. **R:** Recommender, dashboards, reports. **Immutable once `VERIFIED`** (enforced in service + DB trigger refusing UPDATE on VERIFIED rows except audit-neutral fields).

#### `tickets`
| Column | Type | Notes |
|---|---|---|
| ticket_id | uuid PK | |
| work_type | enum `TROUBLESHOOT \| INSTALL \| RECOVERY` | immutable |
| status | enum (union of all sub-type states, see §13) | |
| failure_cycle_id | uuid null FK | NULL for INSTALL/RECOVERY |
| device_id, vehicle_id, plant_id, company_id | FKs | |
| se_id | uuid null FK→users | current assignee |
| assignment_state | enum `UNASSIGNED \| FORMALLY_ASSIGNED` | |
| install_trigger_source | enum `MANUAL_OPERATIONS` (v1) / `EXTERNAL_API` (v2 reserved) null | |
| created_by / created_by_role | uuid / enum | required for INSTALL (Decision §11) |
| closure_type | enum (see §13.4) null | RECOVERY/Non-Op closes |
| repeat_failure | bool | mirror from cycle for fast filtering |
| version | int | |

**UQ:** `(failure_cycle_id)` — one Ticket per Failure Cycle.
**Idx:** (status, plant_id), (se_id, status), (work_type, status), (company_id), partial `(plant_id) WHERE status='OPEN' AND assignment_state='UNASSIGNED'` (Shared Pool query).
**W:** TicketCreation, Install, Recovery, verification, schedule services. **R:** Recommender, SE mobile, dashboards.

#### `install_details` (1:1 child of INSTALL ticket)
`ticket_id` PK FK · `device_serial` · `sim_serial` · `target_date` · `fitted_at` · `activated_at` (warranty anchor) · `notes`.

#### `troubleshoot_details` (1:1 child of TROUBLESHOOT ticket)
`ticket_id` PK FK · denormalized current diagnosis summary, last submission pointer.

#### `ticket_events` (append-only)
`event_id` · `ticket_id` FK · `from_state` · `to_state` · `actor_id` · `actor_role` · `acted_as_role` null · `reason_code` null · `at`. **Idx:** (ticket_id, at). Drives history UI + reports; complements `audit_logs`.

### 3.5 Soft-state & presence module

#### `soft_states`
`soft_state_id` · `ticket_id` FK · `se_id` FK · `type` enum `VIEWED \| ON_SITE \| TROUBLESHOOT_STARTED` · `onsite_source` enum `AUTO_GEOFENCE \| MANUAL` null (ON_SITE only) · `set_at` · `timeout_at` (VIEWED only) · `resolved_at` null · `resolved_by` (`SE/ZM/SYSTEM`) · `resolution_reason` (mandatory for ZM force-resolve).
**Idx:** partial `(ticket_id) WHERE resolved_at IS NULL`, (se_id, resolved_at).
**Not a lock; multiple SEs may hold simultaneously.** ON_SITE / TROUBLESHOOT_STARTED **never auto-expire by time** (only VIEWED has `timeout_at`). **W:** SE mobile, ZM (force-resolve), SYSTEM (valid closure). **R:** ZM dashboard (Activity Status derivation), override conflict checks.

### 3.6 Scheduling / Recommender module

#### `work_schedules`
`schedule_id` · `se_id` FK · `zone_id` FK · `date_from` · `date_to` · `status` enum `ACTIVE \| OVERRIDDEN \| COMPLETED \| PARTIAL` · `source` enum `SYSTEM_GENERATED \| ZM_MANUAL` · `dispatched_at` · `last_overridden_by` · `last_overridden_at`.
**No `DRAFT`/`PENDING_REVIEW`/`APPROVED` — approval gate removed (Decision §7).**
**Idx:** (se_id, date_from), (zone_id, status). **W:** BatchAssignment, Schedule. **R:** SE mobile Day Plan, ZM dashboard.

#### `plant_batch_assignments`
`batch_id` · `schedule_id` FK · `plant_id` FK · `se_id` FK · `status` enum `AUTO_ASSIGNED \| OVERRIDDEN \| COMPLETED \| PARTIAL` · `stop_sequence` · `override_reason`. **W:** BatchAssignment, Schedule, ZonalOverride. **R:** SE mobile, ZM dashboard, reports.

#### `batch_assignment_tickets`
`id` · `batch_id` FK · `ticket_id` FK · `sort_order` · `deferred_to_date` null · `removed_at` null · `removed_by`. **UQ partial:** `(ticket_id) WHERE removed_at IS NULL` — a ticket is in one active batch at a time.

#### `recommendations` / `recommendation_history`
`recommendation_id` · `ticket_id` FK · `se_id` FK · `company_tier` · `device_bucket` · `score_breakdown jsonb` (weighted components + multipliers + active weight-set ref) · `processing_rank` · `status` · `path` enum `MORNING_BATCH \| INTRADAY` · `retry_chain jsonb` (intra-day: `[{se,offered_at,timed_out|accepted_at|declined}]`). **Immutable** — changes create new rows. **R:** ZM "why suggested?" panel, audit.

#### `se_coverage`
`id` · `se_id` FK · `plant_id` FK · `coverage_type` enum `DEDICATED \| MULTI_PLANT`. **UQ:** (se_id, plant_id). **W:** Operations Head. **R:** Recommender, dashboards.

#### `engineer_territory_coverage` (Floating SE)
`id` · `se_id` FK · `district_id` null FK · `region_id` null · `polygon geometry(MultiPolygon,4326)` null. **GIST** (polygon). Membership = union(district coverage, polygon coverage). **W:** Operations Head. **R:** Recommender (PostGIS), coverage MV.

#### `plant_eligible_floating_se` (materialized view, refreshed nightly + on coverage edit)
`plant_id` · `se_id`. Precomputes `ST_Contains` / district membership so the hot path is an index lookup (Decision §6).

#### `se_planner`
`id` · `se_id` FK · `plant_id` FK · `planned_date`. **UQ:** (se_id, plant_id, planned_date). ZM-authored bias signal to Morning Batch. **W:** ZM. **R:** BatchAssignment (bias), Day Plan.

#### `intraday_insertions`
`id` · `ticket_id` FK · `current_se_id` · `state` enum `OFFERED \| ACCEPTED \| DECLINED \| TIMED_OUT \| REROUTED \| ESCALATED` · `offered_at` · `acceptance_deadline` · `decline_reason_code` · `retry_no`. **W:** IntraDayService. **R:** ZM Intra-day Queue.

#### `cross_zone_escalations`
`escalation_id` · `ticket_id` FK · `trigger` (`AUTO/MANUAL`) · `trigger_reason` · `home_zone_id` · `target_zone_id` · `requesting_role` · `approving_role` · `decision` (`APPROVED/DENIED/DEFERRED`) · `decided_at`. **W:** IntraDay, ZM, CSM. **R:** Operations Head reports.

### 3.7 Availability module

#### `se_availability`
Single time-windowed table (Decision §10).
`id` · `engineer_id` FK · `from_ts` · `to_ts` · `status` enum `AVAILABLE \| ON_LEAVE \| OFF_SHIFT \| WEEKLY_OFF \| SOFT_UNAVAILABLE \| OFFLINE` · `reason_code` enum `SICK \| VACATION \| HOLIDAY \| DOCTOR \| TRAINING \| PERSONAL \| NETWORK_OUT \| OTHER` · `set_by` · `set_by_role` · `activity_sourced bool` (heartbeat-derived OFFLINE; excluded from leave reports) · `notes`.
**Constraint:** non-overlap per `engineer_id` per status family (enforced via exclusion constraint on a `tstzrange`). **Idx:** GIST `(engineer_id, tstzrange(from_ts,to_ts))`. **W:** ZM, SE, LeaveAvailability. **R:** Recommender Hard Filter, dashboards.

#### `leave_requests`
`request_id` · `se_id` FK · `leave_type` enum `ON_LEAVE \| WEEKLY_OFF` · `start_date` · `end_date` · `reason` · `status` enum `SUBMITTED \| APPROVED \| REJECTED` · `decided_by` · `decided_reason`. **W:** SE mobile, ZM. **R:** LeaveAvailability.

#### `role_unavailability`
Backup cascade for ZM/CSM/Operations Head (distinct routing semantics from `se_availability`, Decision §15).
`id` · `user_id` FK · `role` · `from_ts` · `to_ts` · `set_by` · `reason` · `source` (`SELF/HIGHER_ROLE/HEARTBEAT`). **R:** escalation routing, acting-role resolution.

#### `engineer_master` (SE profile + activity)
`engineer_id` PK FK→users · `coverage_type` enum `DEDICATED \| MULTI_PLANT \| FLOATING` · `zone_id` · `daily_capacity int` · `shift_start` · `shift_end` · `preferred_notification_channel` · `last_activity_at` (SE Activity Ping; **never** a background timer) · `is_active`. **R:** Recommender (15-min Hard Filter on `last_activity_at`), ZM dashboard (1h OFFLINE label).

### 3.8 Readiness module

#### `vehicle_readiness_state`
`vehicle_id` PK FK · `readiness` enum `AT_PLANT \| UPCOMING_TRIP \| ON_TRIP \| STALE \| UNKNOWN \| WAITING_CONFIRMATION \| AVAILABLE_FOR_REPAIR` · `confidence numeric` · `last_signal_at` · `computed_at`. **`EXPECTED_BACK` removed.** Hard Filter blocks **only `ON_TRIP`**. `AT_PLANT` is set **only by SE field action** (ON_SITE / deliberate location capture) — never inferred from LR Date. `UPCOMING_TRIP` (planned trip soon) and `STALE`/`UNKNOWN` (no fresh signal) are colour hints, never assignment blockers and never an SE-confirmation gate. Raw readiness never pauses SLA.

#### `vehicle_availability_signal`
`id` · `vehicle_id` FK · `source` (Inplant/Gate, Fleet App, ZM, GPS geofence, **LR Date / Next Trip external app** = `LR_NEXT_TRIP_EXTERNAL`, SE submission) · `signal` · `lr_date` null · `next_trip_at` null · `trust_score numeric` · `received_at`. Confidence = trust × freshness-decay; >120min ⇒ STALE. The **LR Date / Next Trip** signal is a planning hint from an external application: it feeds `UPCOMING_TRIP` and, with current system time, `ON_TRIP` — but **must not become the only source of truth, must not pause SLA, and must not confirm AT_PLANT.** Ingested via `POST /api/vehicle-availability/lr-next-trip` (§5.6).

#### `vehicle_unavailability_reports`
The **only** vehicle-side SLA-pause trigger (raw readiness never pauses).
`id` · `ticket_id` FK · `se_id` FK · `reason_code` enum `VEHICLE_ON_TRIP \| VEHICLE_NOT_AT_PLANT \| DRIVER_NOT_AVAILABLE \| CUSTOMER_REFUSED \| OTHER` · `transporter_contacted bool` · `transporter_name` · `transporter_contact` · `expected_available_from` · `expected_available_to` · `notes` · `se_lat` · `se_lon` · `confirmed_by` · `resumed_at`. **W:** SE mobile, Schedule. **R:** ZM/CSM/Operations Head dashboards, SLA pause logic, resurfacing job.

### 3.9 Form-submission & idempotency module

#### `troubleshooting_submissions`
1-to-many child of a Ticket (Decision §8: one cycle → one ticket → 1+ submissions).
`submission_id` · `ticket_id` FK · `failure_cycle_id` FK · `client_submission_id uuid` · `se_id` FK · `se_gps_lat` · `se_gps_lon` · `presence_source` enum `GEOFENCE_AUTO \| MANUAL_ONSITE \| FORM_GPS \| NONE` · `onsite_capture_gps` · `component_unavailable bool` · `component_unavailable_item` · **`root_cause_category` enum `POWER_ISSUE \| SIM_NETWORK_ISSUE \| GPS_ANTENNA_ISSUE \| DEVICE_HARDWARE_FAULT \| WIRING_ISSUE \| CONFIGURATION_ISSUE \| VEHICLE_ACCESS_ISSUE \| INSTALLATION_ISSUE \| CUSTOMER_SIDE_ISSUE \| UNKNOWN`** · `root_cause_subcategory` · `root_cause_notes` · `action_taken_category` · `action_taken_notes` · `diagnosis_notes` (free-text, supplementary only) · `submitted_at` · `photo_refs text[]`. **Root Cause Analytics reads `root_cause_category` — never free-text `diagnosis_notes`.**
**UQ:** (se_id, client_submission_id) — idempotency scope per submission_type is enforced via `offline_submission_receipts`; this UQ is the storage-level guard for troubleshoot forms.
**W:** SE mobile, OfflineSyncController. **R:** VerificationWorker, audit, reports.

#### `submission_components`
`id` · `submission_id` FK · `component_id` · `quantity_used`.

#### `offline_submission_receipts`
Server-side idempotency ledger keyed across all submission types.
`id` · `se_id` · `submission_type` enum `TROUBLESHOOTING_FORM \| EXPENSE_VOUCHER \| COMPONENT_REQUEST \| COMPONENT_RESUBMIT` · `client_submission_id uuid` · `result_ref` (the created entity id) · `outcome` enum `CREATED \| DUPLICATE \| CONFLICT` · `responded_at`.
**UQ:** (se_id, submission_type, client_submission_id) — the canonical idempotency key (CONTEXT.md). **W/R:** OfflineSyncController, idempotency guard.

### 3.10 Inventory module

#### `se_van_stock`
`id` · `se_id` FK · `component_id` FK · `qty int`. **UQ:** (se_id, component_id). Read-only to SE. **W:** InventoryService (via transactions). **R:** Recommender (Common Kit Hard Filter), reports.

#### `warehouse_stock`
`id` · `warehouse_id` · `warehouse_type` enum `MOTHER \| ZONE` · `zone_id` null · `component_id` FK · `qty int`. **UQ:** (warehouse_id, component_id).

#### `component_master`
`component_id` PK · `name` · `category` · `serial_tracked bool` (GPS/SIM = true).

#### `component_serial`
`id` · `component_id` FK · `serial_no` · `current_location` (warehouse/SE/installed) · `status`. For serial-tracked GPS/SIM.

#### `common_kit_definition`
`id` · `component_id` FK · `min_qty int` · `active bool`. **W:** Operations Head. **R:** Recommender Hard Filter.

#### `inventory_transactions`
`txn_id` · `type` enum `MOTHER_TO_ZONE \| ZONE_TO_SE(RESTOCKING) \| TICKET_CONSUMPTION \| SHADOW_USE \| FAULTY_COMPONENT_RETURNED \| STOCK_ADJUSTMENT \| VERIFICATION_ROLLBACK` · `status` enum `PRE_VERIFICATION \| DEDUCTED \| DEDUCTED_UNVERIFIED \| ROLLED_BACK \| SHADOW_USE \| RECONCILED \| DISPUTED` · `component_id` · `quantity_delta int` (sign matches direction) · `se_id` null · `ticket_id` null · `submission_id` null (links to parent form's `client_submission_id` lineage) · `warehouse_id` null · `rejection_reason` null · `created_by`.
**Idx:** partial `(status) WHERE status='SHADOW_USE'` (Shadow Use Queue), (ticket_id), (se_id). **W:** InventoryService, OfflineSyncController. **R:** Warehouse Manager queues, reports.

> **Deduction lifecycle (Decision via PRD §4.18.1, kept):** on accepted form → `PRE_VERIFICATION`
> reservation (stock not physically decremented). On GPS VERIFIED → `DEDUCTED`. On FAILED → ZM
> chooses `ROLLED_BACK` or `DEDUCTED_UNVERIFIED` (audit-flagged). On 409 with components consumed →
> `SHADOW_USE` and **van stock physically decremented regardless** (Decision §13).

### 3.11 Component-request module

#### `component_requests`
`request_id` · `ticket_id` FK · `failure_cycle_id` FK · `client_submission_id uuid` · `se_id` FK · `component_id` · `quantity_requested` · `status` enum `REQUESTED \| APPROVED \| REJECTED \| SHIPPED \| RECEIVED` · `delivery_destination` enum `SE_LOCATION \| PLANT_WAREHOUSE` · `approved_by` · `reject_reason` · `shipped_at` · `received_at`. **W:** SE mobile, Warehouse Manager, ComponentRequestService. **R:** ZM dashboard (read-only), SLA pause logic. (Schema sized for Phase-2 6-state courier model — additive `tracking_ref`, `in_transit_at`, `delivered_at` reserved.)

### 3.12 Verification module

#### `verification_runs`
`run_id` · `ticket_id` FK · `submission_id` FK null (null for auto-recovery) · `device_id` · `started_at` · `se_gps_lat` · `se_gps_lon` · `phase` enum `PENDING \| PHASE_1_PASS \| PHASE_2_PASS` · `phase1_passed_at` · `phase2_passed_at` · `first_ping_distance_meters` · `fraud_flag bool` · `pings_received_count` · `outcome` enum `CLOSED \| FAILED_VERIFICATION \| PARTIAL_RECOVERY \| CLOSED_AUTO_RECOVERY \| FAILED_ACTIVATION` null · `outcome_at`. **Idx:** partial `(ticket_id) WHERE outcome IS NULL` (active runs scanned every 5 min). **W:** VerificationWorker. **R:** Ticket close logic, ZM dashboard, reports.

### 3.13 Vouchers module

#### `expense_vouchers`
`voucher_id` · `se_id` FK · `client_submission_id uuid` · `status` enum `DRAFT \| SUBMITTED \| ZONAL_MANAGER_REVIEW \| APPROVED \| REJECTED \| NEEDS_CLARIFICATION \| PAID` · `plant_id` null · `ticket_id` null · `vehicle_id` null · `total_amount numeric(12,2)` · `reviewed_by` · `review_notes` · `paid_batch_ref` · `paid_at`. **W:** SE mobile, ZM, Operations Head. **R:** Finance Excel export, reports.

#### `expense_voucher_items`
`item_id` · `voucher_id` FK · `category` enum `TRAVEL \| ACCOMMODATION \| PARTS \| TOOLS \| MEAL \| OTHER` · `amount` · `merchant_vendor_name` · `expense_datetime` · `photo_ref`. ≥1 photo across items mandatory.

### 3.14 Non-operational & recovery module

#### `non_operational_markings`
`marking_id` · `device_id` FK · `state` enum `REQUESTED \| AWAITING_CUSTOMER_CONFIRMATION \| AWAITING_ZM_CONFIRMATION \| CONFIRMED \| ACTIVE \| EXPIRED \| UNMARKED` · `initiated_by_role` · `awaiting_role` · `confirmed_by_role` · `confirmed_at` · `override_confirm bool` · `reason_code` enum `VEHICLE_SCRAPPED \| VEHICLE_SOLD \| VEHICLE_ACCIDENT \| COMPANY_PAUSED \| DEVICE_REPLACEMENT_PENDING \| COMPLIANCE_HOLD \| OTHER` · `notes` · `effective_from` · `effective_to` · `customer_confirm_token`. **Idx:** (device_id, state), (state, effective_to). **W:** ZM, Operations Head, customer (tokenized), system. **R:** eligibility view, TicketCreation block, Recovery auto-create.

### 3.15 Notifications & audit module

#### `notifications`
`notification_id` · `recipient_user_id` FK · `event_type` · `channel` enum `IN_APP \| PUSH \| SMS \| WHATSAPP \| EMAIL` · `delivery_status` enum `QUEUED \| SENT \| DELIVERED \| FAILED` · `payload jsonb` · `fallback_step int` · `sent_at`. **W:** NotificationService. **R:** dashboards, SE mobile, audit.

#### `audit_logs`
Immutable.
`audit_id` · `entity_type` · `entity_id` · `action` · `actor_id` · `actor_role` · `acted_as_role` null · `reason` null · `before jsonb` · `after jsonb` · `at`. **Idx:** (entity_type, entity_id, at), (actor_id, at). Append-only; no UPDATE/DELETE grants. **W:** AuditService (all services). **R:** reports, compliance, dashboards.

### 3.16 Settings module

#### `system_settings`
Typed config registry — the home for every "configurable default".
`key text PK` · `value jsonb` · `scope` enum `GLOBAL \| ZONE` · `zone_id` null · `value_type` · `updated_by` · `updated_at`. **W:** Operations Head. **R:** all services. See §7 for the registry contents.

#### `sla_config` / `priority_rule_config`
`sla_config`: `id` · `scope` (`bucket`/`company_tier`) · `key` · `submit_within_minutes` · `verify_within_minutes` · `escalate_after_minutes`. `priority_rule_config`: weighted-score weights per component, versioned (each batch run records the active weight-set ref). **W:** Operations Head. **R:** SLA engine, Recommender.

### 3.17 Analytics & summary module (Layer-2 aggregates)

Read-only reporting aggregates populated by nightly/monthly workers (§6). **Dashboards and scorecards read these — never raw telemetry or multi-year `ticket_events`.** All are monthly/daily roll-replace and indexed on common filters (`device_id`, `month`/`day`, `zone_id`, `company_id`, `plant_id`, `se_id`, `root_cause_category`).

#### `device_downtime_summary_monthly`
Per-device per-month downtime rollup for the Device Lifetime Downtime Trend.
`device_id` · `month` · `downtime_cycles int` · `downtime_hours numeric` · `avg_time_to_recover_hours numeric` · `longest_episode_hours numeric` · `auto_recovery_count int` · `se_repaired_count int` · `repeat_failure_count int` · `component_related_hours numeric` · `zone_id` · `company_id` · `plant_id`. **PK** `(device_id, month)`. **W:** DeviceDowntimeSummaryWorker. **R:** `/api/devices/{id}/downtime-trend`, reports.

#### `root_cause_summary_monthly`
Root-cause distribution for the Root Cause Analytics %.
`id` · `month` · `root_cause_category` · `count int` · `zone_id` · `company_id` · `plant_id` · `device_type` · `se_id` · `fleet_id`. **W:** RootCauseSummaryWorker (reads structured `troubleshooting_submissions.root_cause_category`). **R:** `/api/reports/root-cause`.

#### `system_efficiency_summary_daily`
Daily end-to-end efficiency metrics.
`id` · `day` · scope keys (`zone_id`/`company_id`/`plant_id`/`device_type`/`se_id`/`fleet_id`) · timing metrics (`detection_to_ticket_min`, `ticket_to_assignment_min`, `assignment_to_onsite_min`, `onsite_to_submission_min`, `submission_to_verification_min`) · `auto_assignment_success_rate` · `manual_assignment_rate` · `zm_override_rate` · `sla_compliance_pct` · `repeat_failure_rate` · `first_time_fix_rate` · `failed_verification_rate` · `auto_recovery_rate` · `total_downtime_hours` · `avg_downtime_per_device_hours` · `warehouse_fulfilment_min` · `recovery_closure_min`. **W:** SystemEfficiencySummaryWorker. **R:** `/api/reports/system-efficiency`.

#### `zm_performance_summary_monthly`
Per-ZM monthly aggregate for the **Operations-Head ZM Performance Scorecard** (not a ZM self-score; ZM never writes scores).
`id` · `zm_user_id` · `zone_id` · `month` · `assignments_reviewed int` · `overrides int` · `override_rate numeric` · `override_after_onsite int` · `reassignments int` · `split_batches int` · `deferrals int` · `manual_assignments int` · `avg_time_to_intervention_min numeric` · `sla_impact numeric` · `tickets_improved int` · `tickets_delayed int` · `se_overload_events int` · `long_pending_reduction int` · `escalations_handled int` · `zone_sla_compliance_pct numeric` · `se_utilization_balance numeric`. **W:** ZmPerformanceSummaryWorker (reads assignment history / `audit_logs` / `ticket_events` / SLA outcomes / `recommendations`). **R:** `/api/reports/zm-scorecard` (OpsHead/Operations Manager only).

#### `se_troubleshooting_summary_monthly`
Per-SE monthly troubleshooting aggregate.
`id` · `se_id` · `month` · `submissions int` · `first_time_fix_rate numeric` · `failed_verification_rate numeric` · `auto_recovery_split numeric` · `root_cause_mix jsonb`. **W:** SeTroubleshootingSummaryWorker. **R:** reports, ZM-scorecard inputs.

> **Data layers & retention.** **Layer 1 (hot operational):** `device_states`, `vehicle_readiness_state`, open `tickets`, active `failure_cycles`, current `work_schedules`, active `component_requests`, pending `verification_runs`. **Layer 2 (historical business, monthly-partitioned, append-only):** `failure_cycles`, `tickets`, `ticket_events`, `troubleshooting_submissions`, `verification_runs`, `vehicle_unavailability_reports`, `component_requests`, `inventory_transactions`, `audit_logs`. **Layer 3 (cold archive):** old `raw_device_snapshots` and detailed event/audit logs to S3/Parquet/archive DB. **Retention:** `raw_device_snapshots` 3 months hot; `audit_logs` / `ticket_events` 12–24 months hot; closed `tickets` / `failure_cycles` 24 months hot; summary tables permanent. ArchiveExportWorker performs the cold export.

---

## 4. Prisma Schema Conventions

Prisma is the single schema source of truth; Postgres-specific features (PostGIS geometry,
partial unique indexes, exclusion constraints, table partitioning) are layered on with
`@@index`, raw-SQL migrations, and `Unsupported(...)` where Prisma lacks native support.

**Representative model fragment (illustrative — not production code):**

```prisma
enum FailureCycleState { OPEN WAITING_COMPONENT SUBMITTED VERIFIED FAILED REPEAT ESCALATED }
enum SlaPauseReason    { WAITING_COMPONENT VEHICLE_UNAVAILABLE }

model FailureCycle {
  cycleId                 String            @id @default(uuid()) @map("cycle_id")
  deviceId                BigInt            @map("device_id")
  state                   FailureCycleState
  openedAt                DateTime          @map("opened_at")
  closedAt                DateTime?         @map("closed_at")
  previousFailureCycleId  String?           @map("previous_failure_cycle_id")
  repeatFailure           Boolean           @default(false) @map("repeat_failure")
  slaPaused               Boolean           @default(false) @map("sla_paused")
  slaPauseReason          SlaPauseReason?   @map("sla_pause_reason")
  version                 Int               @default(0)
  ticket                  Ticket?
  device                  Device            @relation(fields: [deviceId], references: [deviceId])
  @@index([state])
  @@index([deviceId, openedAt(sort: Desc)])
  @@map("failure_cycles")
}
```

**Conventions enforced project-wide:**

| Concern | Convention |
|---|---|
| Partial UNIQUE (one active episode) | Raw migration: `CREATE UNIQUE INDEX … WHERE state IN ('OPEN','WAITING_COMPONENT','SUBMITTED')`. |
| PostGIS columns | `polygon Unsupported("geometry(MultiPolygon,4326)")?`; geo queries via `$queryRaw` with `ST_Contains`. |
| Enum evolution | Additive only; retired values kept; never renumber. |
| Transactions | All multi-table mutations + their audit row run in `prisma.$transaction([...])` (single DB tx). |
| Immutability | Prisma service layer refuses writes to VERIFIED cycles; DB trigger as defence-in-depth. |
| Optimistic lock | `version` checked in `WHERE` of every hot-row update; mismatch → 409 retry. |
| Migrations | `prisma migrate` for additive; hand-written SQL for partitioning/exclusion constraints/MVs, applied in the same migration folder. |

---

## 5. API Design — Module by Module

REST/JSON over HTTPS, bearer JWT. **Guard chain:** `AuthGuard` (valid token) →
`RoleGuard` (role allow-list per route) → `ZoneScopeGuard` (row-level zone filter for ZM) →
`IdempotencyInterceptor` (SE write endpoints). All SE write endpoints carry `client_submission_id`
and honour the `(se_id, submission_type, client_submission_id)` idempotency rule.

Conventions for the tables below: **Actor** = allowed roles; **Conflict/Idempotency** states the
duplicate vs business-409 behaviour.

### 5.1 Snapshot & ingestion
| Method | Path | Actor | Request → Response | Conflict / Idempotency |
|---|---|---|---|---|
| GET | `/api/snapshots/latest` | ZM, OpsHead | — → last SUCCESS run + `data_as_of` + status | Read-only |
| GET | `/api/snapshots/runs` | OpsHead | filter → paged runs | Read-only |
| POST | `/api/snapshots/run` | System, OpsHead | trigger → `run_id`, RUNNING | **Single in-flight run guard** (advisory lock) — second call returns 409 RUN_IN_PROGRESS |

### 5.2 Tickets
| Method | Path | Actor | Request → Response | Conflict / Idempotency |
|---|---|---|---|---|
| GET | `/api/tickets` | ZM, SE | filters(zone, plant, bucket, work_type, status) → paged | Read-only; ZM zone-scoped, SE coverage-scoped |
| GET | `/api/tickets/{id}` | ZM, SE | — → detail + soft states + technical hints | Read-only |
| POST | `/api/tickets/install` | ZM(own zone), CSM(scope), OpsHead | install payload → created Ticket | Reject if Vehicle has active mapping or Plant outside creator's zone authority |
| POST | `/api/tickets/install/csv` | ZM(own zone), CSM(scope), OpsHead | CSV → per-line accept/reject | **All-or-nothing per file**; line-number errors; per-row zone-authority check |

### 5.3 Schedules / batches
| Method | Path | Actor | Request → Response | Conflict / Idempotency |
|---|---|---|---|---|
| POST | `/api/schedules/generate` | ZM, System | date range, mode → schedules ACTIVE, batches AUTO_ASSIGNED | Re-run reconciles vs live batches; **no approval gate** |
| GET | `/api/schedules` | ZM | filter SE/date → schedules + batches | Read-only |
| GET | `/api/schedules/unreviewed-count` | ZM | — → count of AUTO_ASSIGNED unreviewed | Informational only — SE already actioning |

### 5.4 ZM override / intra-day
| Method | Path | Actor | Request → Response | Conflict / Idempotency |
|---|---|---|---|---|
| POST | `/api/batches/{id}/override` | ZM, acting role | action(swap/split/remove/defer/reorder) + `reason_code` → updated batch | If a ticket holds ON_SITE → conflict warning; requires `confirm=true` |
| POST | `/api/tickets/{id}/same-day-assign` | ZM | target SE, reason → updated Day Plan (no SE Acceptance) | Reject if ticket closed |
| POST | `/api/insertions/{id}/accept` | SE | — → committed; WhatsApp Confirmation sent | After Acceptance Timeout/reroute → 409 "already routed" |
| POST | `/api/insertions/{id}/decline` | SE | `reason_code` → reroute triggered | First-class action, distinct from timeout |
| POST | `/api/tickets/{id}/escalate-cross-zone` | ZM | target zone, reason → escalation row | Manual flag, any tier |

### 5.5 SE mobile work & soft states
| Method | Path | Actor | Request → Response | Conflict / Idempotency |
|---|---|---|---|---|
| GET | `/api/me/day-plan` | SE | date → assigned batches/tickets | Read-only |
| GET | `/api/me/shared-pool` | SE | — → secondary open tickets for covered Plants | Read-only; never outside coverage |
| POST | `/api/tickets/{id}/soft-state` | SE | type, `onsite_source` → soft-state row | Multiple SEs may hold; never a lock; never auto-cleared by activity ping |
| POST | `/api/tickets/{id}/soft-state/resolve` | SE, ZM | resolution reason → resolved | ZM force-resolve requires mandatory reason + audit |

### 5.6 Vehicle unavailability
| Method | Path | Actor | Request → Response | Conflict / Idempotency |
|---|---|---|---|---|
| POST | `/api/tickets/{id}/vehicle-unavailable` | SE | reason_code, transporter contact, expected window, GPS → report; **primary SLA paused** | Raw readiness alone cannot trigger; requires SE report |
| POST | `/api/tickets/{id}/vehicle-availability` | ZM, acting role | edit window / confirm / resume → updated/resumed | Resume also via ON_SITE/access-confirmed or trusted fresh AutoPlant readiness |
| POST | `/api/vehicle-availability/lr-next-trip` | External app (System) | `vehicle_no`/`vehicle_id`, `lr_date`, `next_trip_at` → ingested signal; readiness recompute | **Planning signal only** — never pauses SLA, never confirms AT_PLANT; feeds `UPCOMING_TRIP`/`ON_TRIP` derivation |
| GET | `/api/vehicles/{id}/readiness` | ZM, SE | — → readiness + confidence + LR/Next Trip hint | Read-only; `ON_TRIP` blocks normal assignment, others colour hints |

### 5.7 Form submissions
| Method | Path | Actor | Request → Response | Conflict / Idempotency |
|---|---|---|---|---|
| POST | `/api/tickets/{id}/troubleshoot` | SE | `client_submission_id`, gps, `component_used[]`, `component_unavailable`, photos → submission; Ticket→SUBMITTED or cycle→WAITING_COMPONENT | Duplicate→existing; **409 if already closed** (Shadow Use if components consumed) |
| POST | `/api/tickets/{id}/install-fitted` | SE | `device_serial`, `sim_serial`, photos → Ticket→FITTED | Duplicate→existing; 409 if not fittable |
| POST | `/api/tickets/{id}/recovery-collected` | SE | `device_serial`, condition notes → Ticket→COLLECTED | Duplicate→existing; 409 if closed |
| POST | `/api/tickets/{id}/unable-to-collect` | SE | `reason_code` → ZM decision queue | Duplicate→existing |
| POST | `/api/sync/batch` | SE | small batch of queued submissions → per-item 201/duplicate/409 | Never flush whole queue; per-item idempotency; 409+components → `shadow_use_recorded=true` |

### 5.8 Component requests & inventory
| Method | Path | Actor | Request → Response | Conflict / Idempotency |
|---|---|---|---|---|
| POST | `/api/component-requests` | SE (auto on unavailable) | component, ticket → REQUESTED; cycle→WAITING_COMPONENT; SLA pause | Duplicate `client_submission_id`→existing |
| POST | `/api/component-requests/{id}/decision` | Warehouse Mgr | APPROVE/REJECT + notes → status | — |
| POST | `/api/component-requests/{id}/ship` | Warehouse Mgr | `delivery_destination` → SHIPPED | — |
| POST | `/api/component-requests/{id}/confirm-receipt` | SE | — → RECEIVED; SLA resumes on ZM-confirmed resubmit binding | Duplicate→existing |
| GET | `/api/inventory/van-stock` | SE, ZM | se_id → per-SE stock | Read-only |
| GET | `/api/inventory/shadow-use-queue` | Warehouse Mgr | — → unreconciled SHADOW_USE rows | Read-only |
| POST | `/api/inventory/shadow-use/{txn}/reconcile` | Warehouse Mgr | RECONCILED/DISPUTED + notes → updated | DISPUTED → escalates to ZM |

### 5.9 Verification / vouchers / leave / scan / hints
| Method | Path | Actor | Notes |
|---|---|---|---|
| GET | `/api/tickets/{id}/verification` | ZM, SE | run state, phase, pings, fraud flag |
| GET | `/api/verification/fraud-flags` | ZM | Phase-1 location-mismatch flags |
| POST | `/api/vouchers` | SE | `client_submission_id`, items, photos → SUBMITTED (duplicate→existing) |
| POST | `/api/vouchers/{id}/review` | ZM | APPROVE/REJECT/NEEDS_CLARIFICATION + notes |
| POST | `/api/vouchers/{id}/mark-paid` | OpsHead | after Finance Excel batch → PAID |
| GET | `/api/vouchers/export` | OpsHead | month → Excel |
| POST | `/api/leave-requests` | SE | type, dates, reason → SUBMITTED (cannot self-approve) |
| POST | `/api/leave-requests/{id}/decision` | ZM, acting | APPROVE writes time-windowed availability; cross-zone SE → 403 role-scope |
| POST | `/api/me/soft-unavailable` | SE | duration → SOFT_UNAVAILABLE row, auto-resolves at `to_ts` |
| GET | `/api/scan/resolve` | SE | scanned value → active eligible ticket(s)/disambiguation; **read-only navigation only**; offline-uncached → "Cannot search ticket while offline" |
| GET | `/api/devices/{id}/technical-hints` | SE, ZM | derived hints + raw snapshot; "Telemetry unavailable" if none; **advisory only — never affects lifecycle/SLA/scoring** |

### 5.10 Standard error envelope
```
409 Conflict:
  { "error":"TICKET_ALREADY_CLOSED", "closed_by":"<se>", "closed_at":"…",
    "shadow_use_recorded": true|false }
200 idempotency duplicate:
  { "duplicate": true, "submission_id":"…" }
403 role/zone scope:
  { "error":"ZONE_SCOPE_VIOLATION" | "ROLE_NOT_PERMITTED" }
```
The **idempotency duplicate** (200, `duplicate:true`) is categorically distinct from the
**business 409 Conflict** — only the 409 path triggers Shadow Use when components were consumed.

### 5.11 Analytics & reporting (read from summary tables — never raw scans)
| Method | Path | Actor | Request → Response | Conflict / Idempotency |
|---|---|---|---|---|
| GET | `/api/devices/{id}/downtime-history` | ZM, OpsHead | — → recent Failure-Cycle downtime detail (hot records) | Read-only; zone-scoped for ZM |
| GET | `/api/devices/{id}/downtime-trend` | ZM, OpsHead | range → lifetime trend from `device_downtime_summary_monthly` | Read-only; never multi-year raw scan |
| GET | `/api/reports/root-cause` | ZM, OpsHead | filters(fleet/zone/company/plant/device-type/se/period) → root-cause % from `root_cause_summary_monthly` | Read-only |
| GET | `/api/reports/system-efficiency` | ZM, OpsHead | filters + range → metrics from `system_efficiency_summary_daily` | Read-only |
| GET | `/api/reports/zm-scorecard` | **OpsHead / Operations Manager only** | filters(zm/zone/period) → scorecard from `zm_performance_summary_monthly` | Read-only; **403 for ZM/SE** — not a self-score, not on mobile |

---

## 6. Background Workers

| Worker | Trigger | Payload / Inputs | Idempotency key | Retry / backoff | Failure handling |
|---|---|---|---|---|---|
| **SnapshotIngestionWorker** | Repeatable cron (configurable; default multi-daily) | AutoPlant cursor | `run_id` + advisory lock (one in-flight) | Per-chunk retry ×3, expo backoff; chunk-independent | 3 consecutive full failures → red banner + ops alert to ZM+OpsHead; `raw_device_snapshots` UQ makes re-runs safe |
| **DeviceStateService** | After each successful snapshot; + twice-daily Soft-Inactive recompute | new raw rows | `(device_id, run_id)` upsert | Idempotent upsert; retriable | Missing device mapping → `data_quality_errors` (silent) |
| **TicketCreationWorker** | After device-state recompute | devices `is_inactive` & no open cycle | partial-UQ on cycle | Idempotent; skip if cycle exists | Duplicate cycle attempt → no-op; auto-recovery pre-check before create |
| **BatchAssignmentWorker** | ZM request / cadence reminder | open tickets, availability, van stock, kit, coverage, planner, company master | `(zone_id, run_id)` | Re-run reconciles vs live batches | No eligible SE → Component-Blocked / "Couldn't Assign" queue; ZM notified |
| **IntraDayWorker** | Qualifying Event (new CRITICAL, SE offline/shift-cut, ZM same-day) | ticket, candidate SEs | `(ticket_id, insertion_round)` | Acceptance Timeout (default 10m) → reroute; ×3 retries | After 3 fails → escalate to acting ZM; ghost-insertion notice to reconnecting SE |
| **VerificationWorker** | Every 5 min: scan tickets in VERIFICATION_PENDING; + on form submission | submission, subsequent device pings | `(ticket_id, submission_id)` per run | Re-entrant; phase state persisted in `verification_runs` | No pings in 24h → FAILED_VERIFICATION; fraud → flag + ZM notify; coverage gap in Phase 2 → stay PENDING (never auto-FAIL) |
| **ComponentSlaWorker** | Hourly | WAITING_COMPONENT cycles | `(request_id, day)` | Idempotent scan | 7-day no RECEIVED/REJECTED → ZM Action Required |
| **RepeatFailureScanWorker** | Daily | failure cycles, 7-day window | `(device_id, scan_date)` | Idempotent | 3+ REPEAT cycles/7d → cycle ESCALATED + ZM+Warehouse notify |
| **SoftInactiveCountWorker** | Twice daily (morning, afternoon) | eligible devices silent >24h | `(scan_slot, date)` | Idempotent | Writes `recommender_runtime_state` (count + DEFICIT/PREVENTIVE mode per scope); BatchAssignmentWorker reads mode at run start |
| **FleetUptimeMonthlyWorker** | Month-end batch | device-state time-series, eligibility | `(zone, month)` | Idempotent recompute | Reports per fleet/zone/company/plant; eligible-denominator only |
| **NonOpExpiryWorker** | Daily | CONFIRMED/ACTIVE markings | `(marking_id, date)` | Idempotent | effective_to passed & not renewed → EXPIRED → device re-enters eligibility |
| **VehicleUnavailResurfaceWorker** | Hourly | reports with `expected_available_to` passed | `(report_id)` | Idempotent | Resurfaces ticket for scheduling/reassignment |
| **PlatinumCrossZoneEscalationWorker** | Hourly (+ on bucket change) | OPEN+UNASSIGNED Platinum tickets (via `tickets.company_tier`/`ix_tk_escalate`) | `(ticket_id, escalation_round)` | Idempotent scan | Unassigned 1h in CRITICAL **or** not SUBMITTED in 4h → auto-ping CSM (`cross_zone_escalations`); Gold/Silver untouched (Decision §18) |
| **RecoveryNoProgressWorker** | Daily | RECOVERY tickets where `tickets.last_state_changed_at` > 14d ago (via `ix_tk_recovery_stale`; keyed on last *state* change, not `updated_at`) | `(ticket_id, scan_date)` | Idempotent | 14-day no-progress → ZM Action Required panel (CONTEXT §Recovery) |
| **SlaEscalationWorker** | Configurable cron (e.g. 5–15 min) | OPEN/SUBMITTED failure cycles past `escalate_after_minutes` (pause-adjusted) | `(cycle_id, scan_slot)` | Idempotent | Primary-clock breach → escalate to ZM; secondary clock keeps running |
| **SoftStateTimeoutWorker** | Configurable cron (e.g. 5 min) | `soft_states`: VIEWED past `timeout_at`; ON_SITE/TROUBLESHOOT_STARTED past stale threshold (via aging idx) | `(soft_state_id, scan_slot)` | Idempotent | VIEWED → clears from active display (audit kept); ON_SITE/TS_STARTED → stale-work warning to ZM (never auto-clears) |
| **NotificationWorker** | Domain events | event payload | `(event_id, channel)` → `notifications(notification_event_id, channel)` UQ | Per-channel retry; fallback chain | push→SMS→WhatsApp→email; in-app always; WhatsApp first-class on SE Acceptance |
| **AuditFlushWorker** | n/a (synchronous in-tx) | — | — | — | Audit written in same tx as mutation; never async-dropped |
| **ReadinessService / LR-NextTrip ingest** | On external LR/Next Trip feed + on availability signals | `vehicle_availability_signal` rows (incl. `LR_NEXT_TRIP_EXTERNAL`) | `(vehicle_id, received_at)` | Idempotent recompute | Recomputes `vehicle_readiness_state`: `UPCOMING_TRIP` (planned trip) / `ON_TRIP` (LR + now); never confirms AT_PLANT, never pauses SLA; stale/missing ⇒ `UNKNOWN`/`STALE` colour hint |
| **DeviceDowntimeSummaryWorker** | Nightly + monthly | failure_cycles, tickets, ticket_events, verification_runs | `(device_id, month)` | Idempotent roll-replace | Populates `device_downtime_summary_monthly` for Device Lifetime Trend |
| **RootCauseSummaryWorker** | Nightly + monthly | troubleshooting_submissions (`root_cause_category`) | `(month, root_cause_category, scope)` | Idempotent roll-replace | Populates `root_cause_summary_monthly`; built from structured data only |
| **SystemEfficiencySummaryWorker** | Daily | ticket_events, recommendations, verification_runs, SLA outcomes | `(day, scope)` | Idempotent roll-replace | Populates `system_efficiency_summary_daily` |
| **ZmPerformanceSummaryWorker** | Monthly | assignment history, audit_logs, ticket_events, recommendations, SLA outcomes, overrides | `(zm_user_id, month)` | Idempotent roll-replace | Populates `zm_performance_summary_monthly` (Operations-Head scorecard; ZM never writes scores) |
| **SeTroubleshootingSummaryWorker** | Monthly | troubleshooting_submissions, verification_runs | `(se_id, month)` | Idempotent roll-replace | Populates `se_troubleshooting_summary_monthly` |
| **ArchiveExportWorker** | Daily/monthly | aged raw_device_snapshots, ticket_events, audit_logs past hot-retention window | `(table, partition)` | Idempotent export-then-prune | Exports to cold storage (S3/Parquet/archive DB); keeps summaries hot; never touches live operational data |

**Common worker rules:** every job carries a deterministic idempotency key so BullMQ
re-delivery (at-least-once) never double-applies; every state mutation emits an `audit_logs`
row in the same DB transaction; workers are horizontally scalable (stateless; concurrency
bounded per queue).

---

## 7. Configurable Settings Registry (`system_settings`)

Every value the canonical sources leave "implementation-defined" lives here with a launch
default — never hard-coded. Scope `GLOBAL` (Operations Head) or `ZONE` where noted.

| Key | Default | Scope | Source |
|---|---|---|---|
| `inactivity_threshold_hours` | 24 | GLOBAL | workflow §7 |
| `snapshot_interval` | multi-daily cron | GLOBAL | §6 |
| `snapshot_stale_alert_hours` | configurable | GLOBAL | workflow §6 |
| `viewed_soft_state_timeout_min` | 90 (1.5h) | GLOBAL | CONTEXT.md Soft State |
| `onsite_stale_warning_min` | impl-defined (set at rollout) | GLOBAL | §31 Q2 |
| `troubleshoot_started_stale_warning_min` | impl-defined | GLOBAL | §31 Q2 |
| `acceptance_timeout_min` | 10 | GLOBAL | Decision §16 |
| `intraday_retry_max` | 3 | GLOBAL | Decision §16 |
| `activity_ping_recommender_filter_min` | 15 | GLOBAL | ADR-0024 |
| `activity_ping_offline_label_min` | 60 | GLOBAL | ADR-0024 |
| `verify_phase1_window_min` | 30 | GLOBAL | Decision §9 |
| `verify_phase1_min_pings` | 3 | GLOBAL | Decision §9 |
| `verify_phase1_span_min` | 15 | GLOBAL | Decision §9 |
| `verify_max_gap_min` | 30 | GLOBAL | Decision §9 |
| `verify_phase1_radius_m` | 500 | GLOBAL | Decision §9 |
| `verify_phase2_stability_min` | 60 | GLOBAL | Decision §9 |
| `verify_escalation_window_hours` | 24 | GLOBAL | workflow §17 |
| `component_wait_escalation_days` | 7 | GLOBAL | Decision §8 |
| `recovery_no_progress_escalation_days` | 14 | GLOBAL | CONTEXT.md Recovery |
| `repeat_failure_window_hours` | 24 | GLOBAL | workflow §7 |
| `repeat_failure_escalation_count` / `_window_days` | 3 / 7 | GLOBAL | §4.6 |
| `deficit_mode_threshold_pct` | 2 (× eligible count) | GLOBAL | Decision §5 |
| `plant_cluster_multiplier` | set at rollout | GLOBAL | §31 Q6 |
| `offline_queue_max_pending` | 500 | GLOBAL | CONTEXT.md mobile |
| `offline_cache_retention_days` | 7–15 | GLOBAL | §31 Q3 |
| `non_op_default_window_days` | 90 (365 for scrapped/sold) | GLOBAL | Decision §14 |
| `platinum_autoescalation_unassigned_hours` | 1 | GLOBAL | Decision §18 |
| `platinum_autoescalation_to_submitted_hours` | 4 | GLOBAL | Decision §18 |
| `schedule_cadence_reminder_time` | 08:00 IST | ZONE | Decision §2 (advisory only) |

---

## 8. RBAC / Permission Model

### 8.1 Roles (no `ADMIN`; Operations Head is configurator)
`OPERATIONS_HEAD` › `CENTRAL_SERVICE_MANAGER` › `ZONAL_MANAGER` (per-zone) · `WAREHOUSE_MANAGER` (inventory) · `SERVICE_ENGINEER` (own work).

### 8.2 Enforcement layers
1. **RoleGuard** — per-route role allow-list (declarative decorator).
2. **ZoneScopeGuard** — for ZM, injects `zone_id = token.zone_id` into every query filter; cross-zone read/write → 403 `ZONE_SCOPE_VIOLATION`.
3. **CoverageScopeGuard** — for SE, restricts ticket reads to covered Plants (Shared Pool never shows non-covered Plants).
4. **Acting-role resolution** — when CSM/OpsHead acts in ZM scope (backup cascade), session carries `acted_as_role`; every audit row records both `actor_role` and `acted_as_role`.

### 8.3 Permission matrix (selected, authority-defining)
| Action | SE | ZM | CSM | OpsHead | Warehouse |
|---|---|---|---|---|---|
| View tickets | own coverage | own zone | all zones | all | — |
| Create Install Ticket | ✗ | own zone | scope | all | ✗ |
| Override batch | ✗ | own zone | acting | all | ✗ |
| Approve Leave | ✗ | own zone | acting | — | ✗ |
| Approve Expense Voucher | ✗ | own zone (review) | acting | mark PAID | ✗ |
| Set SE availability | self soft-unavail | own zone | acting | ✗ | ✗ |
| Approve Component Request (stock) | ✗ | **read-only** | ✗ | ✗ | ✓ |
| Reconcile Shadow Use | ✗ | dispute recipient | ✗ | ✗ | ✓ |
| Confirm Non-Op marking | ✗ | own zone | acting | override after 7d | ✗ |
| Close Recovery (manual) | ✗ | ZM_MANUAL (own zone) | CSM_ACTING (acting only) | OPS_HEAD_OVERRIDE (all) | mark RECEIVED→auto-close |
| Configure system / Settings | ✗ | ✗ | ✗ | ✓ | ✗ |

**Invariants:** SE cannot self-approve leave or write `ON_LEAVE`/`WEEKLY_OFF`; ZM cannot approve
stock movement unless explicitly authorized; ZM cannot act outside own zone; CSM manual Recovery
close only while acting in ZM scope.

---

## 9. SLA Bucket (age band)

Computed at display/scoring time from `inactivity_hours = (now − latest_gps_datetime)`. Never stored as a lifecycle field.

| Bucket | Age | | Bucket | Age |
|---|---|---|---|---|
| `ACTIVE` | 0–4h (not a queue bucket) | | `HIGH_CRITICAL` | 48–72h |
| `WARNING` | 4–8h | | `SEVERE` | 72–120h (3–5d) |
| `EARLY_RISK` | 8–12h | | `VERY_SEVERE` | 120–168h (5–7d) |
| `RISK` | 12–24h | | `LONG_PENDING` | 168h+ (7d+) |
| `CRITICAL` | 24–48h | | | |

Boundaries closed-lower/open-upper (CRITICAL = 24 ≤ x < 48). Scoring tier order (descending):
`LONG_PENDING > VERY_SEVERE > SEVERE > HIGH_CRITICAL > CRITICAL > RISK > EARLY_RISK > WARNING`.
`AGED_CRITICAL` is **not** used (canonical = `LONG_PENDING`).

---

## 10. State Machines

Each transition writes `audit_logs` (+ `ticket_events` where applicable). Invalid transitions are
rejected at the service layer and, for irreversibility-critical ones, by DB triggers.

### 10.1 Failure Cycle
**States:** OPEN, WAITING_COMPONENT, SUBMITTED, VERIFIED, FAILED, REPEAT, ESCALATED.

| From → To | Actor | Note |
|---|---|---|
| OPEN → WAITING_COMPONENT | system | SE submits `component_unavailable=true`; **SLA pauses** |
| OPEN → SUBMITTED | system | SE submits form |
| WAITING_COMPONENT → SUBMITTED | system | component received, resubmit; **SLA resumes at ZM-confirmed binding** |
| WAITING_COMPONENT → ESCALATED | system | 7-day timeout |
| SUBMITTED → VERIFIED | VerificationWorker | passes; **cycle immutable** |
| SUBMITTED → FAILED | VerificationWorker | fails |
| (VERIFIED) → new cycle REPEAT | system | device re-fails ≤24h; **new** cycle links `previous_failure_cycle_id`; old stays VERIFIED |
| any active → ESCALATED | daily scan | 3+ REPEAT/7d |

**Invalid:** reopening VERIFIED; FAILED→VERIFIED without a new submission; editing a closed cycle.

### 10.2 Troubleshoot Ticket
**States:** OPEN, SUBMITTED, VERIFICATION_PENDING (`PARTIAL_RECOVERY` badge sub-state), CLOSED, CLOSED_AUTO_RECOVERY, FAILED_VERIFICATION, ESCALATED, CLOSED_NON_OPERATIONAL.

| From → To | Actor |
|---|---|
| OPEN → SUBMITTED | SE |
| SUBMITTED → VERIFICATION_PENDING | system |
| VERIFICATION_PENDING → CLOSED | VerificationWorker (three-phase pass) |
| OPEN/VERIFICATION_PENDING → CLOSED_AUTO_RECOVERY | VerificationWorker (no form submitted) |
| VERIFICATION_PENDING → FAILED_VERIFICATION | system (24h window / fraud) |
| any active → ESCALATED | system |
| any active → CLOSED_NON_OPERATIONAL | system (Non-Op CONFIRMED) |

**Invalid:** submitting after CLOSED_AUTO_RECOVERY (→409); CLOSED without verification; changing `work_type`. `PARTIAL_RECOVERY` is a badge, not a stored state. `CLOSED_AUTO_RECOVERY` kept distinct from `CLOSED` for reporting.

### 10.3 Install Ticket
**States:** REQUESTED → SCHEDULED → ON_SITE → FITTED → ACTIVATED → CLOSED (or FAILED_ACTIVATION).
At FITTED: SE records `device_serial`+`sim_serial` → these become the verification `device_id`.
At ACTIVATED: warranty anchor; VerificationWorker waits for **first valid GPS ping** from new device.
**Invalid:** skipping FITTED; activating without serials; `work_type` change.

### 10.4 Recovery Ticket
**States:** REQUESTED → SCHEDULED → ON_SITE → COLLECTED → RECEIVED_AT_WAREHOUSE → CLOSED (or FAILED_RECOVERY).
COLLECTED requires device-serial confirmation + condition notes. RECEIVED_AT_WAREHOUSE (Warehouse Mgr verifies serial) → **auto-close** `AUTO_CLOSED_ON_WAREHOUSE_RECEIPT`.
**`closure_type` enum:** `AUTO_CLOSED_ON_WAREHOUSE_RECEIPT | ZM_MANUAL_CLOSE | OPERATIONS_HEAD_OVERRIDE_CLOSE | CSM_ACTING_CLOSE | FAILED_RECOVERY_CLOSE`. Mandatory close audit fields: `actor_id, actor_role, closure_type, reason, timestamp, previous_state, device_serial`.
**Invalid:** auto-close without warehouse receipt; CSM manual close outside acting scope; serial mismatch silently closing (→ routes to ZM).

### 10.5 Component Request (v1)
REQUESTED → APPROVED|REJECTED → SHIPPED → RECEIVED. **Invalid:** ship before approve; receipt before ship. (Schema sized for Phase-2 6-state courier model.)

### 10.6 Expense Voucher
DRAFT → SUBMITTED → ZONAL_MANAGER_REVIEW → APPROVED|REJECTED|NEEDS_CLARIFICATION; NEEDS_CLARIFICATION → SUBMITTED; APPROVED → PAID (OpsHead). **Invalid:** SE self-approve; PAID without APPROVED.

### 10.7 Leave Request
SUBMITTED → APPROVED (writes time-windowed availability) | REJECTED. **Invalid:** SE writing ON_LEAVE/WEEKLY_OFF directly; ZM approving cross-zone SE.

### 10.8 Plant-wise Batch Assignment
AUTO_ASSIGNED → COMPLETED|PARTIAL|OVERRIDDEN; OVERRIDDEN → COMPLETED|PARTIAL. **Invalid:** any DRAFT/PENDING_REVIEW/APPROVED state (approval gate removed); requiring ZM approval before SE can act.

### 10.9 Verification Result
PENDING → PHASE_1_PASS → PHASE_2_PASS → PASS(→CLOSED); PENDING → FAIL_NO_PINGS (24h); PHASE_1 location wildly off → FAIL_FRAUD. **Invalid:** applying ±500m beyond Phase 1; flipping to FAIL on a Phase-2 coverage gap (stays PENDING).

### 10.10 Non-Operational Marking
REQUESTED → AWAITING_CUSTOMER/ZM_CONFIRMATION → CONFIRMED → ACTIVE → EXPIRED|UNMARKED; 7-day no-response → OpsHead override-confirm. On CONFIRMED/ACTIVE: block new cycles; in-flight tickets → CLOSED_NON_OPERATIONAL; RECURRING-deal device → auto Recovery Ticket; device dropped from Eligible denominator. **Invalid:** single-party take-effect; auto-Recovery for ONE_TIME deals.

### 10.11 Offline Queue Item (device-local)
PENDING → RETRYING → DELIVERED|FAILED; RETRYING → PENDING (5xx/network, backoff). **Invalid:** auto-deleting PENDING without SE ack; silently deleting FAILED. Server outcome mirrored in `offline_submission_receipts`.

---

## 11. SLA Clocks

Two parallel clocks per Troubleshoot ticket; anchored at `failure_cycle.opened_at`.

### 11.1 Primary SLA Clock (SE-facing, contractual)
- Drives `submit_within_minutes`, `verify_within_minutes`, `escalate_after_minutes` (from `sla_config`, per bucket or company tier).
- **Pauses for exactly two documented reasons**, each recording `pause_reason` + `pause_source`:
  - `WAITING_COMPONENT` — SE submitted `component_unavailable=true`. Resumes at **ZM-confirmed resubmit binding** (CONTEXT.md Decision §8 is authoritative over the §Component-Request phrasing — see §19 Q4).
  - `VEHICLE_UNAVAILABLE` — a filed **Vehicle Unavailability Report**. Resumes on: expected-date-available mark, SE ON_SITE/access confirmed, ZM manual resume, or trusted fresh AutoPlant readiness.
- **Raw readiness (`ON_TRIP`/`STALE`/`UNKNOWN`) NEVER auto-pauses.**
- Elapsed = `(now − opened_at) − accumulated_pause_seconds`.

### 11.2 Secondary SLA Clock (manager-only, never pauses)
- Derived `now − opened_at`, no pause subtraction.
- Visible **only** to ZM, CSM, Operations Head — never the SE, never on contractual reports.
- Purpose: a paused primary clock can never hide true aging from oversight.

### 11.3 Escalation
- Primary clock crossing `escalate_after_minutes` → ZM Action Required.
- Platinum auto-escalation (Decision §18): unassigned 1h in CRITICAL **or** not SUBMITTED within 4h → auto-ping CSM. Gold/Silver → "Couldn't Assign" queue, manual ZM flag.

---

## 12. Idempotency, Offline Sync & Conflict Handling

### 12.1 Idempotency key
Canonical key: **`(se_id, submission_type, client_submission_id)`**, recorded in
`offline_submission_receipts`. `client_submission_id` is a UUID generated at **draft creation
time** on the device (survives restarts/retries). Submission types: `TROUBLESHOOTING_FORM`,
`EXPENSE_VOUCHER`, `COMPONENT_REQUEST`, `COMPONENT_RESUBMIT`.

**Server flow on any SE write:**
1. `IdempotencyInterceptor` looks up the receipt by key.
2. Hit → return stored `result_ref` with `{duplicate:true}` (no second record, inventory txn, or worker enqueue).
3. Miss → process in a DB tx, write the receipt (`outcome=CREATED`), commit.
4. Inventory transactions reference the parent submission's `client_submission_id` lineage — retries never double-move stock.

### 12.2 Offline sync (`POST /api/sync/batch`)
- Per-device FIFO queue (WatermelonDB/SQLite); flush in small batches, never the whole queue.
- Per-item server response: `201` (mark DELIVERED) · `duplicate` (mark DELIVERED) · `409` (mark FAILED, show conflict screen) · `5xx/network` (RETRYING, expo backoff).
- Photos stored as file refs, uploaded via signed URLs; local copies cleaned after sync; pending items never auto-deleted without SE ack.

### 12.3 Business 409 Conflict & Shadow Use
A 409 is **not** a retry — the ticket/business object is no longer actionable (another SE's
submission won, or auto-recovery closed it).

| Case | Handling |
|---|---|
| 409, no components consumed | Queue item FAILED; SE sees 409 screen; **no Shadow Use** |
| 409, components consumed | `inventory_transactions` rows `status=SHADOW_USE`, `rejection_reason=DUPLICATE_SUBMISSION`; **van stock decremented anyway** (parts physically gone); response `shadow_use_recorded=true`; row → Warehouse Shadow Use Queue (RECONCILED/DISPUTED) |
| Same SE, two phones | Two different UUIDs at draft time; second-arriving submission → standard 409; no inter-device coordination |
| Auto-recovery during form fill | Ticket CLOSED_AUTO_RECOVERY; SE's later submit → 409; no SE effort/components credited |

### 12.4 Override conflict
ZM override of a ticket on which an SE holds ON_SITE/TROUBLESHOOT_STARTED → conflict-warning
payload; requires `confirm=true` + mandatory reason; ON_SITE never silently cleared; audited as
`OVERRIDE_AFTER_ON_SITE`.

---

## 13. Engine Internals

### 13.1 Recommender / scoring (BatchAssignmentWorker)
Deterministic, reproducible. Per zone:
1. Collect OPEN unassigned tickets (TROUBLESHOOT + INSTALL).
2. **Canonical sort (Decision §17):** Company Tier (PLATINUM>GOLD>SILVER) → Device Bucket (LONG_PENDING→WARNING) → Company Priority Rank (A→B→C) → Oldest Inactive → Device ID. Enforced as a stable SQL `ORDER BY`; pinned by a fixture test.
3. **Hard Filters** (drop candidate before scoring): vehicle `ON_TRIP`; SE not `AVAILABLE`; SE over Daily Capacity; Common Kit incomplete; any known `expected_component` unavailable in van **and** Zone Warehouse; (intra-day only) `last_activity_at` > 15 min. `STALE`/`UNKNOWN` readiness is a ZM conflict signal, **not** a drop.
4. **Within each (Company Tier × Device Bucket) cell:** weighted score = `company_priority_rank` + dispatch urgency + repeat-failure penalty + (Floating) distance-from-previous-stop; **Plant Cluster Multiplier** applied to additional same-Plant tickets.
5. Precedence for candidate SE: Dedicated → Multi-Plant → Floating (via `plant_eligible_floating_se` MV).
6. Group into `plant_batch_assignments` (one Plant → one SE), order stops by distance, build `work_schedules` ACTIVE, persist `recommendations.score_breakdown`, **dispatch directly** (`AUTO_ASSIGNED`), push "Day Plan is live".
7. Blocked tickets → Component-Blocked / "Couldn't Assign" queues (never silently dropped).

**Mode:** SoftInactiveCountWorker flips deficit (`>2% × eligible`) vs preventive mode.

### 13.2 Verification (VerificationWorker)
Per active `verification_runs` row, every 5 min:
- **Phase 1 (0–30 min):** ≥3 valid pings from the **named `device_id`**, span ≥15 min, no gap >30 min, **first** ping within ±500m of `se_gps_lat/lon` (or ON_SITE geofence capture) **or** inside Plant geofence. `presence_source=NONE` → geo-check skipped (no fraud flag). 1–2 pings → PARTIAL_RECOVERY badge. First ping wildly off → FAIL_FRAUD (ZM-visible).
- **Phase 2 (1h from Phase-1 first ping):** keeps pinging, no gap >30 min; **movement welcome**, no ±500m. Coverage gap >30 min → stays PENDING (never auto-FAIL).
- **Phase 3:** Phase 2 passes → CLOSED, cycle VERIFIED (immutable). 24h window expires → FAILED_VERIFICATION (reported as "no pings" vs "fraud").
- **Auto-recovery:** device pings satisfy criteria **before** any submission → CLOSED_AUTO_RECOVERY, no components, cycle VERIFIED.
- **Install:** first valid ping from new `device_id` post-ACTIVATED → CLOSED; else FAILED_ACTIVATION.
- **Replacement:** verification follows the **new** `device_id`, never the old/backup.

---

## 14. Scalability & Performance

| Concern | Approach |
|---|---|
| `raw_device_snapshots` volume (~50k devices × pings) | Monthly range partitioning; `(device_id, gps_datetime DESC)` index; retention/archival policy; chunked cursor ingestion (1k rows/chunk, configurable). |
| Snapshot processing target <10 min | Parallel chunk workers; per-chunk independent retry; incremental sync evaluated at 100k+ devices. |
| Device-state reads | `device_states` upsert + Redis `DEVICE_STATE_CACHE` (15-min TTL for open-ticket devices). |
| Dashboard aggregates | Materialized rollups + Redis cache keyed by zone; invalidated on relevant writes. |
| Floating-SE territory lookup | `plant_eligible_floating_se` MV (nightly + on coverage edit) → hot path is an index lookup, not `ST_Contains` per request. |
| Recommender determinism at scale | Stable SQL ORDER BY; candidate set bounded per zone; score breakdown persisted for explainability. |
| API p95 <500ms (PRD target) | Read replicas for reports/dashboards; pagination everywhere; N+1 avoided via Prisma `include` batching. |
| Worker throughput | BullMQ horizontal scaling; per-queue concurrency limits; idempotent jobs safe under at-least-once delivery. |
| Realtime fan-out | WebSocket gateway with Redis adapter; 30s polling fallback. |
| Hot-row contention | Optimistic `version` column on tickets/cycles/requests/markings; retry-on-conflict. |

---

## 15. Observability, Security & Audit

- **Audit:** immutable `audit_logs`, append-only grants, written in-tx with each mutation; `actor_role` + `acted_as_role` on every row; never dropped (retry on failure).
- **Metrics:** snapshot duration/failed-chunks, API p95, cache hit rate, sync success rate, duplicate-rejection count, verification job success, auto-recovery vs repair split (PRD Technical KPIs).
- **Tracing:** request → service → worker correlation IDs; intra-day insertion retry chain fully logged in `recommendation_history`.
- **Security:** JWT access+refresh; role+zone claims; row-level zone scoping in guards; signed-URL uploads (no blobs through API); tokenized one-time customer Non-Op confirmation links; PII (transporter contact) exposed only on Ticket Detail to authorized SE/ZM.
- **Alerts:** 3+ consecutive snapshot failures, stale snapshot, Van Stock negative anomaly, audit-write failure.

---

## 16. Testing Strategy

| Layer | Coverage |
|---|---|
| **Unit** | SLA clock math (pause/resume, both clocks), bucket boundary edges (24h/48h closed-lower), verification phase logic, idempotency-key resolution, RBAC guard decisions. |
| **State-machine** | Exhaustive allowed/invalid transition tests per machine (§10); assert invalid transitions rejected at service + DB layers; VERIFIED-cycle immutability. |
| **Determinism** | Fixture-pinned canonical sort order (Decision §17) so refactors can't silently reorder; Plant Cluster Multiplier reproducibility. |
| **Idempotency/offline** | Duplicate `client_submission_id` → single record + single inventory txn; 409 with/without components → Shadow Use vs none; two-phone same-SE → second 409. |
| **Concurrency** | Two SEs submit same ticket → first wins, second 409+Shadow Use; ZM override vs SE ON_SITE conflict; optimistic-lock version conflicts. |
| **Worker** | At-least-once redelivery → no double-apply; chunk retry idempotence (raw-snapshot UQ); verification 24h-window expiry; 7-day component / 14-day recovery / repeat-failure escalations. |
| **Integration** | End-to-end: snapshot → inactivity → ticket → batch dispatch → form → verification → close; Non-Op CONFIRMED → Recovery Ticket auto-create; component-unavailable → WAITING_COMPONENT → resubmit. |
| **RBAC/scope** | ZM cross-zone read/write → 403; SE Shared Pool never shows non-covered Plants; acting-role audit fields; SE self-approve leave rejected. |
| **Contract** | API response envelopes (409, duplicate, 403); CSV install all-or-nothing with line-number errors. |
| **Load** | Snapshot of 50k devices <10 min; API p95 <500ms; verification scan cadence under backlog. |

---

## 17. Implementation Phases

| Phase | Scope | Exit criteria |
|---|---|---|
| **P0 — Foundation** | Postgres+PostGIS+Prisma schema, enums, migrations, partitioning, `system_settings`, auth+RBAC guards, audit infra, reference/org seed. | Schema migrates clean; guards enforce role+zone; audit writes in-tx. |
| **P1 — Ingestion → Tickets** | SnapshotIngestion, DeviceState, TicketCreation, SLA bucket, auto-recovery detection, duplicate-cycle invariants, data-as-of banner. | Inactive devices reliably produce one ticket; <10-min snapshot; auto-recovery closes without form. |
| **P2 — Recommender & scheduling** | Coverage + territory MV, canonical sort, Hard Filters, BatchAssignment auto-dispatch, ZM override, SE Planner bias, Day Plan API. | Reproducible plant-clustered Day Plans dispatched without approval gate; override audited. |
| **P3 — SE field loop** | Soft states, troubleshoot form, idempotency ledger, offline sync batch, Verification three-phase, fraud flag, notifications + WhatsApp on Acceptance. | Online+offline submission idempotent; tickets verify/close; 409+Shadow Use correct. |
| **P4 — Inventory & components** | Van stock, inventory transactions (incl. PRE_VERIFICATION→DEDUCTED lifecycle), Common Kit filter, Component Request lifecycle + WAITING_COMPONENT SLA pause, Shadow Use Queue. | Component-unavailable pauses/resumes SLA correctly; Shadow Use reconciliation works. |
| **P5 — Availability, readiness, SLA, intra-day** | SE_AVAILABILITY + Leave, role_unavailability backup cascade, Vehicle Unavailability Report + dual SLA clocks, IntraDay SE-Acceptance flow, cross-zone Platinum auto-escalation. | Primary/secondary clocks correct; intra-day acceptance+reroute+escalate works. |
| **P6 — Install / Recovery / Non-Op** | Install single+CSV (scoped), Install verification, Non-Op dual-confirmation, Recovery auto-create + closure authority matrix. | Scoped Install creation; Non-Op CONFIRMED blocks cycles + spawns Recovery for RECURRING. |
| **P7 — Vouchers, reporting, hardening** | Expense Voucher flow + Finance Excel export, Fleet Uptime monthly, Soft Inactive Count, full reports, observability/alerting, load hardening. | Fleet Uptime over eligible denominator; reports separate auto-recovery from repairs. |

---

## 18. Module → Tables → Workers → APIs Quick Index

| Module | Owns tables | Workers | Primary APIs |
|---|---|---|---|
| Ingestion | snapshot_runs, snapshot_run_chunks, raw_device_snapshots, data_quality_errors | SnapshotIngestion | `/api/snapshots/*` |
| Device-state | device_states, device_eligibility(MV), pgi_history | DeviceState, SoftInactiveCount | (internal) |
| Ticketing | failure_cycles, tickets, install/troubleshoot_details, ticket_events | TicketCreation, RepeatFailureScan | `/api/tickets/*` |
| Soft-state | soft_states | — | `/api/tickets/{id}/soft-state*` |
| Scheduling | work_schedules, plant_batch_assignments, batch_assignment_tickets, recommendations, intraday_insertions, cross_zone_escalations, se_planner | BatchAssignment, IntraDay | `/api/schedules/*`, `/api/batches/*`, `/api/insertions/*` |
| Coverage | se_coverage, engineer_territory_coverage, plant_eligible_floating_se(MV) | (MV refresh) | (config) |
| Availability | se_availability, leave_requests, role_unavailability, engineer_master | LeaveAvailability | `/api/leave-requests/*`, `/api/me/*` |
| Readiness | vehicle_readiness_state, vehicle_availability_signal, vehicle_unavailability_reports | VehicleUnavailResurface, ReadinessService (LR/Next Trip) | `/api/tickets/{id}/vehicle-*`, `/api/vehicle-availability/lr-next-trip`, `/api/vehicles/{id}/readiness` |
| Forms/idempotency | troubleshooting_submissions, submission_components, offline_submission_receipts | OfflineSync | `/api/tickets/{id}/troubleshoot`, `/api/sync/batch` |
| Inventory | se_van_stock, warehouse_stock, component_master, component_serial, common_kit_definition, inventory_transactions | Inventory | `/api/inventory/*` |
| Component req | component_requests | ComponentSla | `/api/component-requests/*` |
| Verification | verification_runs | Verification | `/api/tickets/{id}/verification` |
| Vouchers | expense_vouchers, expense_voucher_items | — | `/api/vouchers/*` |
| Non-op/Recovery | non_operational_markings | NonOpExpiry | (recovery via tickets) |
| Notifications | notifications | Notification | (internal) |
| Audit | audit_logs | (in-tx) | (read via reports) |
| Settings | system_settings, sla_config, priority_rule_config | — | `/settings` |
| Analytics/Summary | device_downtime_summary_monthly, root_cause_summary_monthly, system_efficiency_summary_daily, zm_performance_summary_monthly, se_troubleshooting_summary_monthly | DeviceDowntimeSummary, RootCauseSummary, SystemEfficiencySummary, ZmPerformanceSummary, SeTroubleshootingSummary, ArchiveExport | `/api/devices/{id}/downtime-*`, `/api/reports/root-cause`, `/api/reports/system-efficiency`, `/api/reports/zm-scorecard` |

---

## 19. Open Items Requiring Business Confirmation (carried from workflow §31)

These five are **genuinely business-blocked** (not stale ADR contradictions). They are modelled
as configurable defaults so implementation is unblocked; the value is confirmed at rollout. They
do **not** alter schema, API shape, permissions, or state machines.

1. **Stale-work warning thresholds** (ON_SITE, TROUBLESHOOT_STARTED) — modelled in `system_settings`; default tuned at rollout.
2. **Offline queue limits** (max pending 500, retention 7–15d, retry count) — `system_settings` defaults, tuned on observed device performance.
3. **SLA resume trigger** — this LLD follows **CONTEXT.md Decision §8 (resume at ZM-confirmed resubmit binding)** as authoritative over the §Component-Request "on RECEIVED" phrasing. Confirm if Operations wants resume-on-receipt instead (one-line config switch `sla_resume_on_receipt`).
4. **Plant Cluster Multiplier numeric value** — `system_settings.plant_cluster_multiplier`; default set at rollout.
5. **Install verification geo-constraint** — current design applies **no** geofence to the first post-fitment ping (no prior location known); confirm if a radius should apply.

Items #1 (Recovery closure authority for CSM — already documented as acting-scope-only), #9–#15
of workflow §31 are either already resolved in the closure-authority matrix (§10.4) or are
config/data-source confirmations that do not block backend build.

---

*End of Backend Low-Level Design. Canonical authority: CONTEXT.md → PRD-fsm-admin-dashboard.md →
fsm-business-technical-workflow.md. Root `prd.md` is legacy and does not override these.*
