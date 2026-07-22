# FSM Platform — System Analysis Report

**Date:** 2026-07-21 · **Branch:** `feat/autoplant-integration` · **Type:** READ-ONLY analysis (no code changed)

> Scope: what "ticket creation" and the "SE engine" are and how they work; the full list of
> PostgreSQL tables with manual fetch queries; how backend / DB / frontend connect; and the file
> structure + modules. Authoritative current-state doc: `docs/SYSTEM-STATE-2026-07.md` — cited
> throughout; read it for anything deeper.

---

## 1. What "Ticket Creation" is, and the engine behind it

### 1.1 In plain terms
A **ticket** is the platform's unit of field work. The dominant kind is a **TROUBLESHOOT** ticket,
created automatically — not by a human — when a fitted GPS device *stops reporting*. Tickets also
exist for **INSTALL** (new fitment) and **RECOVERY** (device collection), but only TROUBLESHOOT
tickets are born from the telemetry pipeline. `tickets.work_type` discriminates the three, and each
work type activates a different family of columns on the same `tickets` table.

Every TROUBLESHOOT ticket is parented by exactly one **failure cycle** (`failure_cycles`) — the
immutable record of one inactivity episode and the anchor for the SLA clock. The relationship is
1:1 and enforced (`tickets.failure_cycle_id` UNIQUE, invariant **I2**).

### 1.2 The engine: `TicketCreationService`
**File:** `apps/backend/src/ticketing/ticket-creation.service.ts` (entry `createForInactiveEligible()`, line 27).

Not a rules engine or ML — a deterministic, set-based SQL selection followed by a per-device
transaction. The algorithm:

