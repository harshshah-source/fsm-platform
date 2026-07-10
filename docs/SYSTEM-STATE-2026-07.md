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

### 3h. Manual scheduling / override / intraday / cross-zone (ZM & CSM/OH paths)

- **ZM override engine** (#13a, `override.service.ts` header): each action (reassign/split/remove/
  defer/reorder) commits immediately, flips batch + schedule to OVERRIDDEN with mandatory reason +
  overrider, audits in-transaction, fires a push. No approval gate. Overriding work an SE is ON_SITE
  on goes through the conflict seam (`soft-state-conflict.ts`).
- **Same-day update** (#31, `same-day-update.service.ts` header): ZM add/remove/reorder mid-shift;
  applies immediately (no SE acceptance); logged `MANUAL_ZM_UPDATE`; the **Intra-day Queue is a view
  over AuditLog** (2026-06-25 decision — no new model); reuses the #13 override engine.
- **Intraday CRITICAL insertion** (#29/#30, `intraday-insertion.service.ts`): CRITICAL+ bucket fires
  `fireForZone` → best AVAILABLE candidate by strict precedence (ping staleness never filters) →
  `intraday_insertions` PENDING_ACCEPTANCE offer (10-min `ACCEPTANCE_TIMEOUT_MIN`) + push +
  first-class SE_ACCEPTANCE WhatsApp record. Accept → `assignTicket(insertAtTop)` (top of Day Plan);
  decline (reason code) or timeout → reroute to next SE, `retry_chain` appended; 3 retries →
  ESCALATION_REQUIRED + ZM "Manual assignment needed" (`availableSesForManualAssign`/`manualAssign`).
  **Accept-vs-timeout race guarded** by `transitionOrConflict` + the one-live-offer partial unique
  (#101 leg, commit `9940534`).
- **Cross-zone escalation** (#32, `cross-zone-escalation.service.ts`): `sweepAutoEscalations` —
  Platinum unassigned 1h in CRITICAL+ or 4h OPEN → one AUTO_PLATINUM row to the CSM/OH queue;
  ZM `flag` for Gold/Silver (manual). Decider approve (target zone + SE → cross-zone assignment) /
  deny (reason; ticket stays home) / defer (review date); home-ZM `reEscalateToOps` on denied AUTO.
  Ticket never leaves its home queue. **Read-model gap**: `listForScope` omits DENIED AUTO rows, so
  the home ZM can't see the row to re-escalate (#93 open).

### 3i. Field loop: troubleshoot → verification → install/recovery/non-op → inventory

- **Troubleshoot submission** (#16, `troubleshoot-submission.service.ts` header): one transaction —
  Ticket OPEN→VERIFICATION_PENDING, cycle OPEN→SUBMITTED, SE's active soft states resolved, audit +
  lifecycle event; idempotent on `(se_id, client_submission_id)` (duplicate returns the original,
  `duplicate=true`). `component_unavailable=true` → auto-raises a `component_request`, cycle →
  WAITING_COMPONENT, primary SLA pauses (#22).
- **Verification** (#18, `verification.service.ts` header): re-entrant scan of VERIFICATION_PENDING
  tickets; Phase 1 = first ping ±500 m of the SE's form GPS (skipped without fraud when
  `presence_source=NONE`), Phase 2 = continued pinging; terminal outcomes CLOSED /
  FAILED_VERIFICATION / PARTIAL_RECOVERY transition ticket + cycle, resolve inventory
  PRE_VERIFICATION → DEDUCTED or ROLLED_BACK (#24), and set `fraud_flag` for the review page (#19).
  Driven by the #108 5-min sweep (or HTTP).
- **Install lifecycle** (#33/#34/#102, `install-lifecycle.service.ts` header): manual create (single
  or all-or-nothing CSV with line-numbered errors) → SCHEDULED → ON_SITE → FITTED (serials + photo)
  → ACTIVATED → first-valid-ping auto-verification within 24h → CLOSED, else FAILED_ACTIVATION
  (late ping still closes). Zone scoping (#102, `f48108f`): ZM clamped to home zone, SE own-ticket
  read, CSM/OH/WM cross-zone.
- **Non-Op** (#35): dual confirmation (manager + customer tokenised email) → CONFIRMED side-effects:
  auto-close open tickets `CLOSED_NON_OPERATIONAL`, eligibility exclusion, auto-create RECOVERY
  ticket for qualifying RECURRING deals; OH 7-day no-response override.
- **Recovery** (#36/#37): SE collection form (serial + condition) → COLLECTED → WM receipt
  auto-close (`AUTO_CLOSED_ON_WAREHOUSE_RECEIPT`); unable-to-collect → ZM decision queue; manual
  closure classified by acting role; stalled-14d Action-Required flag.
- **Inventory / van stock** (#21/#24/#73, `inventory.service.ts` header): `se_van_stock` read-only
  to the SE, mutated only via the ledger; common-kit completeness feeds the hard filter;
  Component-Blocked Queue for kit-incomplete drops; business 409 on already-closed ticket →
  loser's consumption recorded SHADOW_USE → WM reconciliation; `zone_warehouse_stock` manual WM
  set/adjust + fulfillment-SLA read.

### 3j. Auth / session / RBAC

**Backend**: HS256 JWT `{user_id, role, zone_id}`, 15-min access (`token.service.ts:19`), 30-day
single-use rotating refresh with reuse detection (`refresh-token-store.ts:15-32`) — but both stores
are **in-memory** (`user-store.ts`), so every restart drops all sessions and users; DB-seeded users
cannot log in (#91). **`JWT_ACCESS_SECRET` falls back to a hardcoded dev secret**
(`token.service.ts:18`, #98 open). Guard chain AuthGuard → RoleGuard → ZoneScopeGuard applied
**per-controller** — no global `APP_GUARD` (#99): an endpoint without `@UseGuards` is silently
public. `ZoneScopeGuard` rejects a ZM targeting another zone via `:zoneId`/`zone_id` param (403
ZONE_SCOPE_VIOLATION); **deeper zone clamping is service-level and uneven** — e.g. install scope
was only closed by #102; cross-zone/CSM acting scope threads through `acting-context.ts` +
`RequestActor` (#47). No rate limiting anywhere (#110): `/auth/login` scrypt is a CPU-DoS vector.
**Admin FE session** (#109, done): single-flight rotating refresh on 401 with one retry
(`apps/admin/src/api/http.ts`), reload rehydration via `/me` behind a loading gate, honest login
errors; tokens in memory/storage (httpOnly-cookie upgrade deferred to #91).

### 3k. Admin FE architecture

React 18 + Vite + React Router (`AppRoutes.tsx`, ~100 route/element entries) behind
`ProtectedRoute` + `RoleRoute` role gates mirroring backend `@Roles`. Data layer: one thin typed
client per backend area (`apps/admin/src/api/*.ts`, 29 modules) over the shared `http.ts`
interceptor — **no react-query/SWR; hand-rolled hooks** (`hooks/index.ts`). Pages compose the
design-system primitives (`components/data/` DataTable/MetricStrip/PageHeader…, `components/ui`,
`components/overlay`, chart kit per `DESIGN-SYSTEM.md`). **Selector contract**: FE-series reskins
preserved test ids/aria-labels; vitest suite (200+ tests) asserts against them.
**No mock-data remnants found in pages** (`grep -rl "mock" apps/admin/src/pages` = 0 hits) — all
pages consume real API clients; remaining gated placeholders are *documented omissions* wired to
missing backend endpoints (#90 work-type mix, #94 ticket chrome, #74 scorecard causality).
Known FE gaps: `window.prompt` reason legs (#80), Playwright visual baseline (FE-00 partial),
`components/data/` untracked by git (#114).

---

## 4. DOCS vs CODE RECONCILIATION

Method: every issue file's `Status:` line was extracted (`grep -H -m1 "^Status:" issues/*.md`,
138 files) and compared against INDEX.md and against code evidence from §3. INDEX.md (updated
2026-07-09) proved **accurate on every entry spot-checked** (evidence for #100/#101/#102/#108/
#112/#113 re-verified this session: `transition-or-conflict.ts` exists and is adopted only by
intraday; `dispatch-run.service.ts:46 runForActiveZones`; the partial uniques in `20260708120000`/
`20260709120000`; the cron tables in §3g). **The issue FILES lag the INDEX** — the index was
updated without touching the files.

### 4.1 Issue files whose `Status:` line is STALE (file says ≠ verified reality)

| Issue file | File claims | Verified status | Correction |
|---|---|---|---|
| `02-org-reference-config-settings.md` | ready-for-agent | done in practice — org module + Settings shipped; ACs closed via #45/#46/#47 (all done) | mark done, note AC ownership |
| `28-vehicle-unavailability-dual-sla-clocks.md` | ready-for-agent | accepted core (INDEX.md:72 — VU report + dual clocks + ZM review, backend+admin; `vehicle-unavailability.service.ts` exists) | mark accepted-core; residual → #64/#65 |
| `31-zm-manual-same-day-update.md` | ready-for-agent | accepted core (INDEX.md:75; `same-day-update.service.ts` exists) | mark accepted-core; mobile cues → #66 |
| `45-plants-admin-ui.md` | ready-for-agent | done (INDEX.md:163; `org/plants.controller.ts` + admin Plants tab) | mark done |
| `46-company-update-api-ui.md` | ready-for-agent | done (INDEX.md:164; `PATCH /org/companies/:id`) | mark done |
| `49-device-deal-type-column-tagging.md` | ready-for-agent | done (INDEX.md:167; deal-type tag endpoint + FE-22 admin control) | mark done |
| `62-ticket-detail-components-tab.md` | ready-for-agent | done (INDEX.md:172) | mark done |
| `69-admin-install-create-ui.md` | ready-for-agent | done (INDEX.md:179; `/install` route + `api/install.ts`) | mark done |
| `FE-21…FE-25` (5 files) | ready-for-agent | done (INDEX.md:280-284, dated 2026-06-29/07-01; routes + tests exist in `apps/admin/src/pages/reports/`) | mark done |
| `FE-12-schedules-batch-parity.md` | done, "badges → **#71**" | badges follow-up was **renumbered #79** at the 2026-06-28 integration merge (INDEX.md:189) | fix stale cross-ref |
| `FE-16-recovery-nonop-queues-parity.md` | done, "Modal upgrade → **#72**" | renumbered **#80** (INDEX.md:190) | fix stale cross-ref |

Consistent (no correction needed): all remaining files match INDEX/code — includes the done set
(04–16, 18/19, 29/30, 32–44, 47/48, 72/73/75, 100/102/108/109/112/113, FE-01–08/10–20/26), the
partials (21, 101, FE-00, FE-09), the open backlog (17, 20, 50, 54–61, 63–68, 71, 74, 76, 77,
81–95 present, 98/99, 103–107, 110/111, 114), and the gated ones (91 needs-triage, 96/97
ready-for-human tails, 88 needs-info).

### 4.2 Issue numbers with INDEX entries but NO file in `issues/`

`#51, #53, #70, #78, #79, #80, #95` are described in INDEX.md (some at length, e.g. #70 done,
#78 done-core) but have no `issues/NN-*.md` file. #70/#78 are done so only history is missing;
**#51, #53, #79, #80, #95 are OPEN work items that exist only as INDEX prose** — they should get
stub files or be explicitly tracked as index-only. (Correction applied in the finale: noted in
INDEX.md header.)

### 4.3 Major documents

| Document | Claim vs reality | Verdict |
|---|---|---|
| `CLAUDE.md:5` | "…backend (Postgres 16 + PostGIS + Prisma, **Redis/BullMQ, S3**)" — no Redis/BullMQ/S3 dependency exists (`package.json`; #97 note "No Redis/BullMQ") | **wrong** → correct the stack line |
| `.scratch/fsm-platform-v1/INDEX.md` | funnel table, activation checklist, per-issue notes | **accurate** (spot-checked; last verified 2026-07-09) |
| `docs/PRD-fsm-admin-dashboard.md:293` | "**Data layer (current): Static mock data** in the admin data directory drives all pages" | **wrong/stale** — all admin pages consume real API clients (§3k); needs a banner note |
| PRD generally | roles, SLA buckets, page inventory, invariants | accurate as *requirements*; unimplemented rules listed in §4.4 |
| `docs/workflow/fsm-business-technical-workflow.md` | 2,253-line business workflow; §14 offline queue, §21/22 hints/QR, §24 workers | accurate as spec; **describes subsystems that do not exist yet** (§4.4); its §25 "suggested tables" superseded by the real schema (§2) |
| `docs/audits/2026-07-03-backend-production-readiness-audit.md` | 13 findings | **partially superseded** — #1 scheduler, #4 reaper, #6 recompute/partitioning, MySQL timeouts RESOLVED since (re-audit + INDEX.md:88-93); rest live as #98–#107 |
| `docs/audits/2026-07-07-independent-production-readiness-reaudit.md` | re-verified all findings, filed #108–#111 | **accurate** |
| `docs/audits/2026-07-07-production-validation-audit.md` | live end-to-end run: 438 s pipeline, 0 orphans; 83% UNZONED; auth in-memory; Fleet-Uptime empty (no PGI); session TZ `Asia/Calcutta` | **accurate** — the strongest runtime evidence in the repo |
| `docs/audits/unzoned-plants-2026-07-07.md` | zone-completeness inversion (ACTIVE plants lack zone_name) | accurate `[spot-checked header only]` |
| `docs/architecture/autoplant-integration-progress-tracker.md:7` | "Last verified 2026-07-03 · HEAD `b45d00b`" | **stale** — ~40 commits behind; phase marks predate #97 slices 2–7, #100–#113 | 
| `docs/architecture/autoplant-integration-session-handoff.md` | session handoff from the same era | **stale** — superseded by `docs/HANDOFF-autoplant-ingestion-2026-07-07.md` + `97-PROGRESS.md` |
| `docs/architecture/backend-engineering-review-2026-07-05.md` | Part III A1–A6 remediation plan | **implemented** — all six landed as #97 slices (INDEX.md:42); mark as executed |
| `docs/HANDOFF-autoplant-ingestion-2026-07-07.md` | 5 commits, partition/ingestion pairing warning | accurate; its "pending" items partially closed since (#108/#112/#113) — needs a pointer |
| `.scratch/…/issues/97-HANDOFF.md` | already banner-marked SUPERSEDED 2026-07-09 | accurate (self-corrected) |
| `docs/progress/*` (49 files) | per-issue TDD reports + dated handoffs | historical records — no correction; do not treat any as current state |

### 4.4 Business rules in PRD/workflow that the code does NOT implement

1. **The SE mobile app in its entirety** (PRD §SE-Mobile screens :479-663; workflow §11–§14):
   only the auth shell exists (§1.1). Owners: #54–#61, #63–#68, #71, #77, #85–#89.
2. **Offline-first queue + batched sync** (PRD :309-310 WatermelonDB/SQLite; workflow §14):
   nothing client- or server-side; server API is #82, client #17.
3. **QR scanner + Technical Hints** (PRD §SE-QR/§Hints; workflow §21/§22): no code; needs #83
   (ticket search) + #84 (hints derivation) then #20.
4. **Push / WhatsApp / SMS / email actual delivery** (PRD :311, workflow §23): recorded in
   `notification_deliveries` via the gateway seam but **no external adapter sends anything** (#76).
   The PRD's "WhatsApp shown as sent — first-class" is honored in data (`first_class=true`).
5. **SAP PGI feed** (PRD Fleet-Uptime eligibility; workflow §7): `pgi_history` has no writer (§2.2);
   eligibility falls back to the `all-deployed` proxy only if Ops flips the setting (#112 shipped
   the mechanism, the feed itself has no owner issue — see §5 new stub).
6. **Media upload** (photos on troubleshoot/voucher/install): `photo_refs` columns exist; no
   upload/storage API (#81). S3 mentioned only in CLAUDE.md (wrongly).
7. **Vehicle readiness from AutoPlant LR-Date/Next-Trip** (workflow §9, PRD readiness hints):
   recommender readiness is stubbed UNKNOWN (§3e); source integration → #65.
8. **Expected-component hard-filter leg** (workflow §15): stubbed pass (#51).
9. **Warehouse replenishment / auto-decrement** (workflow §16 inventory lifecycle): warehouse
   on-hand is manual-set only (#95).
10. **Outcome-causality ZM scorecard metrics** (PRD §OH-Analytics): #74 — needs a
    decision→outcome linkage model that doesn't exist.
11. **EXPECTED_BACK readiness state** (v2 reference): deliberately omitted (FE-14, INDEX.md:269).
12. **Daily-status source for SE profile** (PRD M8d): still `needs-info` (#88).

### 4.5 Code behaviors the PRD/workflow do NOT describe (doc additions needed)

- The **zone-mapping crosswalk + UNZONED holding zone + per-plant override** machinery (§3a) —
  the workflow doc still assumes plants arrive zoned.
- **`eligibility_mode` setting** with the `all-deployed` interim proxy (#112) and its audited flip.
- The **three ops master switches** + per-sweep cron env matrix (§3g) and the
  ingestion↔partition-maintenance coupling rule.
- **Master-sync skip accounting** (`master_sync_rejects`) and `/api/integration/health`
  source-vs-FSM reconciliation.
- **Advisory-lock + consume-on-dispatch idempotency** design of batch dispatch (#100).
- **In-memory auth store** reality (PRD assumes real users; validation audit documents shared
  password dev store).
- The **Intra-day Queue = AuditLog view** decision (2026-06-25) — workflow §10 implies a table.
- **Repeat window = 24h from VERIFIED closure** (ADR-0021) — workflow §8 leaves the window vague.

---

## 5. GAPS, WEAK POINTS, BREAKING POINTS (ranked)

Ranked by blast-radius × likelihood once the funnel activates. Each cites its owner issue; two NEW
findings from this audit are filed as **#115** and **#116** (stubs in
`.scratch/fsm-platform-v1/issues/`).

1. **Auth is a dev scaffold** (#91 + #98 + #110). In-memory users/refresh tokens (restart = mass
   logout, DB users can't log in), hardcoded fallback JWT secret (`token.service.ts:18`), zero rate
   limiting on scrypt login (CPU-DoS vector, `110-…md` evidence). Blast radius: the whole product;
   nothing can be exposed beyond a demo network until #91/#98/#110 land.
2. **No deployment/DR story** (#111) — no Dockerfile/compose/runbook/backup. Compounded by the NEW
   finding **#115: `.gitignore:21 docs/*` leaves the entire PRD/workflow/audit/UI-reference doc set
   untracked** — a single-disk loss destroys the requirements + audit record, and a fresh clone
   can't even follow the documented agent workflow. (Same family as #114 `data/` shadowing the
   admin UI source, which also still makes the branch tip unbuildable from clone.)
3. **UNZONED zone-derivation problem** (data, not code): 83% of synced devices land UNZONED
   (validation audit exec summary; `docs/audits/unzoned-plants-2026-07-07.md`) because the ACTIVE
   plants FSM syncs mostly lack `zone_name` — the crosswalk mechanism (§3a) is built but starved.
   Blast radius: ZM dashboards/scoping/dispatch are meaningless for 5/6 of the fleet until Ops maps
   values or pins plants (zone ratification, B8 gate).
4. **PGI feed absence** — NEW stub **#116**: `pgi_history` has no writer; `pgi` eligibility mode is
   permanently 0-candidate and Fleet-Uptime is structurally empty. #112 shipped the mode switch and
   B7 records the pending decision, but no issue owned building the feed until now.
5. **#101 remaining races** (partial — only intraday accept-vs-timeout is guarded). Untreated
   confirmed sites (`101-…md:28-49`): SE-submit vs auto-recovery; two SEs submitting the same
   ticket (double stock decrement); non-op dual-confirmation stale writes (device can end
   permanently P2002-skipped); overlapping verification sweeps (double rollback of van stock;
   `markAutoRecovery` never resolves PRE_VERIFICATION inventory); `confirmResubmit` re-opening
   VERIFIED cycles; van-stock decrement from stale reads (`Math.max(0, qty-n)`) + missing
   `clientSubmissionId` persistence on the CONFLICT path (mobile retry double-decrements). Blast
   radius grows from ~zero (single operator, sweeps off) to real the day `BUSINESS_SWEEPS_ENABLED`
   flips with concurrent SEs.
6. **Perf cliffs** (#106): `criticalQueue` unbounded; all-default Prisma/pg pool with no
   `statement_timeout` (a runaway query hangs a connection); per-request dashboard scans with no
   cache. Also §3d's per-candidate transaction loop under a mass-outage spike `[INFERRED]`.
7. **Missing hot-FK indexes/constraints** (#103): `tickets.device_id`/`vehicle_id` unindexed
   (device-detail + verification lookups will seq-scan as tickets grow), `audit_logs(actor_role,
   created_at)` missing (ZM-scorecard aggregation pivots on it monthly).
8. **Module wiring forks** (#105): `recommender.module.ts` re-provides `InventoryService`/
   `SeAvailabilityService`/`SoftInactiveCountService`; `engineers.module.ts` re-provides
   `InventoryService`; `recommender.service.ts:71-73` `new`s cross-module services as constructor
   defaults. Silent duplicate singletons — becomes a correctness bug the day any of them caches.
9. **No CI** (#107): 920+ backend tests + 211 admin tests run only by hand on one OOM-prone 8GB
   box (full vitest runs randomly lose a fork worker — memory note); no from-zero-migration test,
   no concurrency suite, no route-guard sweep. Every "green" claim is a local claim.
10. **Append-only growth** (#104): `audit_logs`/`ticket_events`/`notifications`/`recommendations`
    unpartitioned with no retention — slow-burn until they aren't.
11. **No global guard/validation** (#99): a controller missing `@UseGuards` is silently public; no
    global `ValidationPipe` or body-size limits (CSV upload path).
12. **Environment integrity**: container clock drift ~5.5h + DB session `TimeZone=Asia/Calcutta`
    contradicting ADR-0025 UTC (validation audit finding 3, `:194`); AutoPlant source offset handled
    only via `AUTOPLANT_SOURCE_UTC_OFFSET_MIN`; health `ageMinutes` is clock-sensitive.
13. **Cross-zone re-escalate read-model hole** (#93): DENIED AUTO rows invisible to the home ZM —
    Issue 32's re-escalate AC only notionally met.
14. **Open funnel-quality gaps**: recommender vehicle-readiness stubbed UNKNOWN (#65) and
    expected-component leg stubbed pass (#51) — two of five hard filters can never fire (§3e table).

**New issue stubs filed by this audit**: `115-docs-tree-untracked-dr-exposure.md`,
`116-sap-pgi-feed-seam.md`. Everything else above already has an owner.

---

## 6. ACTIVATION & OPERATIONS STATE

### 6.1 Settings (`system_settings`, OH-owned, audited)

| Key | Default / effect | Current live value |
|---|---|---|
| `eligibility_mode` | `pgi` (canonical — requires PGI feed, i.e. 0 eligible today) \| `all-deployed` (interim proxy: vehicle status ∈ ACTIVE/DEPLOYED). Applied at next recompute; harmless to set while schedulers OFF | `[UNVERIFIED — dev DB not queried this session; default is pgi]` |
| `inactivity_threshold_hours` | 24 (`device-state.service.ts:8`) | `[UNVERIFIED]` |
| `telemetry_retention_days` | drives partition drops (`partition-maintenance.service.ts:62`) | `[UNVERIFIED]` |
| soft-inactive `threshold_pct` | 2% default (#40) — DEFICIT/PREVENTIVE switch | `[UNVERIFIED]` |

### 6.2 Env flags (all master switches default OFF; cron strings read once at boot)

| Flag | Effect |
|---|---|
| `INGESTION_SCHEDULER_ENABLED=true` | self-running pipeline: masters daily 02:00, telemetry */30 |
| `PARTITION_MAINTENANCE_ENABLED=true` | **must flip together with the above** — else pings pile into the DEFAULT partition after the 3-day runway and retention never runs |
| `INGESTION_STALE_RUN_MIN` | reaper threshold — set above telemetry cadence |
| `BUSINESS_SWEEPS_ENABLED=true` | dispatch cron + 10 field-loop/aggregation sweeps (§3g) |
| `BUSINESS_SWEEP_*_CRON`, `INGESTION_*_CRON` | per-tick overrides (§3g table) |
| `AUTOPLANT_*` (MySQL host/creds/schemas, `AUTOPLANT_SOURCE_UTC_OFFSET_MIN`) | unset ⇒ mock/empty sources, app boots fine |
| `JWT_ACCESS_SECRET` | **falls back to a hardcoded dev value if unset** (#98) |
| `PORT`, `ADMIN_ORIGIN` | 3000 / `http://localhost:5173` defaults |

### 6.3 What blocks activation — classified

- **Data-blocked**: SE roster + coverage (`engineer_master`/`se_coverage` empty in prod-shaped DBs;
  admin-enterable via `/engineers/manage`, tested seed exists — commit `0df556a`); zone mappings
  (83% UNZONED until Ops ratifies, B8); `pgi_history` (needs #116 or the proxy).
- **Decision-blocked**: B7 eligibility mode (business accepts the `all-deployed` proxy or waits for
  PGI); B8 zone ratification; credential-column placement for #91 (HITL).
- **Code-blocked**: nothing in the funnel itself (INDEX funnel table, re-verified §3). Hardening
  that *should* precede real traffic: #101-rest/#103/#99/#98/#110 (§7).
- **Access-blocked (HITL)**: live-VPN runtime verification of the scheduler (#97 tail), SAP PGI
  contract (#116), external notification channel accounts (#76), deployment target (#111).

**Enable order** (INDEX.md:141-160, verified against code): (1) set `eligibility_mode`; (2) flip
`INGESTION_SCHEDULER_ENABLED` **+** `PARTITION_MAINTENANCE_ENABLED` as one switch + set
`INGESTION_STALE_RUN_MIN`; (3) flip `BUSINESS_SWEEPS_ENABLED` only once SE/coverage data exists
(else every ticket → UNASSIGNABLE). Manual HTTP triggers exercise every path with flags OFF.

---

## 7. FORWARD PLAN (corrected priority order)

**Track A — activate the funnel (no code):** A1 zone ratification + mapping entry (B8; unblocks
UNZONED); A2 enter SE roster + coverage (or run the tested mock seed in dev); A3 B7 decision →
set `eligibility_mode`; A4 flip the paired ingestion+partition switches; A5 flip business sweeps.
Risk if skipped: the platform stays a demo. Prereqs: Ops-Head availability only.

**Track B — hardening before real traffic** (order matters):
1. **#91 auth store** (+ its #109 leftover: httpOnly refresh cookie) — prereq for any exposure;
   HITL decision on credential placement. Risk: total.
2. **#98 boot/ops** (fail-fast env incl. JWT secret, health, shutdown hooks, exception filter) —
   cheap, unblocks #111. 
3. **#99 global guard + ValidationPipe** — closes the silently-public-endpoint class.
4. **#110 rate limiting** — with #91/#98, completes the auth surface.
5. **#101 remaining races** — before `BUSINESS_SWEEPS_ENABLED` + concurrent SEs (§5.5 list is the
   worklist; the helper + pattern exist).
6. **#103 hot-FK indexes** — cheap, before ticket volume grows.
7. **#107 CI** — before any second contributor; the OOM box makes local green unreliable.
8. **#106 perf** (LIMIT, pool, timeout, cache) → **#104 retention matrix** → **#105 wiring** —
   medium urgency, pre-scale.
9. **#111 deployment/runbook** (HITL infra target) + **#115 docs tracking policy** + **#114
   gitignore fix** — the "survives a disk failure / fresh clone" set.

**Track C — product completion:** #116 PGI feed (HITL, restores canonical eligibility +
Fleet-Uptime); #93 cross-zone read model; #94 ticket chrome enrichment; #90 report aggregations;
#79/#80 FE polish; #51 expected-components; #65 vehicle readiness source; #95 warehouse
replenishment; #74 scorecard causality; #76 notification adapters (HITL accounts).

**Track D — mobile:** #54 foundation (blocks all M-series) → #81–#84 backend deps → #55–#61,
#63/#64/#66/#68/#71/#77/#85–#89 → #17/#20.

**Issue files needing SCOPE edits** (requirements changed since writing, not just status):
- `104-…` — raw-snapshot partitioning already shipped (R3); scope shrinks to the four append-only
  business tables.
- `91-…` — add the #109 leftover (httpOnly cookie upgrade) explicitly.
- `76-…` — carries the added transactional-outbox scope (INDEX.md:120-122); reflect in the file.
- `21-…` — remaining legs are only #51 + mobile; core is long done.
- `65-…` — AC#6 authority conflict already RESOLVED (2026-06-25, INDEX.md:175); file should stop
  presenting it as open.
**Status-only corrections**: the §4.1 table (applied in the finale commit).

---

## 8. GIT / GITHUB STATE — problems, commits, pushes needed

- **Remote**: `origin = github.com/harshshah-source/fsm-platform`. Remote has only `main`,
  `docs/ui-parity-governance`, `feat/issues-28-31-45-46-49-62`.
- **`feat/autoplant-integration` (this branch, the live line) has NO remote counterpart** — 49
  commits ahead of local `main`, existing only on this disk. Together with #115 (docs untracked)
  and #114 (`data/` untracked), a disk failure loses: the whole AutoPlant integration, the
  hardening series #100–#113, the admin UI source under `components/data/`, and every doc.
  **Action: push this branch** (user decision — task rule "no push" respected this session) and
  resolve #114/#115 so the pushed branch is actually buildable + documented.
- **`integration/fe-plus-backend` merge line** (INDEX.md:11-19) is also local-only
  `[UNVERIFIED whether fully merged into this branch — the branch list shows it still exists]`.
- **Uncommitted working tree** (at session start): admin UI polish (overlay/shell/ui components,
  `index.css`, dashboard/device/schedule pages + tests), backend `device.service.ts`/
  `devices.controller.ts`/`zm-schedule-query.service.ts` + e2e specs, CLAUDE.md whitespace noise.
  Needs an owner to review + commit as its own feature slice — not swept into docs commits.
- **`apps/admin/tsconfig.tsbuildinfo` is tracked** (build artifact; churns every build) — should
  be gitignored + `git rm --cached`.
- **Issue files without files** (§4.2): #51/#53/#79/#80/#95 exist only as INDEX prose.
- No open GitHub Issues/PR workflow is in use — the tracker is the local markdown backlog by
  design (CLAUDE.md Issue-tracker section).

---

## Appendix: completion record

Sections 1–8 complete 2026-07-10. Finale applied in commit `44a1472`: 13 issue-file status
corrections + FE-12/FE-16 renumber fixes + INDEX.md (#115/#116 registered, index-only note) +
CLAUDE.md stack-line fix. Banners added on disk to the gitignored docs (progress tracker, session
handoff, 2026-07-03 audit, 2026-07-05 review, 2026-07-07 handoff, PRD :294) — versioning them is
#115's decision. New issue stubs: #115, #116. This document supersedes all prior "current state"
claims; update it, don't fork it.
