# SYSTEM STATE — 2026-07-10

**Single source of truth for what the FSM platform actually is today**, reconciled against the
doc set. Code is truth; docs are claims. Every statement cites evidence (`file:line`, migration
name, test, commit). Inference is marked `[INFERRED]`; anything not directly verified is marked
`[UNVERIFIED]`. Written on branch `feat/autoplant-integration` at commit `eeb5601` (plus an
uncommitted working-tree layer of admin-UI polish + device/schedule read tweaks — see §1.5).

Section order is the resume order for future sessions.

---

## 1. SYSTEM OVERVIEW

### 1.1 What the platform is

A GPS Field Service Management platform for a fleet-telematics fitment business: GPS devices are
fitted on customer vehicles at plants; when a device stops reporting, the platform detects it,
opens a ticket, recommends a Service Engineer (SE), dispatches a day plan, and tracks the field
loop (troubleshoot → GPS-verified fix → reports). Two user-facing products over one backend:

- **Admin Web Dashboard** — React 18 + TypeScript + Vite SPA (`apps/admin/`), role-variant UI for
  Zone Manager (ZM), CSM, Operations Head (OH), Warehouse Manager (WM).
- **SE Mobile App** — React Native + Expo (`apps/mobile/`) — **auth shell only** today: login /
  session / token store (14 files, `apps/mobile/src/auth/*`, `apps/mobile/app/index.tsx`).
  Issue #54 (Mobile Foundation) is not done; every M-series mobile surface is unbuilt.
- **Backend** — NestJS modular monolith (`apps/backend/`), Postgres 16 + PostGIS via Prisma 7,
  reading from the external **AutoPlant** MySQL system over VPN.

### 1.2 The funnel (one diagram)

```
AutoPlant MySQL (VPN, read-only)
  │  masters daily · telemetry every 30 min          [IntegrationSchedulerService — env-gated OFF]
  ▼
[a] Master sync  ─ ap_masters → companies/plants/vehicles/transporters (ACTIVE plants, DEPLOYED
  │                devices, zone-normalised via zone_mapping, else UNZONED)   master-sync.service.ts
  ▼
[b] Snapshot ingestion ─ keyset reader ≤90 rows/query → raw_device_snapshots (daily partitions)
  │                      run ledger + stale-run reaper            snapshot-ingestion.worker.ts
  ▼
[c] Device-state recompute ─ set-based upsert of device_states (inactivity hrs, SLA bucket,
  │                          eligibility)                          device-state.service.ts
  ▼
[d] Ticket creation ─ inactive + eligible → OPEN ticket + failure_cycle    [gated: eligibility_mode
  │                                                     ='pgi' over empty pgi_history ⇒ 0 today]
  ▼
[e] Recommender ─ hard filters + scoring + canonical sort → recommendations (SUGGESTED)
  │                                                                 recommender.service.ts
  ▼
[f] Batch dispatch ─ SUGGESTED→DISPATCHED, work_schedules Day Plan (transactional, advisory-
  │                  locked, idempotent)  batch-assignment.service.ts · daily cron dispatch-
  │                  scheduler.service.ts               [BUSINESS_SWEEPS_ENABLED, default OFF]
  ▼
[g] Field loop ─ SE soft states · troubleshoot submission · intraday CRITICAL insertion ·
  │              ZM override/same-day · cross-zone escalation · install & recovery lifecycles ·
  │              inventory/van stock/component requests
  ▼
[h] Verification ─ first-valid-ping GPS sweeps → CLOSED / PARTIAL_RECOVERY / failed
  ▼
[i] Reports ─ monthly/daily aggregation cubes → fleet uptime, root cause, efficiency, ZM scorecard
```

**Funnel status (verified 2026-07-09, `INDEX.md:124-139`, spot-checked this session):** every stage
is code-complete and tested; activation is blocked by (1) empty `engineer_master`/`se_coverage`
data, (2) the B7 eligibility business decision (`pgi_history` empty), and (3) two deliberately-OFF
ops switches (`INGESTION_SCHEDULER_ENABLED`, `BUSINESS_SWEEPS_ENABLED`). Nothing runs unattended
today. See §6.

### 1.3 Runtime topology