1. **Select candidates** from the hot table `device_states` (`:33`) where *all* of:
   - `is_inactive = true` (no ping within threshold, default 24h)
   - `eligible_for_uptime = true` (the eligibility gate — see §1.3)
   - `has_open_failure_cycle = false` (no episode already open)
   - device **not departed** — re-read live from the `device_departures` ledger
     (`departures: { none: { restoredAt: null } }`, `:46`), *not* the derived `is_departed` flag
     (the #130 run-65 hardening)
   - plant **not deactivated** (`plant_deactivations`, Issue 119, `:30-31,48`)
   - `plant_id` and `company_id` both non-null (a ticket needs a fitment)

2. **Per candidate, one `$transaction`** (`:80-113`):
   - create `failure_cycle` — state `OPEN`, or `REPEAT` if a `VERIFIED` cycle for the device closed
     within the last 24h (ADR-0021, `:68-77`)
   - create the parented `ticket` (`work_type=TROUBLESHOOT`, `status=OPEN`, `company_tier`
     denormalised from `company_master`)
   - append the opening `ticket_event` (`toState=OPEN`)
   - flip `device_states.has_open_failure_cycle = true`

3. **Race safety:** partial-unique index `failure_cycles_one_active_per_device` (invariant **I1**)
   backstops the flag; a concurrent duplicate raises Postgres `P2002`, caught and **silently
   skipped** (`:116`).

### 1.3 The eligibility gate (why 0 tickets are created today)
`eligible_for_uptime` is set upstream by `DeviceStateService` (`device-state.service.ts`) using
`system_settings.eligibility_mode`:
- **`pgi`** (canonical): a `pgi_history` row ≤15 days old. **`pgi_history` has no production
  writer** (SAP feed absent) → under `pgi`, **zero eligible → zero tickets**. Documented blocker **B7**.
- **`all-deployed`** (interim proxy, set 2026-07-10): vehicle status ∈ (ACTIVE, DEPLOYED).

Both also require **no active Non-Op marking**. Ticket creation is code-complete and tested but is
currently **gated OFF by data/config**, not by missing code.

---

## 2. The "SE algorithm / engine" — the Recommender

Given open tickets, **which Service Engineer should go**. A **deterministic scoring-and-precedence
engine**, not ML.

**File:** `apps/backend/src/recommender/recommender.service.ts` (entry `runForZone(zoneId)`, line 97).
No cron of its own — called by the daily dispatch run (#113) or over HTTP.

### 2.1 Pipeline inside `runForZone`
1. **Mode switch** (`:101`) — `SoftInactiveCountService.modeForZone`: soft-inactive count over
   threshold ⇒ **DEFICIT**, else **PREVENTIVE**. PREVENTIVE appends the **INSTALL backlog** after
   troubleshoot candidates (`installBacklog`, `:434`).
2. **Collect tickets** (`:103`) — OPEN, UNASSIGNED, TROUBLESHOOT in the zone, excluding deactivated
   plants and departed devices.
3. **Canonical sort** (`:133`, `canonical-sort.ts`, ADR-0017):
   `Tier desc → SLA-Bucket desc → CompanyPriorityRank asc → Oldest-inactive asc → DeviceID asc`.
   The resulting `processing_rank` is persisted.
4. **Per ticket, pick the SE** (loop `:174`):
   - **Candidate precedence** (`candidate-selection.service.ts`, ADR-0001): strict
     **DEDICATED → MULTI_PLANT** (both `se_coverage`) **→ FLOATING** (MV `plant_eligible_floating_se`).
     Falls to the next tier when the higher tier is hard-filtered out.
   - **Hard filters** (`hard-filters.ts`, first-failure-wins):

     | Filter | Drops when | Live feed today |
     |---|---|---|
     | `VEHICLE_ON_TRIP` | readiness = ON_TRIP | **stubbed `'UNKNOWN'`** (`:191`) — never fires |
     | `SE_UNAVAILABLE` | not (`engineer_master.is_active` AND `se_availability` = AVAILABLE) | real |
     | `OVER_CAPACITY` | assigned-today ≥ `engineer_master.daily_capacity` | real |
     | `COMMON_KIT_INCOMPLETE` | `se_van_stock` fails `common_kit_definition` mins | real |
     | `COMPONENT_UNAVAILABLE` | expected components OOS | **stubbed `true`** (open #51) |

     Activity-ping staleness is **deliberately not a filter** (`hard-filters.ts:9-13`).
   - **SE Planner soft bias** (ADR-0022, `:204`): among *passed* candidates, prefer the ZM-planned
     SE for this plant/date; else strict-precedence `passed[0]`. A bias, never a constraint.
5. **Scoring** (`scoring.ts`, `:286`) — weighted sum of `company_priority_rank`, `dispatch_urgency`
   (bucket severity 0..1), `repeat_failure_penalty`, `distance` (floating, deferred-null), plus
   PREVENTIVE-only `repeat_failure_bonus`/`device_age`. **Plant Cluster Multiplier** (default 1.25,
   `:13`) rewards additional tickets at an already-seeded plant. Active weights from
   `priority_rule_config` (default `v1`; PREVENTIVE seeks `<set>_preventive`).
6. **Persist** (`:294`) — one `recommendations` row per ticket: `SUGGESTED` (full `scoreBreakdown`
   JSON + weight-set ref + mode) or `UNASSIGNABLE` (never silently dropped, `:217`). One-`SUGGESTED`-
   per-ticket partial unique (#100).
7. **Transparency trace** (`:331`) — optional `dispatch_decision_traces` rows ("why this SE": chosen
   + ≤5 runners-up in precedence terms). Observe-only.

> **#126 wedge guard** (`:172`, `clearFinalizedOrphans`): stale `SUGGESTED` recs from a rolled-back
> dispatch are cleared before re-suggesting, and the create is guard-not-throw — otherwise one
> orphan P2002-wedges the whole zone every run.

### 2.2 After recommendation — Batch Dispatch
The recommender only *suggests*. **`BatchAssignmentService`** (`batch-assignment.service.ts`,
#11/#100) turns `SUGGESTED` recs into day plans in a single advisory-locked, idempotent
`$transaction`: groups SE → plant → tickets, creates `work_schedules` + `plant_batch_assignments` +
`batch_assignment_tickets`, flips tickets to `FORMALLY_ASSIGNED`, consumes recs
`SUGGESTED → DISPATCHED`. **None of this runs unattended today** — `BUSINESS_SWEEPS_ENABLED` OFF;
manual HTTP triggers drive identical code.

---

## 3. PostgreSQL queries to manually fetch every table

**Connection:** Postgres 16 + PostGIS, schema `public`, snake_case names (Prisma `@@map`).
**65 base tables + 1 materialized view.**

### 3.1 Discover & auto-generate (recommended)
```sql
-- List every base table
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name;

-- Row-count estimate per table (instant even on raw_device_snapshots)
SELECT relname AS table, n_live_tup AS est_rows
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC;

-- AUTO-GENERATE a capped SELECT for every table (run, copy the query column, run that)
SELECT format('SELECT * FROM %I LIMIT 100;', table_name) AS query
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name;
```

### 3.2 Explicit SELECTs by domain
> `LIMIT 100` guards against huge tables. Raise/remove as needed.

**Org graph & reference config**
```sql
SELECT * FROM company_master               LIMIT 100;
SELECT * FROM zones                         LIMIT 100;
SELECT * FROM plants                        LIMIT 100;
SELECT * FROM zone_mappings                 LIMIT 100;
SELECT * FROM plant_zone_overrides          LIMIT 100;
SELECT * FROM plant_deactivations           LIMIT 100;
SELECT * FROM users                         LIMIT 100;
SELECT * FROM engineer_master               LIMIT 100;
SELECT * FROM se_coverage                   LIMIT 100;
SELECT * FROM engineer_territory_coverage   LIMIT 100;
SELECT * FROM regions                       LIMIT 100;
SELECT * FROM districts                     LIMIT 100;
SELECT * FROM sla_rule_config               LIMIT 100;
SELECT * FROM priority_rule_config          LIMIT 100;
SELECT * FROM component_master              LIMIT 100;
SELECT * FROM common_kit_definition         LIMIT 100;
SELECT * FROM system_settings               LIMIT 100;
SELECT * FROM plant_eligible_floating_se    LIMIT 100;   -- MATERIALIZED VIEW
```

**Devices & telemetry**
```sql
SELECT * FROM devices                       LIMIT 100;
SELECT * FROM device_departures             LIMIT 100;
SELECT * FROM vehicles                      LIMIT 100;
SELECT * FROM transporters                  LIMIT 100;
SELECT * FROM device_states                 LIMIT 100;
SELECT * FROM raw_device_snapshots          LIMIT 100;   -- daily RANGE-partitioned; huge, filter gps_datetime
SELECT * FROM snapshot_runs                 LIMIT 100;
SELECT * FROM snapshot_run_chunks           LIMIT 100;
SELECT * FROM master_sync_runs              LIMIT 100;
SELECT * FROM master_sync_rejects           LIMIT 100;
SELECT * FROM device_state_recomputes       LIMIT 100;   -- #130 semantic-canary ledger
SELECT * FROM pgi_history                   LIMIT 100;   -- empty (blocker B7)
```

**Tickets & failure cycles**
```sql
SELECT * FROM failure_cycles                 LIMIT 100;
SELECT * FROM tickets                        LIMIT 100;
SELECT * FROM ticket_events                  LIMIT 100;
SELECT * FROM vehicle_unavailability_reports LIMIT 100;
SELECT * FROM non_operational_markings       LIMIT 100;
SELECT * FROM troubleshooting_submissions    LIMIT 100;
SELECT * FROM verification_runs              LIMIT 100;
SELECT * FROM soft_states                    LIMIT 100;
```

**Scheduling & recommendations**
```sql
SELECT * FROM recommendations               LIMIT 100;
SELECT * FROM work_schedules                LIMIT 100;
SELECT * FROM plant_batch_assignments       LIMIT 100;
SELECT * FROM batch_assignment_tickets      LIMIT 100;
SELECT * FROM se_planner                    LIMIT 100;
SELECT * FROM intraday_insertions           LIMIT 100;
SELECT * FROM cross_zone_escalations        LIMIT 100;
SELECT * FROM dispatch_runs                 LIMIT 100;
SELECT * FROM dispatch_run_zones            LIMIT 100;
SELECT * FROM dispatch_decision_traces      LIMIT 100;
```

**Inventory**
```sql
SELECT * FROM se_van_stock                  LIMIT 100;
SELECT * FROM inventory_transactions        LIMIT 100;
SELECT * FROM component_request             LIMIT 100;
SELECT * FROM component_blocked_queue       LIMIT 100;
SELECT * FROM zone_warehouse_stock          LIMIT 100;
```

**Availability, escalation actors, vouchers**
```sql
SELECT * FROM se_availability               LIMIT 100;
SELECT * FROM leave_requests                LIMIT 100;
SELECT * FROM role_unavailability           LIMIT 100;
SELECT * FROM expense_vouchers              LIMIT 100;
SELECT * FROM expense_voucher_items         LIMIT 100;
```

**Auth / audit / notifications**
```sql
SELECT * FROM audit_logs                    LIMIT 100;
SELECT * FROM notifications                 LIMIT 100;
SELECT * FROM notification_deliveries       LIMIT 100;
```

**Reporting summary cubes** (delete+insert idempotent rebuilds)
```sql
SELECT * FROM device_downtime_summary_monthly  LIMIT 100;
SELECT * FROM soft_inactive_count_history       LIMIT 100;
SELECT * FROM root_cause_summary_monthly        LIMIT 100;
SELECT * FROM zm_performance_summary_monthly    LIMIT 100;
SELECT * FROM system_efficiency_summary_daily   LIMIT 100;
```

> **Partition note:** `raw_device_snapshots` is RANGE-partitioned daily. Always filter by
> `gps_datetime` (e.g. `WHERE gps_datetime >= now() - interval '1 day'`) or you scan all history.

---

## 4. How Backend, DB, and Frontend connect

```
┌─────────────────────┐     HTTPS/JSON, Bearer JWT      ┌──────────────────────────┐
│  Admin FE (React)   │  ── fetch → /api/... ────────►  │  NestJS backend (:3000)  │
│  apps/admin  :5173  │  ◄── JSON ─────────────────────  │  global prefix /api      │
└─────────────────────┘                                 └───────────┬──────────────┘
                                                          Prisma 7   │  mysql2 pool (VPN, RO)
                                                                     ▼            ▼
                                                        Postgres 16+PostGIS   AutoPlant MySQL
                                                        (primary store)       (external source)
```

### 4.1 Frontend → Backend
- **BASE_URL** = `VITE_API_URL ?? 'http://localhost:3000/api'` (`apps/admin/src/api/http.ts:9`).
- **One thin typed client per backend area** — ~35 modules under `apps/admin/src/api/*.ts`
  (`tickets.ts`, `dashboard.ts`, `schedules.ts`, `engineers.ts`, `dispatch-runs.ts`, …).
- All go through a **single shared `fetch` interceptor** installed over `window.fetch`
  (`installAuthFetch`): attaches the Bearer token and implements **single-flight rotating-refresh on
  401** (Issue 109) — a 401 triggers one refresh; concurrent 401s share it; success retries the
  original once; failure clears the session and bounces to login.
- **No react-query / SWR** — **hand-rolled hooks** (`hooks/index.ts`). Routing is React Router
  (`AppRoutes.tsx`, ~100 entries) behind `ProtectedRoute` + `RoleRoute` gates mirroring backend `@Roles`.

### 4.2 Backend internals
- **Boot** (`main.ts`): `validateBootConfig()` fails fast on missing JWT secret / bad DB URL (#98);
  a preflight `PrismaService.onModuleInit()` runs the **#130 build-fingerprint / migration-skew
  guard** *before* Nest builds the module graph; body-parser off so the explicit 1 MB JSON limit is
  the only parser (#99); shutdown hooks enabled.
- `AppModule` imports **24 feature modules**, mounts ~45 controllers under global prefix **`/api`**.
  CORS allows `ADMIN_ORIGIN ?? http://localhost:5173`.
- **Guard chain** is a **global `APP_GUARD`**: `AuthGuard → RoleGuard → ZoneScopeGuard`. Every route
  authenticates by default; `@Public()` opts out (login/refresh, health probes, non-op confirm).
  `ZoneScopeGuard` clamps a ZM to their `zone_id` (403 `ZONE_SCOPE_VIOLATION`).
- **Auth:** HS256 JWT `{user_id, role, zone_id}`, 15-min access + 30-day rotating refresh. **Stores
  are in-memory** (`InMemoryUserStore`) — DB-seeded users cannot log in yet (open issue **#91**).

### 4.3 Backend → Databases
- **Primary DB — Postgres via Prisma 7.** One `PrismaService` singleton injected everywhere; 55
  migrations. Everything Prisma can't express (partial uniques, CHECKs, daily partitioning, the MV,
  PostGIS `Unsupported(...)`) is raw-SQL appendices inside migrations.
- **External source — AutoPlant MySQL over VPN** via `mysql2` (lazy pool, read-only). The
  `ingestion` module owns it: **master sync** (`ap_masters` → companies/plants/vehicles/devices,
  daily) and **snapshot ingestion** (telemetry pings → `raw_device_snapshots`, every 30 min). Unset
  env ⇒ empty/mock sources so dev/CI boots.
- **Cron is in-process only** (`@nestjs/schedule`) — **no Redis / BullMQ / S3**. Two homes:
  `IntegrationSchedulerService` (ingestion) and `BusinessSweepSchedulerModule` +
  `DispatchSchedulerService` (field-loop sweeps + daily dispatch). **All three master switches
  default OFF** (`INGESTION_SCHEDULER_ENABLED`, `BUSINESS_SWEEPS_ENABLED`,
  `PARTITION_MAINTENANCE_ENABLED`).

### 4.4 End-to-end data funnel (one line each)
`AutoPlant MySQL` → **[a]** master sync → **[b]** snapshot ingestion (`raw_device_snapshots`) →
**[c]** device-state recompute (`device_states`) → **[d]** ticket creation
(`tickets`+`failure_cycles`) → **[e]** recommender (`recommendations`) → **[f]** batch dispatch
(`work_schedules`) → **[g]** field loop (troubleshoot/install/recovery/non-op/inventory) →
**[h]** GPS verification → **[i]** report cubes.

---

## 5. File structure & modules

### 5.1 Monorepo top level (pnpm workspace + turbo)
```
fsm-platform-greenfield/
├─ apps/
│  ├─ backend/     NestJS modular monolith (Postgres + Prisma + AutoPlant MySQL)
│  ├─ admin/       React 18 + TS + Vite admin dashboard (SPA)
│  └─ mobile/      React Native + Expo — AUTH SHELL ONLY (login/session; no screens)
├─ packages/       shared workspace packages
├─ docs/           authority docs: SYSTEM-STATE-2026-07.md (current-state truth), agents/, ui/, ADRs, audits/
├─ .scratch/fsm-platform-v1/   live issue tracker (INDEX.md = build order + session log)
├─ CONTEXT.md      domain language / business rules (single source)
├─ CLAUDE.md       agent operating instructions
└─ pnpm-workspace.yaml, turbo.json
```

### 5.2 Backend modules — `apps/backend/src/` (24 feature modules)
`AppModule` (`app.module.ts`) wires these. Grouped by role in the funnel:

| Group | Modules |
|---|---|
| **Platform** | `prisma` (DB singleton), `auth` (JWT/RBAC), `settings` (`system_settings`), `audit` (`audit_logs`), `config`/`build-info`/`health`/`common`, `me`, `zones` |
| **Org/reference** | `org` (14 admin controllers: zones, plants, companies, users, engineers, SE coverage/territory, SLA rules, scoring weights, common kit, geography, zone-mapping), `engineers`, `roles` (role-backup cascade), `plant-deactivation` |
| **Ingestion** | `ingestion` (master sync, snapshot worker, run ledgers, partitions, ingestion scheduler — self-contained), `device-state` (set-based recompute), `device-departure` |
| **Ticketing → dispatch** | `ticketing` (creation, troubleshoot, auto-recovery, non-op, recovery, install), `devices`, `recommender`, `scheduling` (batch dispatch + `business-sweep-scheduler` + dispatch cron), `intraday`, `cross-zone`, `shared-pool`, `planner` |
| **Field loop** | `soft-state`, `verification` (GPS 3-phase), `inventory`, `component-request` |
| **Output** | `dashboard`, `reports` (fleet-uptime, root-cause, efficiency, ZM scorecard), `notifications` (in-app spine + channel seam), `vouchers`, `exports` |

Support files: `main.ts` (bootstrap + #130 preflight guard), `app.config.ts` (global prefix, CORS,
pipes, limits), `bootstrap-guard.ts`, `prisma/schema.prisma` (2,055 lines, 59 models + 1 MV),
`prisma/migrations/` (55).

### 5.3 Admin frontend — `apps/admin/src/`
```
api/         ~35 typed clients over http.ts (one per backend area)
auth/        session/token handling
components/  design system — data/ (DataTable, MetricStrip, PageHeader), ui/, overlay/,
             shell/ (AppShell, Sidebar, Footer), domain/, charts
hooks/       hand-rolled data hooks (no react-query)
lib/         helpers (csv/exportFile, plantNames, …)
pages/       one dir per surface: dashboard, tickets, engineers, schedules, dispatch, cross-zone,
             inventory, warehouse, verification, reports, vouchers, planner, coverage, settings,
             admin, exports, install, readiness, help
utils/       misc
```
Pages compose design-system primitives and consume `api/*` clients; a vitest suite (200+ tests)
asserts against stable test-ids/aria-labels.

### 5.4 Mobile — `apps/mobile/`
**Auth shell only** (14 files, `src/auth/*`, `app/index.tsx`): login / session / token store. Every
field screen (M-series) is unbuilt; Issue #54 (Mobile Foundation) is open.

---

## 6. Key caveats
- **Pipeline is code-complete but idle:** ticket creation yields 0 today (empty `pgi_history`,
  blocker B7); all schedulers default OFF. Nothing runs unattended.
- **Auth users are in-memory** (#91) — the `users` table exists but can't log in.
- **No production writer:** `pgi_history`, `zone_warehouse_stock.reserved`,
  `engineer_territory_coverage.polygon`.
- **Authoritative current-state doc:** `docs/SYSTEM-STATE-2026-07.md` — read it for anything deeper.