| Component | Reality | Evidence |
|---|---|---|
| Backend | Single NestJS process, port `PORT ?? 3000`, global prefix `/api`, CORS to `ADMIN_ORIGIN ?? http://localhost:5173` | `main.ts:9`, `app.config.ts:9-13` |
| Primary DB | Postgres 16 + PostGIS, Prisma 7 (`prisma@^7.8.0`), 55 migrations `20260617103804_init…` → `20260709120000_intraday_one_live_offer` | `apps/backend/prisma/migrations/` |
| External source | AutoPlant MySQL over VPN, `mysql2@^3.15.3`, lazy pool, unset env ⇒ empty/mock sources so dev/CI boots | `ingestion.module.ts` (`readAutoPlantMysqlConfig()===null` branches) |
| Cron | **In-process** `@nestjs/schedule@^4.1.2` only. Two scheduler homes: `IntegrationSchedulerService` (ingestion, owns `ScheduleModule.forRoot()` in `ingestion.module.ts`) and `BusinessSweepSchedulerModule`+`DispatchSchedulerService` (field-loop sweeps + daily dispatch) | `ingestion.module.ts`, `scheduling/business-sweep-scheduler.service.ts`, `scheduling/dispatch-scheduler.service.ts` |
| Queueing | **None.** No Redis, no BullMQ, no S3 in `apps/backend/package.json` — CLAUDE.md's "Redis/BullMQ, S3" line is aspirational, not current (§4 correction) | `package.json` deps grep |
| Auth store | **In-memory** users + refresh tokens (`InMemoryUserStore`/`InMemoryRefreshTokenStore`); DB `users` table exists but cannot log in — owned by open issue #91 | `auth/user-store.ts`, `auth/refresh-token-store.ts` |
| Deployment | **None** — no Dockerfile, no compose, no runbook (issue #111 open) | repo root inspection; `docs/audits/2026-07-07-…reaudit.md` |

### 1.4 Module map

`AppModule` (`app.module.ts:80-106`) imports 24 feature modules and mounts ~45 controllers at the
app level; guards `AuthGuard → RoleGuard → ZoneScopeGuard` are providers applied per-controller
via `@UseGuards` — **there is no global `APP_GUARD`** (issue #99 open; an unguarded controller is
silently public).

| Module | Responsibility | Notable exports / notes |
|---|---|---|
| `prisma` | PrismaService singleton | imported everywhere |
| `auth` | Login/refresh/JWT (HS256 `{user_id, role, zone_id}`), scrypt hashes, 15-min access / 30-day rotating refresh | in-memory stores (→ #91); `acting-context.ts` acting-role attribution |
| `settings` | `system_settings` audited key-value (incl. `eligibility_mode`) | `SettingsService` |
| `audit` | `audit_logs` writer + `/api/audit-trail/tickets/:id` viewer | `AuditService` |
| `org` | Org graph CRUD: zones, plants, companies, users, engineers, SE coverage/territory, SLA rules, scoring weights, common kit, geography (PostGIS), zone-mapping | 14 admin controllers; `plant-eligible-floating-se.service.ts` MV refresh |
| `ingestion` | Everything AutoPlant: master sync, snapshot worker, run ledgers, partitions, health, **ingestion scheduler** | see §3a/§3b; self-contained (own guards + `ScheduleModule.forRoot()`) |
| `device-state` | Set-based recompute, SLA buckets, eligibility modes | **imported only by IngestionModule** (`device-state.module.ts:12-13`); other consumers reach the table via their own Prisma (#105 territory) |
| `ticketing` | Ticket creation, query, troubleshoot submission, auto-recovery, repeat-escalation, vehicle-unavailability, non-op dual-confirm, recovery lifecycle, install create+lifecycle | 8 controllers |
| `devices` | Device list read + per-device cycles/downtime-trend + deal-type tag | `DeviceService`, `DeviceDetailService` |
| `recommender` | Candidate selection, hard filters, scoring, canonical sort → `recommendations` | consumed by SchedulingModule |
| `scheduling` | Batch dispatch, day-plan/schedule queries, ZM override, same-day update, dispatch-run + daily dispatch cron | `SchedulingModule` imports `RecommenderModule` (#113) |
| `business-sweep-scheduler` (in `scheduling/`) | 10 env-gated `@Cron` sweeps: verification, install-verification, intraday-timeout, cross-zone, repeat-escalation, soft-inactive, system-efficiency, 3 month-start cubes | leaf module (#108) |
| `intraday` | CRITICAL insertion offer state machine, accept/decline/timeout | #29/#30/#101 |
| `cross-zone` | Platinum auto-escalation + manual flag, approve/deny/defer/re-escalate | #32 |
| `shared-pool` | SE shared ticket pool | #12 |
| `planner` | SE planner grid CRUD + recommender bias | #14 |
| `dashboard` | Zone dashboard aggregates | #06 |
| `reports` | fleet-uptime, soft-inactive trend, root-cause, efficiency, ZM scorecard + aggregation services | #39–#44 |
| `soft-state` | SE soft states + activity ping | #15 |
| `verification` | GPS three-phase verification, review, fraud flag | #18/#19 |
| `inventory` | Van stock, ledger, shadow-use, zone warehouse stock | #21/#24/#73 |
| `component-request` | Request flow, WAITING_COMPONENT, WM queue, oversight | #22/#23 |
| `engineers` | SE directory/admin CRUD (Phase 4), availability, leave | `EngineerAdminService` |
| `roles` | Role-backup cascade + CSM acting scope | #27 |
| `notifications` | In-app spine + channel-gateway seam (no real external adapters — #76) | `NotificationService` |
| `vouchers` | Expense vouchers SE→ZM→OH finance | #38 |
| `me`, `zones` | Thin identity + zone-list controllers (AppModule-level, no module) | `me.controller.ts`, `zones.controller.ts` |

### 1.5 Branch / working-tree state at time of writing

- Branch `feat/autoplant-integration`; `main` exists but the integration line has **not** been
  promoted (INDEX.md:19 "Not yet promoted to `main`" — still true `[UNVERIFIED against remote]`).
- Uncommitted working tree: admin UI visual polish (overlay/shell/ui components, `index.css`),
  `devices.ts`/`schedules.ts` API clients, `device.service.ts`/`devices.controller.ts`,
  `zm-schedule-query.service.ts` + their tests, and a CLAUDE.md edit (git status at session start).
  This document describes the working tree as found.
- Standing trap: `.gitignore`'s `data/` rule untracks `apps/admin/src/components/data/` — the
  branch tip cannot build from a fresh clone (issue #114, open).

---

## 2. DATA LAYER

Source: `apps/backend/prisma/schema.prisma` (2,055 lines, 59 models + 1 materialized view),
55 migrations (`20260617103804_init_system_settings` → `20260709120000_intraday_one_live_offer`).
Conventions: snake_case via `@map`, timestamptz UTC, BigInt ids (except uuid for tickets/cycles/
submissions/users), PostGIS via `Unsupported(...)` + raw SQL, and **raw-SQL appendices** in
migrations for everything Prisma can't express (partial uniques, CHECKs, partitioning, the MV).

### 2.1 Org graph & reference config

| Table | Purpose | Key constraints / notes |
|---|---|---|
| `company_master` | Companies; recommender's tier gate + priority tie-break | `sourceCompanyId` unique (AutoPlant mirror key); `companyTier`+`companyPriorityRank` FSM/CRM-owned (schema:56-78) |
| `zones` | Unit of ZM authority + row scoping | `name` unique + case-insensitive `zones_name_ci_key (lower(name))` (migration `20260707120000`); contains the **UNZONED** holding zone |
| `plants` | Sites; clustering unit | `zoneId` **NOT NULL** (schema:197 comment: nullable-deferral rejected; unzoned plants land in UNZONED zone instead); `sourcePlantId` unique; full AutoPlant mirror columns (`source_zone_name`, `plant_state`…) stored verbatim for audit/derivation |
| `zone_mappings` | R6 crosswalk: normalized raw `zone_name` → FSM zone; PENDING/MAPPED/IGNORED, auto-discovered during sync | unique `(source_field, source_value_key)`; edits apply via `ZoneMappingService.reapply`, never re-sync (schema:1536-1565) |
| `plant_zone_overrides` | Per-plant pin to an FSM zone (highest precedence) | `sourcePlantId` unique |
| `users` | Account registry (RBAC actor) | **No credentials** — login is in-memory (#91); `phone`/`email` unique |
| `engineer_master` | SE profile (coverage type, capacity, shift, activity ping) | 1:1 `engineerId`=`users.userId`; `lastActivityAt` never gates scoring (ADR-0023/24) |
| `se_coverage` | DEDICATED/MULTI_PLANT plant assignment | CHECK `coverage_type <> 'FLOATING'`; partial unique `se_coverage_dedicated_se_key (se_id) WHERE DEDICATED` |
| `engineer_territory_coverage` | FLOATING SE territory (state/region/district ∪ polygon) | polygon `Unsupported(MultiPolygon)` **reserved, unused in v1** (schema:263); raw CHECK ≥1 dimension |
| `regions` / `districts` | Indian admin geography (~700 districts) | `districts` unique `(name, state)` |
| `sla_rule_config` | Tunable SLA windows | unique `(scope, key)` |
| `priority_rule_config` | Versioned recommender weight sets | unique `(weightSetRef, component)`; active set stamped into recommendations |
| `component_master` / `common_kit_definition` | Component catalog + common-kit hard-filter source | `min_qty > 0` CHECK |
| `system_settings` | OH-owned audited key-value JSONB (incl. `eligibility_mode`, `telemetry_retention_days`) | string PK |
| MV `plant_eligible_floating_se` | Plant↔floating-SE territory membership for the recommender | `CREATE MATERIALIZED VIEW` (migration `20260621160000`); refreshed by `plant-eligible-floating-se.service.ts` |

### 2.2 Devices & telemetry

| Table | Purpose | Constraints / writer status |
|---|---|---|
| `devices` | GPS unit registry; `deviceId` is the AutoPlant business string (leading-zero IMEIs) | `deal_type` NULL ⇒ OH manual tag (endpoint exists, #49); `device_type` **is written** by master sync (`master-mapping.ts:274` mirrors `tb_vehiclemaster.device_type`) — nullness in prod reflects source data, not a stub `[INFERRED from mapping code; live values unverified]` |
| `vehicles` | Fitment anchor → plant/company/transporter | `vehicle_no` unique; `status` mirrors AutoPlant deployment; transporter FK wired in migration `20260703120000` after nulling dangling values |
| `transporters` | AutoPlant `mst_transporter` mirror | `sourceTransporterId` unique; written by master sync |
| `raw_device_snapshots` | One row per ping — highest-volume table | **RANGE-partitioned daily** by `gps_datetime` (rebuilt in `20260706130000` — the original `20260619153000` declared PARTITION BY but only had a DEFAULT partition); PK `(id, gps_datetime)`; unique `(device_id, gps_datetime)` + `ON CONFLICT DO NOTHING` ⇒ idempotent chunk re-runs |
| `device_states` | Derived hot row per device: inactivity hours, `sla_bucket` (stored), eligibility, denormalised vehicle/plant/company | CHECK `inactivity_hours >= 0`; recomputed set-based by `DeviceStateService`; **18,528 rows in dev DB** (INDEX.md:132) |
| `snapshot_runs` / `snapshot_run_chunks` | Ingestion run ledger + per-chunk retry; drives data-as-of banner | partial unique `snapshot_runs_one_in_flight (status) WHERE 'RUNNING'` |
| `master_sync_runs` / `master_sync_rejects` | Master-sync ledger + itemised skip accounting (#97 Slice 4) | reject rows capped per run, best-effort writes |
| `pgi_history` | SAP Post-Goods-Issue events feeding the `pgi` eligibility gate | **NO production writer** — read-only in `device-state.service.ts:64`; SAP feed external/deferred, rows must be seeded (schema:1830-1832). This emptiness is blocker B7 |

### 2.3 Tickets & failure cycles

| Table | Purpose | Constraints |
|---|---|---|
| `failure_cycles` | Immutable inactivity episode; SLA primary-clock anchor; pause bookkeeping (`sla_accumulated_pause_seconds`) | **I1**: partial unique `failure_cycles_one_active_per_device WHERE state IN (OPEN, WAITING_COMPONENT, SUBMITTED, REPEAT, ESCALATED)` (widened in `20260621011500`); CHECKs `valid_close`, `pause_coupling (sla_paused = (sla_pause_reason IS NOT NULL))`; optimistic `version` |
| `tickets` | Unified work item, `work_type` ∈ TROUBLESHOOT/INSTALL/RECOVERY discriminates column families (install fitment cols, recovery collection cols) | **I2**: `failure_cycle_id` UNIQUE; raw CHECK TROUBLESHOOT ⇒ cycle NOT NULL; partial index `(plant_id) WHERE OPEN+UNASSIGNED` (shared pool, `20260621190000`); optimistic `version`. **No index on `device_id`/`vehicle_id`** (#103 open) |
| `ticket_events` | Append-only lifecycle timeline (narrower than audit_logs) | append-only by construction only — no DB trigger (schema:1812) |
| `vehicle_unavailability_reports` | SE-filed VU → SLA pause + dual clocks (#28) | `(status, expected_from)` index |
| `non_operational_markings` | Dual-confirmation Non-Op lifecycle + customer token + recovery-ticket back-ref | **I13**: partial unique one-active-per-device `WHERE state IN (CONFIRMED, ACTIVE)`; `customer_token` unique |
| `troubleshooting_submissions` | SE form: structured root cause (analytics source), GPS anchor, idempotency | unique `(se_id, client_submission_id)`; CHECK restricts `submission_type` to the two form types |
| `verification_runs` | Three-phase GPS verification per submission | partial unique `ux_vr_active (ticket_id) WHERE outcome IS NULL` |
| `soft_states` | VIEWED/ON_SITE/TROUBLESHOOT_STARTED field progress | partial unique `ux_ss_active (ticket_id, se_id, type) WHERE resolved_at IS NULL` + 3 raw CHECKs |

### 2.4 Scheduling & recommendations

| Table | Purpose | Constraints |
|---|---|---|
| `recommendations` | Append-only "why suggested" explainability (scoreBreakdown JSONB, canonical `processing_rank`) | partial unique `recommendations_one_suggested_per_ticket WHERE status='SUGGESTED'` (#100, `20260708120000`) |
| `work_schedules` | Per-SE Day-Plan container (no approval gate — ADR-0007/0019 superseded) | partial unique `work_schedules_one_active_per_se_zone_day (se_id, zone_id, date_from) WHERE ACTIVE` — **zone_id deliberately in the key** vs the #100 spec, to allow cross-zone plans (INDEX.md:97) |
| `plant_batch_assignments` / `batch_assignment_tickets` | Plant-stop batches + per-ticket rows with override history (`removed_at`, `deferred_to_date`) | partial unique `batch_assignment_tickets_one_active_per_ticket WHERE removed_at IS NULL` (`20260621180000:78`) |
| `se_planner` | ZM plant-visit intent; **soft bias** to the recommender, never a constraint | unique `(se_id, plant_id, planned_date)` |
| `intraday_insertions` | Mutable CRITICAL-insertion offer state machine + `retry_chain` JSONB | partial unique `intraday_insertions_one_live_offer_per_ticket WHERE PENDING_ACCEPTANCE` (#101, `20260709120000`) |
| `cross_zone_escalations` | Parallel escalation record — ticket never leaves home queue | indexes on `(status, escalation_type)`, `home_zone_id` |

### 2.5 Inventory

| Table | Purpose | Constraints |
|---|---|---|
| `se_van_stock` | Per-SE carried components (common-kit filter source) | CHECK `qty >= 0`; written only via ledger |
| `inventory_transactions` | Ledger: PRE_VERIFICATION→DEDUCTED/ROLLED_BACK; 409-loser SHADOW_USE→RECONCILED/DISPUTED | CHECK `qty > 0` |
| `component_request` | WAITING_COMPONENT flow REQUESTED→…→RECEIVED | `submission_id` unique (idempotent raise); optimistic `version` |
| `component_blocked_queue` | Tickets undispatchable for missing kit | partial unique `ux_cbq_active WHERE resolved_at IS NULL` |
| `zone_warehouse_stock` | Zone×SKU on-hand/reserved (#73) | unique `(zone_id, component_id)`; **manually WM-managed** — no automated replenishment/decrement (#95 open); `reserved` has no writer yet `[INFERRED — #95 owns allocation]` |

### 2.6 Availability, escalation actors, vouchers

| Table | Purpose |
|---|---|
| `se_availability` | Windowed planning availability; only AVAILABLE ⇒ recommender-eligible (ADR-0010) |
| `leave_requests` | SE-filed leave w/ ZM approval → writes an availability window (`availability_id` link) |
| `role_unavailability` | Manager-tier backup cascade windows (ZM→CSM→OH, #27) |
| `expense_vouchers` / `expense_voucher_items` | Voucher lifecycle DRAFT→…→PAID; unique `(se_id, client_submission_id)`; item cascade-delete |

### 2.7 Auth / audit / notifications

| Table | Purpose / posture |
|---|---|
| `users` | See §2.1 — registry only, no credentials (#91) |
| `audit_logs` | Same-transaction immutable audit; `acted_as_role`/`acting_zone` proxy attribution. **Append-only, unpartitioned, no retention** (#104) |
| `notifications` / `notification_deliveries` | In-app spine + per-channel delivery records; external send is a seam (#76). Same growth posture (#104) |

### 2.8 Reporting summaries (all delete+insert idempotent rebuilds, cron deferred → #108 now provides ticks)

| Table | Grain | Writer |
|---|---|---|
| `device_downtime_summary_monthly` | device×month downtime + #44 cycle metrics | `FleetUptimeAggregationService` |
| `soft_inactive_count_history` | zone×half-day soft-inactive snapshot | `SoftInactiveCountService` |
| `root_cause_summary_monthly` | month×zone×company×plant×device_type×SE×category cube | `RootCauseAnalyticsAggregationService` |
| `zm_performance_summary_monthly` | month×zone×ZM decision-activity counts | `ZmPerformanceAggregationService` |
| `system_efficiency_summary_daily` | day×dims additive counters + stage-time sums (11 INSERT…SELECT families) | `SystemEfficiencyAggregationService` |

### 2.9 Growth & retention posture

- **Partitioned + retained:** only `raw_device_snapshots` — daily partitions, 3-day create-ahead
  (`partition-maintenance.service.ts:13`), retention from `system_settings.telemetry_retention_days`,
  O(1) `DROP TABLE` per day, DEFAULT partition never dropped. Gated by
  `PARTITION_MAINTENANCE_ENABLED=true` (`:53`, default OFF) — **must be flipped with the ingestion
  scheduler or pings silently pile into DEFAULT after the 3-day runway** (INDEX.md:150-153).
- **Append-only with NO retention/partitioning:** `audit_logs`, `ticket_events`, `notifications`,
  `recommendations`, `master_sync_rejects`, `soft_inactive_count_history` (#104 open).
- **No production writer (awaiting external feed or manual entry):** `pgi_history` (SAP feed absent —
  blocker B7); `zone_warehouse_stock.reserved` (allocation flow → #95); `users` credentials (#91);
  `engineer_territory_coverage.polygon` (v1 uses hierarchy only); `regions`/`districts` seed-only.
- **Optimistic-version columns** exist on `failure_cycles`, `tickets`, `component_request`,
  `non_operational_markings` — enforcement is per-service and incomplete (#101 partial, see §5).

---

## 3. PIPELINE LOGIC, SUBSYSTEM BY SUBSYSTEM

### 3a. AutoPlant master sync (#96)

**Algorithm** (`master-sync.service.ts:79-95`): read `ap_masters` (`mst_company`/`mst_transporter`/
`mst_plant`) + master columns of `ap_widgets.tb_vehiclemaster`; upsert into FSM Postgres keyed by
`source_*_id` in FK order companies → transporters → plants → vehicles → devices. **Plant-first
derivation**: scope anchors on `mst_plant.status='ACTIVE'`; companies are *derived* (created only
when an in-scope plant names them) — no company allow-list, no reliance on the dirty
`mst_company.company_type`. Vehicles filtered to `deployment_status='DEPLOYED'`
(`ingestion.module.ts` binds `deploymentStatuses: ['DEPLOYED']`).
- **Zone resolution**: injected `PlantZoneResolver` = `MappingTableZoneResolver` — precedence
  `plant_zone_overrides` pin → `zone_mappings` MAPPED row (normalized `zone_name`) → **UNZONED
  holding zone** for PENDING/IGNORED; unseen raw values auto-discovered as PENDING rows.
- **Anti-drift (R4) is structural**: the pure `master-mapping` layer excludes every FSM-owned column
  (`ops_override`, tier/rank, operational `zone_id`, `deal_type`) from its update set
  (`master-sync.service.ts:92-94`) — edits re-apply via `ZoneMappingService.reapply`, never re-sync.
- **Skip accounting**: itemised per-reason counters + `master_sync_rejects` rows, capped 5,000/run,
  best-effort writes (`master-sync.service.ts:71-76,123-130`).
- **Batching**: reads ≤90 rows/query (DBA <100 cap); writes batched 500-row `$transaction`s
  (`UPSERT_BATCH_SIZE`, `master-sync.service.ts:56-63`).
- **Guards**: `master_sync_runs` single-in-flight (409 `RUN_IN_PROGRESS`), stale-run reaper shared
  with snapshots. Unconfigured env binds `EMPTY_MASTER_SOURCE` → no-op.
- **Known limit**: zone coverage is data-starved — zone_name is ~98% complete fleet-wide but
  near-absent in the ACTIVE plants FSM syncs, so ~83% of synced devices land UNZONED
  (`docs/audits/unzoned-plants-2026-07-07.md` `[spot-checked below, §4]`).

### 3b. Snapshot ingestion (#04/#97)

**Algorithm** (`snapshot-ingestion.worker.ts:31-137`): open a RUNNING `snapshot_runs` row → drain
the `SourceReader` keyset-cursor chunk by chunk (default tick chunkSize 90,
`integration-sync.service.ts:72`) → each chunk retries ×3 with exponential backoff independently →
finalize SUCCESS/PARTIAL/FAILED.
- **Idempotency**: `raw_device_snapshots` unique `(device_id, gps_datetime)` + `ON CONFLICT DO
  NOTHING` — chunk re-runs and cursor overlap are free.
- **Two-cursor asymmetry** (review A3, `worker:120-128`): `data_as_of` = conservative display
  watermark (high-water of succeeded chunks, never advances on lost data); resume `cursor` =
  optimistic re-read floor (first failed chunk's lower bound on PARTIAL).
- **Read-error fall-through** (`worker:64-68,102-104`): a mid-scan source read throw (VPN drop) no
  longer orphans the run — caught, run finalized PARTIAL/FAILED (the "run 456" fix).
- **Run ledger + reaper**: `snapshot_runs_one_in_flight` partial unique; `reapStaleRuns()`
  (`stale-run.ts`, wired in `snapshot-run.service.ts:43` per INDEX.md:91) fails runs stuck RUNNING
  past `INGESTION_STALE_RUN_MIN`.
- **Partitioning**: daily partitions + 3-day create-ahead + settings-driven retention, gated
  `PARTITION_MAINTENANCE_ENABLED` (§2.9).
- **UTC normalization**: `AUTOPLANT_SOURCE_UTC_OFFSET_MIN` env feeds the reader
  (`ingestion.module.ts`) — the AutoPlant session is known non-UTC (§5 env issues).

### 3c. Device-state recompute (#05, R4-B set-based)

**Algorithm** (`device-state.service.ts:41-99`): two set-based statements, no telemetry scan —
(1) `INSERT … ON CONFLICT DO NOTHING` guarantees a `device_states` row per device; (2) one UPDATE
derives `inactivity_hours` (= now − `latest_gps_datetime`, clamped ≥0; the latest ping is maintained
incrementally **at ingest** by `SnapshotIngestionService`), `is_inactive` (vs
`inactivity_threshold_hours` setting, default 24), `sla_bucket` (SQL CASE generated from the same
`SLA_BANDS` as the TS classifier — cannot drift, `sla-bucket.ts`), `eligible_for_uptime`, and the
denormalised fitment columns. Runs on the telemetry tick because bucket aging is a function of
wall-clock time.
- **Eligibility modes** (`eligibility.ts`, #112): `pgi` (canonical) = EXISTS `pgi_history` row ≤15
  days (`DEFAULT_PGI_WINDOW_DAYS`); `all-deployed` (interim proxy) = vehicle status ∈
  (ACTIVE, DEPLOYED). Both AND NOT an active Non-Op marking (`device-state.service.ts:60-87`).
- `has_open_failure_cycle` deliberately untouched here — owned by ticket creation.

### 3d. Ticket creation (#05/#08/#112)

**Algorithm** (`ticket-creation.service.ts:27-108`): select `device_states` WHERE inactive AND
eligible AND no open cycle AND has plant+company → per device, one `$transaction` creating
`failure_cycle` (OPEN, or REPEAT if a VERIFIED cycle closed ≤24h prior — ADR-0021), the parented
TROUBLESHOOT `ticket` (tier denormalised), the OPEN `ticket_event`, and the
`has_open_failure_cycle` flip. Invariant I1 partial-unique backstops races — P2002 ⇒ silent skip.
- **Gate**: candidates exist only if `eligible_for_uptime` is true — with `eligibility_mode='pgi'`
  over an empty `pgi_history`, **0 tickets are created today** (blocker B7, INDEX.md:133).
- **Auto-recovery** (`auto-recovery.service.ts` `[by module role; internals not re-read this
  session]`) closes cycles whose device resumed pinging — `CLOSED_AUTO_RECOVERY`; repeat-escalation
  sweep (`repeat-escalation.service.ts`) escalates repeat offenders, driven by #108's cron.
- **Known limit**: per-candidate loop (one transaction per device) — fine at current volumes;
  unbounded candidate list is a #106-family concern only if a mass outage flips thousands inactive
  at once `[INFERRED]`.

### 3e. Recommender (#10/#72/#75)

**Entry**: `RecommenderService.runForZone(zoneId)` (`recommender.service.ts:76`) — no own cron;
called by the dispatch run (#113) or HTTP.
**Mode switch**: `SoftInactiveCountService.modeForZone` — soft-inactive count > threshold% ⇒
DEFICIT, else PREVENTIVE (#40); PREVENTIVE appends the INSTALL backlog (REQUESTED+UNASSIGNED,
`installSort`: tier → rank → oldest backlog) after TROUBLESHOOT candidates (#75).
**Candidate order per plant** (ADR-0001, `candidate-selection.service.ts:13-17`): strict precedence
DEDICATED → MULTI_PLANT (both `se_coverage`) → FLOATING (`plant_eligible_floating_se` MV), fallback
to next tier when hard-filtered out.
**Hard filters** (`hard-filters.ts:40-47`, first-failure-wins) and their **actual data feed**
(`recommender.service.ts:147-157`):

| Filter | Drop condition | Feed today |
|---|---|---|
| VEHICLE_ON_TRIP | readiness = ON_TRIP | **Stubbed `'UNKNOWN'` constant** (`:152`) — Issue 28 VU is a ZM review flow, not wired as a feed; this filter can never fire in production |
| SE_UNAVAILABLE | not (`engineer_master.is_active` AND current `se_availability` window = AVAILABLE) | real (`se-availability.service.ts`) |
| OVER_CAPACITY | assigned-today count ≥ `engineer_master.daily_capacity` | real |
| COMMON_KIT_INCOMPLETE | `se_van_stock` fails `common_kit_definition` min quantities | real (`InventoryService.commonKitStatus`) |
| COMPONENT_UNAVAILABLE | expected components OOS | **Stubbed `true`** — expected-component leg is open #51 |

Activity-ping staleness is deliberately NOT a filter (CONTEXT decision revised 2026-06-09,
`hard-filters.ts:9-13`).
**Scoring** (`scoring.ts`): weighted components `company_priority_rank` (A=1.0, B=0.9…),
`dispatch_urgency` (bucket severity 0..1), `repeat_failure_penalty`, `distance` (floating), plus
PREVENTIVE-only `repeat_failure_bonus`/`device_age` (inactivity/7d); Plant Cluster Multiplier
(default 1.25) on additional same-plant tickets; active weight set from `priority_rule_config`
(default `v1`; PREVENTIVE looks for `<set>_preventive`, else code defaults). SE-Planner entry =
soft bias among eligible candidates (ADR-0022).
**Canonical sort** (ADR-0017, `canonical-sort.ts`): Tier desc → Bucket desc → PriorityRank asc →
Oldest-inactive asc → DeviceID asc; `processing_rank` persisted.
**Output**: one `recommendations` row per ticket — SUGGESTED (with scoreBreakdown + weightSetRef +
mode) or UNASSIGNABLE (never silently dropped); one-SUGGESTED-per-ticket partial unique (#100).

### 3f. Batch dispatch (#11/#100)

**Algorithm** (`batch-assignment.service.ts:41-130`): single `$transaction`: (1) per-zone
`pg_try_advisory_xact_lock(hashtext('dispatch_zone_<id>'))` — non-blocking; a concurrent dispatch
skips with `{0,0,0}` (`:57-62`); (2) load SUGGESTED recs with SE, canonical `processingRank` order;
(3) group SE → plant → tickets; (4) create ACTIVE `work_schedules` + AUTO_ASSIGNED
`plant_batch_assignments` (stop-sequenced) + `batch_assignment_tickets` (sort-ordered); flip each
ticket `FORMALLY_ASSIGNED` (leaves shared pool); (5) consume recommendations SUGGESTED→DISPATCHED —
second call returns `{0,0,0}` (idempotent). Day-plan notifier events buffered in-tx, fired
post-commit (`:44-46`). Durable backstops: the three partial uniques (one-SUGGESTED-per-ticket,
one-ACTIVE-schedule-per-se/zone/day, one-active-batch-per-ticket). Graceful P2002 handling.
Verified by 4 specs added with #100 (INDEX.md:97; suite 920 pass at that commit).

### 3g. Schedulers (#97-A1 / #108 / #113)

All in-process `@nestjs/schedule`; cron expressions resolved from env **once at decorator
evaluation** (flag flips need a restart — `integration-scheduler.service.ts:46-47`); the
enabled/dormant gate is re-checked every tick; every handler has a per-name single-in-flight guard
and never throws out of cron context.

| Cron name | Default | Env override | Master switch | Calls |
|---|---|---|---|---|
| `ingestion-telemetry` | `*/30 * * * *` | `INGESTION_TELEMETRY_CRON` | `INGESTION_SCHEDULER_ENABLED` | `ingestTelemetry()` = snapshot→recompute→ticket-create |
| `ingestion-masters` | `0 2 * * *` | `INGESTION_MASTERS_CRON` | `INGESTION_SCHEDULER_ENABLED` | `syncMastersTick()` |
| partition maintenance | daily tick inside ingestion scheduler `[INFERRED — gated separately]` | — | `PARTITION_MAINTENANCE_ENABLED` | `PartitionMaintenanceService.tick()` |
| `business-dispatch` | `0 5 * * *` | `BUSINESS_SWEEP_DISPATCH_CRON` | `BUSINESS_SWEEPS_ENABLED` | `DispatchRunService.runForActiveZones` (per active zone: runForZone → dispatchForZone, per-zone error contained) |
| `business-verification` | `*/5 * * * *` | `BUSINESS_SWEEP_VERIFICATION_CRON` | `BUSINESS_SWEEPS_ENABLED` | verification sweep |
| `business-install-verification` | `*/5 * * * *` | … | 〃 | install first-ping sweep |
| `business-intraday-timeout` | `*/2 * * * *` | … | 〃 | `sweepTimeouts` |
| `business-cross-zone` | `*/15 * * * *` | … | 〃 | `sweepAutoEscalations` |
| `business-repeat-escalation` | `*/15 * * * *` | … | 〃 | repeat escalation |
| `business-soft-inactive` | `0 6,18 * * *` | … | 〃 | soft-inactive snapshot |
| `business-system-efficiency` | `30 1 * * *` | … | 〃 | previous-day cube |
| `business-fleet-uptime` | `0 3 1 * *` | … | 〃 | previous-month cube |
| `business-root-cause` | `15 3 1 * *` | … | 〃 | previous-month cube |
| `business-zm-performance` | `30 3 1 * *` | … | 〃 | previous-month cube |

(Defaults: `business-sweep-scheduler.service.ts:27-36`, `dispatch-scheduler.service.ts:10`,
`integration-scheduler.service.ts:21-23`.) **All three master switches default OFF.** Manual HTTP
triggers (`POST /api/integration/run-pipeline`, `POST /api/schedules/dispatch-run`, per-sweep
POSTs) drive identical code paths with no cron.

---

*(Sections 3h–k, 4–8 follow.)*
