# 00 — Page Inventory (Data Correctness Audit, Phase 1)

**Scope:** every page/screen in `apps/admin` (React SPA) and `apps/mobile` (Expo), traced to the
NestJS endpoint and the Postgres table/column behind each displayed value.
**Method:** static read of `AppRoutes.tsx`, every page component, every `apps/admin/src/api/*.ts`
client, every backend controller + query service, and `apps/backend/prisma/schema.prisma`.
**Status:** INVENTORY ONLY. No verification, no bug claims, no quality judgement.

## Conventions used in every table

- **API endpoint** — path *after* the global prefix `/api` (`main.ts:9`). Base URL is
  `VITE_API_URL ?? http://localhost:3000/api`.
- **Source table.column** — the physical Postgres column. `→` denotes a join hop.
- **Transform** — what the backend and/or the browser does to the raw column before display.
- **UNKNOWN** — could not be traced from code. Never guessed.

## Global chrome rendered on every authenticated page

Rendered by `AppRoutes.tsx` (`SnapshotBanner`) and `AdminShell` → `TopBar` / `Sidebar`.

| Field shown | Where on page | API endpoint | Source table.column | Transform or aggregation | Filters/params |
|---|---|---|---|---|---|
| "Snapshot: data as of \<ts\>" | Top banner (`SnapshotBanner.tsx`) | `GET /snapshots/latest` | `snapshot_runs.data_as_of` of the newest `status='SUCCESS'` run | `SnapshotQueryService.latest()` picks `findFirst({status:SUCCESS, orderBy startedAt desc})`; browser `toLocaleString()` | none; polls every 60 s + on ingestion-complete event |
| "Snapshot alert: last run failed / stuck" | Top banner (red) | `GET /snapshots/latest` | `snapshot_runs.status`, `snapshot_runs.started_at` of the newest run of **any** status | FE rule: `status==='FAILED'` OR (`status==='RUNNING'` AND `now-startedAt > 15 min`) — the 15-min stuck threshold is FE-only (`SnapshotBanner.tsx:18`) | none |
| "Build health: … stale build / eligibility swing" | Top banner (amber), OH only | `GET /integration/health` | `runtime_lock.version/fingerprint`; `master_sync_runs.build_version`, `snapshot_runs.build_version`; `device_state_recomputes.*` | `staleBuild = run.build_version < runtime_lock.version`; `swing` from `evaluateRecomputeCanary(prevEligible, eligible, threshold)` where threshold = `system_settings.recompute_canary_threshold_pct` (default 5) | role must be OPERATIONS_HEAD |
| Breadcrumb, role label, zone label ("Zone N" / "All zones") | Top bar | `GET /me` (via `AuthProvider`) | JWT claims `{user_id, role, zone_id}` — **not** a DB read | `ROLE_LABEL` map; `zone_id === null ? 'All zones' : 'Zone '+id` | — |
| Global search box (top bar) | Top bar | **none** | — | Input is rendered but has **no onChange/submit handler** (`TopBar.tsx:91-95`) — decorative | — |
| Notification bell | Top bar | **none** | — | Button has no handler; `/notifications` endpoints exist but are not called by the admin app | — |
| "Assign SE" button | Top bar | **none** (navigates to `/`) | — | — | — |
| Run Ingestion Now | Top bar, OH only | `POST /integration/run-pipeline` | writes: `master_sync_runs`, `raw_device_snapshots`, `device_states`, `device_state_recomputes`, `tickets`, `failure_cycles`, `ticket_events` | Success toast shows `summary.master.status`, `snapshot.inserted`, `deviceState.upserted`, `tickets.created` from the live `PipelineSummary` | OPERATIONS_HEAD only (FE + backend guard) |

**Untraceable on global chrome:** the top-bar search field and the bell icon have no data source at
all — they are static markup.

---

# 1. `/login` — Login

**Purpose:** authenticate and store the access/refresh token pair.
**Entities displayed:** none (marketing chrome only).

| Field shown | Where on page | API endpoint | Source table.column | Transform | Filters/params |
|---|---|---|---|---|---|
| "Active Tickets — 248" | Left KPI tile | **none** | — | **HARDCODED** constant `STATS` (`LoginPage.tsx:21-26`) | — |
| "SLA Compliance — 96.2%" | Left KPI tile | **none** | — | **HARDCODED** | — |
| "Fleet Online — 14,238" | Left KPI tile | **none** | — | **HARDCODED** | — |
| "Engineers Active — 84" | Left KPI tile | **none** | — | **HARDCODED** | — |
| Feature bullet list | Left panel | **none** | — | **HARDCODED** `FEATURES` | — |
| Error message | Sign-in card | `POST /auth/login` | — | 401 → "Invalid email or password"; other/network → "Service unavailable" | — |

**Write actions:** `POST /auth/login` → writes to the **in-memory** refresh-token store
(`InMemoryRefreshTokenStore`), not to `users`/`refresh_tokens` tables (per `SYSTEM-STATE-2026-07.md`
§1.3; DB tables exist but login does not use them).
**Untraceable:** all four KPI tiles and the feature list are fabricated marketing numbers.

---

# 2. `/` — Dashboard (role-selected)

`DashboardHome` selects: `WAREHOUSE_MANAGER` → **WarehouseDashboard**; otherwise `ManagerDashboard`,
which picks **OpsHeadDashboard** (OH, not acting), **CentralDashboard** (CSM, not acting), else
**ZmDashboard**. Any role with an `actingZone` set collapses to ZmDashboard.

`ManagerDashboard` loads, for all three manager variants:
`GET /dashboard/action-required`, `/dashboard/zone-overview`, `/dashboard/company-plant-overview`,
`/dashboard/critical-queue`, `/dashboard/fleet-summary`, `/reports/fleet-uptime?groupBy=zone`,
`/reports/fleet-uptime?groupBy=plant`, `/schedules/engineers`.

## 2a. ZmDashboard (`/`, ZM or any role acting-as-ZM)

**Entities:** zone, company, plant, device_state, ticket, failure_cycle, work_schedule.

| Field shown | Where on page | API endpoint | Source table.column | Transform or aggregation | Filters/params |
|---|---|---|---|---|---|
| Fleet Uptime % | Hero KPI card | `GET /reports/fleet-uptime?groupBy=zone` | `device_downtime_summary_monthly.downtime_seconds`, `.window_seconds` | `(1 − Σdowntime/Σwindow)×100`, 2 dp; **only rows `eligible = true`**; `window<=0 ⇒ 100`. FE hides it unless `fleet.eligibleDeviceCount > 0` | month defaults to current UTC month; ZM clamped to own zone (`s.zone_id`) |
| Inactive Devices | Hero KPI card | `GET /dashboard/zone-overview` | `device_states.is_inactive`, `.sla_bucket` | FE `Σ zones[].totalInactive`; backend counts `is_inactive = true AND sla_bucket IS NOT NULL` | ZM: `z.zone_id = jwt.zone_id`; deactivated plants excluded (`plant_deactivations.reactivated_at IS NULL`) |
| Critical Devices | Hero KPI card | `GET /dashboard/zone-overview` | `device_states.sla_bucket = 'CRITICAL'` | `sumCriticalDevices` = Σ `byBucket.CRITICAL` — **strictly the CRITICAL band**, not critical-and-worse | same as above |
| Companies | Hero KPI card (click → `/reports/fleet?tab=companies`) | `GET /dashboard/fleet-summary` | `COUNT(DISTINCT device_states.company_id)` | joined to `plants`; deactivated plants excluded | ZM: `p.zone_id = jwt.zone_id` |
| Plants | Hero KPI card (click → `/reports/fleet?tab=plants`) | `GET /dashboard/fleet-summary` | `COUNT(DISTINCT device_states.plant_id)` | as above | as above |
| Active Fleet | Hero KPI card (click → `/reports/device`) | `GET /dashboard/fleet-summary` | `COUNT(*) FILTER (WHERE device_states.is_departed = false)` | as above | as above |
| "Snapshot Healthy" pill | Hero actions | **none** | — | **HARDCODED** `<Badge tone="success">Snapshot Healthy</Badge>` (`ZmDashboard.tsx:100`) — not wired to snapshot state | — |
| Date-range chips | Hero actions | **none** | — | `DateRangeChips` is presentational; no page state consumes it | — |
| Fleet Activity Trend (3 series) | Chart section | `GET /dashboard/activity-trend?range=…` | inactive: `soft_inactive_count_history.soft_inactive_count`; troubleshoot/install: `COUNT(tickets)` by `work_type` | `date_trunc(unit, ts AT TIME ZONE 'UTC')`; inactive = `DISTINCT ON (zone, bucket)` last snapshot per zone per bucket, summed; **current bucket overwritten by a live count** `COUNT(*) FILTER (is_inactive AND eligible_for_uptime)`; buckets with no snapshot are `null` | range 1D/7D/1M/1Y/MAX → hour/day/day/month/month; ZM clamped to own zone |
| Zone operating mode (Catch-up / Steady + reason) | Card | `GET /dashboard/operating-mode` | `device_states.is_inactive`, `.eligible_for_uptime` joined `plants.zone_id` | `DEFICIT` iff `silentCount > 0.02 × eligibleCount`; enum never rendered — mapped by `operatingModeCopy` | ZM only (component self-gates); **no deactivated-plant exclusion here** (deliberate, per service doc-comment) |
| Action Required cards (9) | Card grid | `GET /dashboard/action-required` | `waiting_component_overdue` ← `failure_cycles.state='WAITING_COMPONENT' AND sla_paused AND sla_paused_at < now-7d`; `recovery_stalled` ← `tickets.work_type='RECOVERY' AND status NOT IN (CLOSED, FAILED_RECOVERY) AND last_state_changed_at < now-14d` | counts; **the other 7 cards are hardcoded stubs** with `count:0, available:false` (`dashboard.service.ts:119-129`) | ZM zone-scoped via `plants→zones` |
| SLA Bucket Distribution bars | Chart | `GET /dashboard/zone-overview` | `device_states.sla_bucket` grouped by zone | `COUNT(*) GROUP BY zone, sla_bucket` | as zone-overview |
| Zone Overview table: Zone / Inactive-Total / 8 bucket columns / Trend | Table | `GET /dashboard/zone-overview` | `zones.name`; `device_states.is_inactive`; `device_states.sla_bucket`; total = `COUNT(*)` over all device_states in zone | bucket header labels derived from `SLA_BANDS` in `@fsm/shared` | FE-only zone + bucket dropdown filters |
| Zone Overview "Trend" column | Table col | `GET /dashboard/zone-overview` | — | **Always `null`** — `trendPctVsPrevDay` is hardcoded `null` in `dashboard.service.ts:241`; renders "—" | — |
| Company/Plant Overview tree (company → plant → tickets) | Table | `GET /dashboard/company-plant-overview`; drill-down `GET /tickets?plantId=…` | `company_master.name/.company_tier`, `plants.name`, `device_states.sla_bucket`, `device_states` count | inactive counts grouped by company×plant×bucket; totals = separate `COUNT(*)` with the same filters; FE re-aggregates plants → company | FE search (falls back to `GET /tickets?q=`), assignment-state filter, sort |
| Company/Plant "Fleet Uptime %" column | Table col | `GET /reports/fleet-uptime?groupBy=plant` | `device_downtime_summary_monthly` grouped by `plant_id` | same uptime formula; `—` when the plant has no summary row | current month |
| Company/Plant "Inactive %" (export only) | CSV/XLSX/PDF export | derived | — | `inactive/total×100`, 1 dp | — |

**Write actions on ZmDashboard:** none directly (the Critical Queue with its assign action is
rendered only by `CentralDashboard`; `ZmDashboard` does not mount `CriticalQueue`).

## 2b. CentralDashboard (`/`, CSM not acting)

Same data loads. Differences:

| Field shown | Where | API endpoint | Source | Transform | Filters |
|---|---|---|---|---|---|
| Fleet Uptime | KPI | `GET /reports/fleet-uptime` | as above | as above | all zones |
| Zones Covered | KPI | `GET /dashboard/zone-overview` | — | `zones.length` — i.e. the count of zones **that have ≥1 inactive device**, not all zones | — |
| Inactive Devices | KPI | `/dashboard/zone-overview` | as above | Σ totalInactive | — |
| Escalations | KPI | `GET /dashboard/critical-queue` | `tickets` | `Σ group.tickets.length` over CRITICAL+ open TROUBLESHOOT tickets | — |
| "N action items" hint | KPI hint | `/dashboard/action-required` | as above | Σ counts of cards where `available && count>0` | — |
| Escalation Queue list (device, tier, company, plant, duration) | List | `/dashboard/critical-queue` | `tickets.device_id`, `company_master.name/.company_tier`, `plants.name`, `device_states.latest_gps_datetime` | flattened from the grouped payload, sorted by bucket severity | — |
| Zone Performance Scorecard | Table | see 2c | | | |
| Company/Plant Overview | Table | as 2a | | | |
| "Snapshot Healthy" pill | Header | **none** | — | **HARDCODED** | — |

## 2c. OpsHeadDashboard (`/`, OH not acting)

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Fleet Uptime | KPI | `/reports/fleet-uptime?groupBy=zone` | `device_downtime_summary_monthly` | as 2a | all zones |
| Inactive Devices | KPI (rolling odometer) | `/dashboard/zone-overview` | `device_states.is_inactive` | Σ | — |
| Critical Devices | KPI | `/dashboard/zone-overview` | `device_states.sla_bucket='CRITICAL'` | `sumCriticalDevices` (CRITICAL band only) | — |
| Active Fleet | KPI | `/dashboard/fleet-summary` | `device_states.is_departed = false` count | — | — |
| **Total Devices** | KPI | `/dashboard/fleet-summary` | `master_sync_runs.entity_stats -> 'devices' ->> 'observed'` of the newest `status='SUCCESS'` run | raw AutoPlant catalog size, **pan-India, never zone-filtered**; `null` → "—" | none — deliberately unscoped |
| Companies / Plants (split card) | KPI | `/dashboard/fleet-summary` | `COUNT(DISTINCT company_id/plant_id)` from `device_states` | labelled "pan-India" / "with tracked devices" | — |
| Zones — operating mode table | Table | `GET /dashboard/operating-mode` | `device_states.is_inactive`, `.eligible_for_uptime` per `zones` (LEFT JOIN, so empty zones appear) | DEFICIT iff `silent > 2% × eligible`; copy via `operatingModeCopy` | OH/CSM only |
| SLA Bucket Distribution | Chart | `/dashboard/zone-overview` | as 2a | — | — |
| Zone Performance Scorecard | Table | see below | | | |
| Company/Plant Overview | Table | as 2a | | | |

### Zone Performance Scorecard (`ScorecardTable`, rendered by CSM + OH variants)

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Zone | Table col | `/dashboard/zone-overview` | `zones.name` | — | — |
| Zonal Manager | Table col | `/dashboard/zone-overview` | `zones.zonal_manager_user_id → users.name` | `LEFT JOIN`; the literal zone named `UNZONED` renders "NA" | — |
| Inactive / Total | Table col | `/dashboard/zone-overview` | `device_states.is_inactive` count / `COUNT(*)` | `formatInactiveOfTotal` | click → `/reports/device?zoneId&status=INACTIVE` |
| Inactive > 24Hr | Table col | `/dashboard/zone-overview` | `device_states.sla_bucket` | `criticalPlusCount` = CRITICAL+HIGH_CRITICAL+SEVERE+VERY_SEVERE+LONG_PENDING — deliberately a **superset** of the "Critical Devices" KPI | — |
| Assigned SEs | Table col | `GET /engineers/directory` | `engineer_master.zone_id` where `is_active` | FE groups the SE directory by `zoneId` and counts | — |
| % Successful Troubleshoot | Table col | **none** | — | **HARDCODED "NA"** (`ScorecardTable.tsx:171`) — no backend source | — |
| Fleet Uptime (meter) | Table col | `/reports/fleet-uptime?groupBy=zone` | `device_downtime_summary_monthly` | per-zone `uptimePct`; colour thresholds ≥95 / ≥85 are FE-only | current month |

## 2d. WarehouseDashboard (`/`, WAREHOUSE_MANAGER)

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Open Requests | KPI | `GET /warehouse/requests` | `component_request.status` | FE counts status ∈ {REQUESTED, APPROVED, SHIPPED} | backend already filters to those three |
| Tickets Blocked | KPI | `GET /component-blocked` | `component_blocked_queue` where `resolved_at IS NULL` | `rows.length` | ZM-scoped for ZM; WM sees all |
| Low-Stock SKUs | KPI | `GET /inventory/warehouse-stock` | `zone_warehouse_stock.on_hand`, `.reserved`, `.low_stock_threshold` | `available = on_hand − reserved`; `lowStock = available <= threshold`; FE counts | ZM-scoped for ZM only |
| Fulfillment SLA % | KPI | `GET /inventory/warehouse-stock/fulfillment-sla` | `component_request.created_at`, `.received_at`, `.status` | `withinSlaPct = |{received within 7d}| / |received| × 100`; `slaWindowDays` default 7 (**hardcoded param**, `warehouse-stock.service.ts:136`) | none — **not zone-scoped** |
| Component Request Queue table (Component / Company / Requested-by / Status / Age) | Table | `GET /warehouse/requests` | `component_master.name`, `company_master.name` (via ticket), `component_request.se_id`, `.status`, `.created_at` | `ageDays = floor((now − created_at)/86400000)` | — |
| Warehouse Stock table (Component / Zone / On hand / Reserved / Available / Threshold) | Table | `GET /inventory/warehouse-stock` | `zone_warehouse_stock.*`, `zones.name`, `component_master.name` | `available = on_hand − reserved` | — |
| Shadow-Use Reconciliation table (Component / Qty / Engineer / Company) | Table | `GET /warehouse/shadow-use` | `inventory_transactions` where `status='SHADOW_USE'`, `component_master.name`, `tickets→company_master.name` | — | none — **not zone-scoped** (`ShadowUseService.queue()` has no scope arg) |
| "Snapshot Healthy" pill | Header | **none** | — | **HARDCODED** | — |

**Write actions:** "Adjust" stock modal → `PATCH /inventory/warehouse-stock` writes
`zone_warehouse_stock.on_hand / .reserved / .low_stock_threshold` + one `audit_logs` row
(`WAREHOUSE_STOCK_SET`).

**Untraceable on the dashboards:** "Snapshot Healthy" badges (all three manager variants),
"% Successful Troubleshoot", the Zone Overview "Trend" column, `DateRangeChips` selections, and 7 of
the 9 Action Required cards.

---

# 3. `/tickets` — Ticket Operations

**Purpose:** filterable list of every open/recently-closed ticket in scope, SLA-sorted.
**Entities:** ticket, device_state, failure_cycle, company, plant, zone, vehicle, transporter,
work_schedule, plant_batch_assignment, component_request.
**Endpoint:** `GET /tickets` (+ `GET /devices/filter-options` for the dropdowns).

| Field shown | Where on page | API endpoint | Source table.column | Transform | Filters/params |
|---|---|---|---|---|---|
| `#<8 chars>` | Table col "Ticket" | `/tickets` | `tickets.ticket_id` | `.slice(0,8)` | — |
| Device \<id\> | Table col "Ticket" | `/tickets` | `tickets.device_id` | — | — |
| Work Type | Table col | `/tickets` | `tickets.work_type` | — | filter `workType` |
| Company (+ `#id`) | Table col | `/tickets` | `company_master.name` (LEFT JOIN on `tickets.company_id`) | falls back to `Company <id>` | filter `companyId` |
| Plant (+ `#id`) | Table col | `/tickets` | `plants.name` | `formatPlantDisplayName` (FE) | filters `plantId`, `plant` (free text) |
| Vehicle No. | Table col | `/tickets` | `vehicles.vehicle_no` via `tickets.vehicle_id` | — | part of `q` search |
| Tier | Table col | `/tickets` | `tickets.company_tier` (**denormalised on the ticket at creation**, not the live company tier) | `TierBadge` | — |
| Assignment (Assigned/Unassigned + Overridden + SE name) | Table col | `/tickets` | `tickets.assignment_state`; SE name from `batch_assignment_tickets → plant_batch_assignments.se_id → users.name`; `overridden = pba.status='OVERRIDDEN' OR work_schedules.status='OVERRIDDEN'` | LATERAL, `removed_at IS NULL`, newest `bat.created_at` | filter `assignmentState` |
| Status | Table col | `/tickets` | `tickets.status` | `StatusPill` | filter `status` |
| Inactive (duration badge) | Table col | `/tickets` | `device_states.latest_gps_datetime`; colour from `device_states.sla_bucket` | `formatInactiveDuration(now − latest_gps_datetime)` computed **in the browser**; falls back to the bucket label | filter `bucket` |
| Age | Table col | `/tickets` | `tickets.created_at` | `floor((Date.now() − createdAt)/86400000)` — browser clock | — |
| Flags: REPEAT | Table col | `/tickets` | `tickets.repeat_failure` | — | — |
| Flags: ESCALATED | Table col | `/tickets` | `tickets.status='ESCALATED'` OR `failure_cycles.state='ESCALATED'` | — | — |
| Flags: WAITING COMPONENT · Nd · \<CR status\> | Table col | `/tickets` | `failure_cycles.state`, `failure_cycles.sla_paused_at`, latest `component_request.status` (correlated subquery, newest `created_at`) | days = `floor((now − sla_paused_at)/86400000)` in browser; darkens past 7 d | — |
| Flags: auto | Table col | `/tickets` | `tickets.status='CLOSED_AUTO_RECOVERY'` | — | — |
| Row order | — | `/tickets` | `device_states.sla_bucket` | `SEVERITY_RANK DESC, tickets.created_at DESC` | — |
| Result cap | — | `/tickets` | — | `LIMIT min(limit ?? 100, 500) OFFSET 0` — **the page never sends limit/offset, so it always shows the first 100 rows and has no pager** | — |

**Write actions:** none on the list itself.
**Untraceable:** none. Note the SLA-bucket dropdown lists all 8 buckets regardless of what exists.

---

# 4. `/tickets/:ticketId` — Ticket Detail Drawer (modal/drawer over the list)

**Endpoints:** `GET /tickets/:id`, and lazily per tab: `GET /component-requests/by-ticket/:ticketId`,
`GET /tickets/:id/forms`, `GET /tickets/:id/verification`.

### Overview tab

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Device | dl | `/tickets/:id` | `tickets.device_id` | — | — |
| Vehicle | dl | `/tickets/:id` | `vehicles.vehicle_no` | — | — |
| Work type | dl | `/tickets/:id` | `tickets.work_type` | — | — |
| Status pill | header + dl | `/tickets/:id` | `tickets.status` | — | — |
| Company + Tier | dl | `/tickets/:id` | `company_master.name`; `tickets.company_tier` | — | — |
| Plant | dl | `/tickets/:id` | `plants.name` | `formatPlantDisplayName` | — |
| Assigned SE / Overridden / Batch # / Schedule # | dl | `/tickets/:id` | `users.name` via active `batch_assignment_tickets → plant_batch_assignments`; `plant_batch_assignments.batch_id`; `work_schedules.schedule_id` | — | — |
| Inactive for | dl | `/tickets/:id` | `device_states.latest_gps_datetime` + `.sla_bucket` | browser-computed duration | — |
| Created | dl | `/tickets/:id` | `tickets.created_at` | `toLocaleString()` (browser locale/TZ) | — |
| Flags | dl | `/tickets/:id` | as ticket-list flags | — | — |

### Lifecycle tab

| Field | Where | Endpoint | Source | Transform |
|---|---|---|---|---|
| Timeline entries (toState, fromState, actorRole, at) | Timeline | `/tickets/:id` | `ticket_events.to_state/.from_state/.actor_role/.at` | `orderBy at asc`; time via `toLocaleString()` |

### Components tab

| Field | Where | Endpoint | Source | Transform |
|---|---|---|---|---|
| "WAITING_COMPONENT — primary SLA paused since …" | Banner | `/tickets/:id` | `failure_cycles.state`, `failure_cycles.sla_paused_at` | — |
| Component name / status / destination / tracking / rejection reason / age | Cards | `/component-requests/by-ticket/:id` | `component_master.name`, `component_request.status/.delivery_destination/.tracking_ref/.rejection_reason/.created_at` | `ageDays` computed server-side |

### Forms tab

| Field | Where | Endpoint | Source | Transform |
|---|---|---|---|---|
| Root cause category / subcategory / action taken / diagnosis notes / component-unavailable flag / SE id / submitted at | Cards | `GET /tickets/:id/forms` | `troubleshooting_submissions.root_cause_category/.root_cause_subcategory/.action_taken_category/.diagnosis_notes/.component_unavailable/.se_id/.submitted_at` | ordered `submitted_at asc` |

*Not rendered although present in the payload:* `photoRefs`, `presenceSource`, `seGpsLat/Lon`,
`clientSubmissionId`, `actionTakenNotes`, `rootCauseNotes`, `componentUnavailableItem`.

### Verification tab

| Field | Where | Endpoint | Source | Transform |
|---|---|---|---|---|
| Outcome badge | dl | `GET /tickets/:id/verification` | `verification_runs.outcome`, `.pings_received_count` | **derived**: `badge = outcome ?? (1≤pings≤2 ? 'PARTIAL_RECOVERY' : null)` |
| Phase | dl | same | `verification_runs.phase` | — |
| Pings received | dl | same | `verification_runs.pings_received_count` | — |
| Fraud flag + Δ metres | dl | same | `verification_runs.fraud_flag`, `.first_ping_distance_meters` | latest run only (`orderBy started_at desc`) |

### Assignment History tab

| Field | Where | Endpoint | Source | Transform |
|---|---|---|---|---|
| Entries (reasonCode ?? toState, actorRole, actedAsRole, at) | Timeline | `/tickets/:id` | `ticket_events` | **FE filter**: only rows where `actor_role !== null` (i.e. human-actor events) |

**Write actions:** "Manually close Recovery Ticket" (manager roles, RECOVERY work type, non-terminal
status) → `POST /recovery/:id/manual-close` writes `tickets.status/.closure_type/.closure_reason/
.closed_at/.last_state_changed_at`, `ticket_events`, `audit_logs`.

---

# 5. `/schedules` — Batch Schedule (list)

**Endpoint:** `GET /schedules`. Roles ZM/CSM/OH.

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Schedules / Auto-Assigned / Overridden / Tickets(+batches) | Metric strip | `/schedules` | derived | FE counts over the rows; "Auto-Assigned" = `rows.length − overridden` | — |
| Service Engineer (name + id prefix) | Table col | `/schedules` | `engineer_master → users.name`; `work_schedules.se_id` | — | — |
| Zone | Table col | `/schedules` | `zones.name` via `work_schedules.zone_id` | — | — |
| Plan Date | Table col | `/schedules` | `work_schedules.date_from`, `.date_to` | `toISOString().slice(0,10)` (UTC date) | — |
| Plant Stops | Table col | `/schedules` | `COUNT(plant_batch_assignments)` where `status ∈ (AUTO_ASSIGNED, OVERRIDDEN)` | in-memory count | — |
| Tickets | Table col | `/schedules` | `COUNT(batch_assignment_tickets)` where `removed_at IS NULL` | Σ across the schedule's batches | — |
| Status ("Auto-Dispatched" / "ZM Adjusted") | Table col | `/schedules` | `work_schedules.status` | label map: ACTIVE→"Auto-Dispatched", OVERRIDDEN→"ZM Adjusted" | — |
| Row set | — | `/schedules` | `work_schedules.status ∈ LIVE_SCHEDULE_STATUSES` | `LIVE_SCHEDULE_STATUSES` excludes COMPLETED/PARTIAL (`scheduling/schedule-status.ts`) | ZM clamped to own `zone_id` |

**Write actions:** none.

---

# 6. `/schedules/:engineerId` — Schedule Detail (ZM override surface)

**Endpoints:** `GET /schedules/:engineerId`, `GET /schedules/engineers`, `POST /batches/:id/override`.

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| SE name + id prefix | Header | `/schedules/:id` | `engineer_master → users.name` | — | — |
| Date range | Header | `/schedules/:id` | `work_schedules.date_from/.date_to` | UTC date slice | — |
| Schedule status badge | Header | `/schedules/:id` | `work_schedules.status` | — | — |
| Stop N + plant name + AUTO/OVERRIDDEN | Stop card | `/schedules/:id` | `plant_batch_assignments.stop_sequence`, `plants.name`, `plant_batch_assignments.status` | ordered by `stop_sequence asc` | batches filtered to `status ∈ (AUTO_ASSIGNED, OVERRIDDEN)` |
| Device count per stop | Stop card | `/schedules/:id` | `COUNT(batch_assignment_tickets WHERE removed_at IS NULL)` | — | — |
| Per-ticket SLA-bucket badge | Ticket row | `/schedules/:id` | `device_states.sla_bucket` via `tickets.device_id` | ungated leg (`stateByTicket`) | — |
| Per-ticket Company Tier badge | Ticket row | `/schedules/:id` | `tickets.company_tier` | denormalised at ticket creation | — |
| PARTIAL badge | Ticket row | `/schedules/:id` | `verification_runs.outcome = 'PARTIAL_RECOVERY'` (any run for the ticket) | boolean `some()` | — |
| "Why suggested?" chip: companyTier / deviceBucket / companyPriorityRank / clusterMultiplier | Expandable | `/schedules/:id` | `recommendations.company_tier`, `.device_bucket`, `.score_breakdown->>'companyPriorityRank'`, `.score_breakdown->>'clusterMultiplier'` | **latest** recommendation per ticket by `recommendation_id desc` | — |
| ON_SITE conflict banner | Alert | `POST /batches/:id/override` 409 | `soft_states` (type ON_SITE, `resolved_at IS NULL`) | server-side conflict seam | — |

**Write actions (all via `POST /batches/:batchId/override`, mandatory reason):**
REMOVE_TICKET, DEFER_TICKET, REORDER, SWAP_SE, REASSIGN, SPLIT_BATCH → write
`batch_assignment_tickets.removed_at/.deferred_to_date/.sort_order`, `plant_batch_assignments.se_id/
.stop_sequence/.status`, `work_schedules.status/.last_overridden_by/.last_overridden_at`,
`tickets.assignment_state`, `ticket_events`, `audit_logs`, `notifications`.

---

# 7. `/dispatch-runs` — Dispatch Runs list

**Endpoint:** `GET /dispatch-runs` (default limit 30).

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| When | Table col | `/dispatch-runs` | `dispatch_runs.started_at` | `formatDateTime` (browser locale) | — |
| Trigger (Manual/Auto) + actor | Table col | `/dispatch-runs` | `dispatch_runs.trigger`, `.actor_role`, `.actor_user_id → users.name` | — | — |
| Status | Table col | `/dispatch-runs` | `dispatch_runs.status` | — | — |
| Duration | Table col | `/dispatch-runs` | `finished_at − started_at` | ms diff in JS | null while RUNNING |
| Zones | Table col | `/dispatch-runs` | `dispatch_runs.zones` (**or** `1/0` for a ZM) | ZM sees their own `dispatch_run_zones` row only | ZM clamp |
| Batches / Dispatched / Recommended / Unassignable | Table cols | `/dispatch-runs` | `dispatch_runs.batches/.tickets_dispatched/.recommended/.unassignable` — **for a ZM these are replaced by that ZM's `dispatch_run_zones` row values** | conditional per role | ZM clamp |
| Errors | Table col | `/dispatch-runs` | `COUNT(dispatch_run_zones.error IS NOT NULL)` | — | ZM: 1/0 |

**Write actions:** none.

---

# 8. `/dispatch-runs/:runId` — Dispatch Run detail

**Endpoint:** `GET /dispatch-runs/:runId`.

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Status badge / trigger / started / duration / zone-error count | Header | same | `dispatch_runs.*` | — | — |
| Stale-build alert | Alert | same | `dispatch_runs.build_version/.build_fingerprint` vs `runtime_lock.version/.fingerprint` | `staleBuild = build_version < lock.version`; null when either is unstamped | — |
| Zones / Schedules / Batches / Dispatched / Recommended / Unassignable | Metric strip | same | `dispatch_runs.*` (or Σ of the ZM's zone cards) | ZM: sums of the clamped zone rows | ZM clamp |
| Config in effect — Priority weighting bars | Panel | same | `dispatch_runs.config_snapshot.priorityRules[]` (frozen copy of `priority_rule_config`) | bar width = `|weight| / max|weight|`; empty ⇒ "Default weighting (not overridden)" | — |
| Config — Engineer capacity (N active of M, min–max) | Panel | same | `config_snapshot.capacity{seId:{dailyCapacity,isActive}}` (frozen copy of `engineer_master`) | FE min/max over active entries | — |
| Config — Same-plant clustering ×N | Panel | same | `config_snapshot.settings.plant_cluster_multiplier` (from `system_settings`) | fallback text "Default ×1.25 (not overridden)" | — |
| Config — Engineer eligibility | Panel | same | `config_snapshot.settings.eligibility_mode` | rendered raw (`pgi` / `all-deployed`) | — |
| Config — Automatic dispatch On/Off + cron | Panel | same | `config_snapshot.scheduler.businessSweepsEnabled/.dispatchCron` (env, not DB) | `humanizeCron` | — |
| Per-zone card: name, mode, dispatched, batches, unassignable, NO_COVERAGE / ALL_DROPPED | Card grid | same | `dispatch_run_zones.zone_id/.mode/.tickets_dispatched/.batches/.unassignable/.unassignable_reasons` | JSONB `unassignableReasons` read as-is | ZM sees only own zone |

**Write actions:** none.

---

# 9. `/dispatch-runs/:runId/zones/:zoneId` — Zone detail

**Endpoint:** `GET /dispatch-runs/:runId/zones/:zoneId`.

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Zone name, mode, considered/recommended/dispatched/unassignable, weight set | Header | same | `dispatch_run_zones.*` | — | ZM: 403 for another zone |
| Company → Plant tree: Inactive / Total devices | Table | same | `device_states` `COUNT(*)` and `COUNT(*) FILTER (is_inactive)` grouped by `plant_id` | **no deactivated-plant exclusion here** | plants that received a batch in this run |
| Assigned / Unassigned per plant | Table | same | `tickets.assignment_state` `COUNT FILTER` grouped by `plant_id` | counts **all** tickets at the plant, any status/age — not run-scoped | — |
| Batches per plant/company | Table | same | `plant_batch_assignments` where `run_id = :runId` OR (`run_id IS NULL` AND `work_schedules.run_id = :runId`) | grouped in FE | — |
| Batch row: SE, capacity used/cap | Expanded row | same | used = `COUNT(batch_assignment_tickets WHERE removed_at IS NULL)` across **the whole schedule**; cap = `config_snapshot.capacity[seId].dailyCapacity` | whole-day denominator; cap is the frozen value, never today's `engineer_master` | — |
| Batch companyName | Table | same | `tickets → company_master.name` of the batch's tickets | `distinctLabel`: one value, or `"First +N"` when the batch spans companies | — |
| Unassignable table: Device / Plant / Company / Why (NO_COVERAGE\|ALL_DROPPED) / Dropped candidates | Table | same | `dispatch_decision_traces` where `se_id IS NULL`; `trace->>'poolEmptyReason'`, `trace->'dropCounts'` | JSONB read as-is | FE search / reason filter / sort |

**Write actions:** none.

---

# 10. `/batches/:batchId` — Batch Assignment detail

**Endpoints:** `GET /batches/:batchId`; per expanded row `GET /dispatch-runs/:runId/tickets/:ticketId/trace`.

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Device | Table col | `/batches/:id` | `tickets.device_id` | falls back to ticket-id prefix | FE search |
| Vehicle No. | Table col | same | `vehicles.vehicle_no` | — | FE search |
| Device Type | Table col | same | `devices.device_type` (mirrored by master sync from `ap_widgets.tb_vehiclemaster`) | "—" when null | — |
| IMSI No | Table col | same | `devices.imsi_no` | — | — |
| Company | Table col | same | `company_master.name` | — | — |
| Plant | Table col | same | `plants.name` — **batch-level value repeated on every row** | — | — |
| SE | Table col | same | `engineer_master → users.name` — **batch-level, repeated** | — | — |
| Transporter | Table col | same | `vehicles.transporter_id → transporters.name` | — | FE transporter dropdown |
| Inactive Duration | Table col | same | `device_states.latest_gps_datetime` | `formatInactiveDuration` in browser (same helper as the device list) | — |
| Trip Creation Date Time | Table col | same | `device_states.trip_creation_datetime` | `formatDateTimeWithYear`; maintained at ingest, offset 0 (source is UTC) | — |
| Ticket (status badge) | Table col | same | `tickets.status` | — | — |
| Rank / score / recStatus (in payload, not rendered as columns) | — | same | `recommendations.processing_rank`, `.score_breakdown->>'score'`, `.status` | rec looked up by `(runId, ticketId)`; `runId` may be `null` | — |
| Decision trace (expanded): Chosen SE, coverage type, precedence rank, capacity at decision, planner bias, cluster seed, runners-up with verdict + dropReason, dropCounts, poolEmptyReason | Expanded panel | `/dispatch-runs/:runId/tickets/:ticketId/trace` | `dispatch_decision_traces.trace` (JSONB) + `recommendations.score_breakdown/.status`; SE names via `engineer_master → users.name` | rendered in precedence language; numeric score suppressed when `trace.scoreDegenerate` | only when `hasTrace && runId != null` |
| Trace identity strip (Device/Vehicle/Plant/Company/Transporter) | Expanded panel | same | `tickets.device_id`, `vehicles.vehicle_no`, `plants.name`, `company_master.name`, `transporters.name` | — | — |

**Write actions:** none.

---

# 11. `/engineers` — SE Activity

**Endpoints:** `GET /engineers`, `GET /engineers/:seId`, `POST /engineers/:seId/availability`.

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| BUSY / ON_SITE / AVAILABLE / OFFLINE / SHIFT_ENDING counts | Metric cards | `/engineers` | derived | FE tallies `activityStatus` over the rows; **only these 5 of the 9 possible statuses get a card** | — |
| Service Engineer | Table col | `/engineers` | `engineer_master → users.name` | — | — |
| Activity | Table col | `/engineers` | **computed at render time, never stored**: `deriveActivityStatus({availabilityStatus, activeSoftStateTypes, lastActivityAt, shiftEnd, now})` from `se_availability`, `soft_states.type` (`resolved_at IS NULL`), `engineer_master.last_activity_at`, `engineer_master.shift_end` | pure function `soft-state/activity-status.ts` | — |
| Coverage | Table col | `/engineers` | `engineer_master.coverage_type` | — | — |
| Availability | Table col | `/engineers` | `se_availability.status` of the window containing `now`, else `'AVAILABLE'` | `SeAvailabilityService.currentStatusMany` | — |
| Active Tickets | Table col | `/engineers` | `COUNT(batch_assignment_tickets WHERE removed_at IS NULL)` on batches with `status ∈ (AUTO_ASSIGNED, OVERRIDDEN)` and a **live** schedule | field is documented as "OPEN tickets" but the query does not filter `tickets.status` | — |
| Kit OK / Kit short | Table col | `/engineers` | `se_van_stock.qty` vs `common_kit_definition.min_qty` (`active = true`) | `complete = true` when no active kit rows **or** the SE has zero `se_van_stock` rows at all | — |
| Detail: Day Plan status + ticket count | Side panel | `/engineers/:seId` | `work_schedules.status`; Σ live batch tickets | live-schedule filter | — |
| Detail: schedule header, stops, per-ticket device/vehicle/workType/status/slaBucket/company | Side panel | `/engineers/:seId` | `work_schedules`, `plant_batch_assignments`, `batch_assignment_tickets`, `tickets`, `vehicles.vehicle_no`, `device_states.sla_bucket`, `company_master.name` | — | — |
| Detail: Van Stock (component, qty) | Side panel | `/engineers/:seId` | `se_van_stock.qty`, `component_master.name` | — | — |
| Detail: availability rows (status, window, reason, setByRole) | Side panel | `/engineers/:seId` | `se_availability.*` | `orderBy window_start desc take 10` | — |

**Write actions:** Set Availability (ZM/CSM only; **not** OH) → `POST /engineers/:seId/availability`
writes `se_availability` (status/window/reason/set_by_role).

---

# 12. `/engineers/manage` — SE Management Directory

**Endpoints:** `GET /engineers/directory`, `GET /org/zones`, `GET /org/plants?zoneId=`,
`POST /engineers`, `PATCH /engineers/:seId`, `POST /engineers/:seId/status`,
`POST /engineers/:seId/coverage`, `DELETE /engineers/:seId/coverage/:coverageId`.

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Name / Phone / Email / Address | Editable table cells | `/engineers/directory` | `users.name/.phone/.email`; `engineer_master.address` | click-to-edit | zone filter (FE); ZM clamped server-side |
| Zone | Editable select cell | `/engineers/directory` | `engineer_master.zone_id → zones.name` | read-only for a ZM | — |
| Coverage type | Editable select cell | same | `engineer_master.coverage_type` | options limited to DEDICATED / MULTI_PLANT (FLOATING uses the Territory page) | — |
| Daily capacity | Editable cell | same | `engineer_master.daily_capacity` | — | — |
| Active toggle | Toggle cell | same | `engineer_master.is_active` | — | — |
| Mapped plants | Side panel | same | `se_coverage.plant_id → plants.name`, `se_coverage.id` | — | — |
| Companies column | Table col | same | — | **Always "—"** — SE→company is not modelled (documented in the page header comment) | — |

**Write actions:** create SE → `users` + `engineer_master` (+ `audit_logs` SE_CREATED);
update → `users`/`engineer_master`; status → `engineer_master.is_active`;
coverage add/remove → `se_coverage`.

---

# 13. `/engineers/planner` — SE Planner grid

**Endpoints:** `GET /planner?dateFrom&dateTo`, `GET /planner/plants`, `GET /schedules/engineers`,
`GET /schedules`, `POST /planner`, `DELETE /planner/:id`.

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Row = SE | Grid | `/schedules/engineers` | `engineer_master.engineer_id → users.name`, `is_active = true` | — | ZM clamped |
| Columns = 7 days | Grid | — | — | **client-local** `new Date()` + 6 days, formatted with local getFullYear/Month/Date (not UTC) | fixed 7-day window |
| Cell chips = planned plant visits | Grid | `/planner` | `se_planner.se_id/.plant_id/.planned_date`; plant name from `/planner/plants` (`plants.name`) | `planned_date` serialised `toISOString().slice(0,10)` (**UTC**) while the columns are local dates | `dateFrom`/`dateTo` |
| Coverage / schedule context column | Grid | `/schedules` | `work_schedules` rows | — | — |
| Metric strip | Header | derived | — | FE counts | — |

**Write actions:** `POST /planner` (upsert `se_planner` on `(se_id, plant_id, planned_date)`),
`DELETE /planner/:id`.

---

# 14. `/reports` — Reports landing

**Endpoints:** `GET /reports/fleet-uptime?groupBy=zone` (×1 + ×6 for the trend fan-out),
`GET /dashboard/zone-overview`, `GET /reports/soft-inactive-trend?days=14`,
`GET /reports/work-type-mix`, `GET /reports/verification-outcomes`.

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Fleet Uptime | KPI | `/reports/fleet-uptime` | `device_downtime_summary_monthly.downtime_seconds/.window_seconds` where `eligible=true` | `(1 − Σd/Σw)×100` | current UTC month |
| Total Inactive | KPI | `/dashboard/zone-overview` | `device_states.is_inactive` | Σ | — |
| Critical+ | KPI | `/dashboard/zone-overview` | `device_states.sla_bucket` | CRITICAL and worse (5 buckets) — **different definition from the dashboard "Critical Devices" KPI** | — |
| Eligible Devices | KPI | `/reports/fleet-uptime` | `COUNT(*)` of `device_downtime_summary_monthly` rows with `eligible=true` | i.e. device×month rows, not live devices | — |
| Auto-Recovered / SE-Repaired | KPI | `/reports/fleet-uptime` | `Σ auto_recovery_closures` / `Σ se_repaired_closures` | — | — |
| Inactivity by SLA bucket (bars) | Chart | `/dashboard/zone-overview` | `device_states.sla_bucket` | Σ across zones per bucket, zero bars dropped | — |
| Fleet Uptime % — last 6 months | Chart | 6 × `/reports/fleet-uptime?month=` | as above | **client-side fan-out** of `recentMonths(6)` computed from browser `new Date()`; failed months silently dropped | — |
| Soft-Inactive count trend | Chart | `/reports/soft-inactive-trend?days=14` | `soft_inactive_count_history.soft_inactive_count`, `.captured_at` | summed across zones per `captured_at`; label = `capturedAt.slice(5,10)` | OH only — other roles get a "Available to Operations Head" panel (403 → gated) |
| Fleet Uptime % by zone | Chart | `/reports/fleet-uptime?groupBy=zone` | per-zone rows | — | — |
| Work type mix | Chart | `/reports/work-type-mix` | `COUNT(tickets) GROUP BY work_type` | `pct = count/total×100`; zero-filled over the 3 work types | default window = trailing 30 days on `tickets.created_at`; ZM zone-pinned |
| Verification outcomes | Chart | `/reports/verification-outcomes` | `COUNT(verification_runs) GROUP BY COALESCE(outcome,'PENDING')`; `COUNT FILTER (fraud_flag)` | zero-filled over 6 outcome keys; zero rows dropped in the FE | default trailing 30 days on `verification_runs.started_at` |
| Zone breakdown table (Zone / Inactive w/ work / Critical+ / Fleet Uptime) | Table | `/dashboard/zone-overview` + `/reports/fleet-uptime` | as above | uptime joined **by zone id, falling back to zone name** | — |
| "Data as of \<ts\>" | Meta strip | — | — | **browser `new Date()` at the moment the fleet-uptime fetch resolved** — not a data watermark | — |
| Scope chips | Meta strip | `/dashboard/zone-overview` | `zones.name` | only zones that have ≥1 inactive device | — |

**Write actions:** "Export" → client-side CSV of the zone-breakdown table only.

---

# 15. `/reports/device` — Device Detail

**Endpoints:** `GET /devices` (paged), `GET /devices/filter-options`, `GET /devices/:id/cycles`,
`GET /devices/:id/downtime-trend`, `PATCH /devices/:id/deal-type`, plus `AssignSePanel`
(`GET /engineers`, `POST /schedules/assign-plants`).

| Field shown | Where | API endpoint | Source table.column | Transform | Filters/params |
|---|---|---|---|---|---|
| Device ID | Table col | `GET /devices` | `device_states.device_id` | — | search, sort `DEVICE_ID` |
| Vehicle Number | Table col | same | `vehicles.vehicle_no` via `device_states.vehicle_id` | — | search |
| Device Type | Table col | same | `devices.device_type` | "—" when null | — |
| IMSI No | Table col | same | `devices.imsi_no` | — | — |
| Company Name | Table col | same | `company_master.name` via `device_states.company_id` | — | `companyId` |
| Plant Name | Table col | same | `plants.name` via `device_states.plant_id` | `formatPlantDisplayName` | `plantId` |
| Zone | Table col | same | `zones.name` via `plants.zone_id` | — | `zoneId` or literal `UNZONED` (`p.zone_id IS NULL`) |
| Inactive Duration | Table col | same | `device_states.latest_gps_datetime` | **browser** `now − latest_gps_datetime`, 2-unit format | sort `LONGEST_INACTIVE` / `NEWEST_ACTIVITY` |
| Trip Creation Date Time | Table col | same | `device_states.trip_creation_datetime` | `formatDateTimeWithYear` | — |
| SLA Bucket (badge, or "Active") | Table col | same | `device_states.sla_bucket` | null ⇒ "Active" | `bucket`, `criticalPlus` |
| Assignment (badge + SE name + ticket link) | Table col | same | `tickets.assignment_state`/`.status`/`.ticket_id` from a LATERAL "latest non-terminal ticket" (`created_at desc`, excluding 7 terminal statuses); SE via `plant_batch_assignments → users.name` | — | — |
| "Showing A–B of N" | Toolbar | same | `COUNT(*)` over the same filters | `limit` default 100, hard cap 200; offset = page×100 | pager |
| Device stats: Lifetime Cycles / Downtime Hrs / Avg Recovery Hrs / Longest Episode Hrs / Repeat Failures / Component-Related Hrs | Detail cards | `GET /devices/:id/downtime-trend` | `device_downtime_summary_monthly.cycle_count/.downtime_seconds/.recover_seconds_sum/.recovered_cycles/.longest_episode_seconds/.repeat_failure_count/.component_downtime_seconds` | seconds→hours ÷3600 rounded 2 dp; avg = `ΣrecoverSeconds / Σ recoveredCycles`; Component-Related Hrs = Σ of the **monthly** rows (FE) | — |
| Current failure cycle: SLA bucket reached / Root cause / Repeat failure / Component-related / Verification | Detail card | `GET /devices/:id/cycles` | `failure_cycles.opened_at/.closed_at/.repeat_failure/.sla_pause_reason`; `troubleshooting_submissions.root_cause_category` (latest); `verification_runs.outcome` (first non-null); `component_request` existence | `slaBucketReached = classifySlaBucket(durationSeconds/3600)` computed **on read** from `opened_at`→`closed_at ?? now`; "current" = first cycle with `closed_at === null`, else the newest | — |
| Lifetime downtime trend (bars / summary table) | Chart | `GET /devices/:id/downtime-trend` | `device_downtime_summary_monthly.month/.downtime_seconds/.cycle_count` | — | — |
| Deal type ("Deal: Recurring/One-time") | Detail header | `GET /devices` row | `devices.deal_type` | humanized | — |

**Write actions:**
- `PATCH /devices/:id/deal-type` (OH only) → `devices.deal_type` + `audit_logs`
  (`DEVICE_DEAL_TYPE_TAG`).
- `AssignSePanel` → `POST /schedules/assign-plants` → creates/extends `work_schedules`,
  `plant_batch_assignments`, `batch_assignment_tickets`; flips `tickets.assignment_state`; writes
  `ticket_events`, `audit_logs`, `notifications`.

**Untraceable:** none; note `zoneName` is `null` for UNZONED-plant devices even though the filter
offers the literal `UNZONED`.

---

# 16. `/reports/fleet` — Fleet Directory

**Endpoint:** `GET /dashboard/fleet-directory`.

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Companies / Plants / Devices | Metric strip | same | derived | `dir.companies.length`, `dir.plants.length`, `Σ plants[].deviceCount` — **FE-side sums of the returned rows** | — |
| Company: name, `#id`, Tier, Plants, Devices | Companies tab | same | `company_master.name/.company_id/.company_tier`; `COUNT(DISTINCT device_states.plant_id)`; `COUNT(*)` of device_states | grouped by company; deactivated plants excluded; ZM zone-clamped | FE search |
| Plant: name, `#id`, Company, Zone, Devices | Plants tab | same | `plants.plant_id/.name`; `company_master.name` (LEFT JOIN on `device_states.company_id`); `zones.name`; `COUNT(*)` | grouped by `(plant, company, zone)` — a plant serving 2 companies yields 2 rows | FE search + `?companyId=` filter |

**Note:** the "Devices" metric sums the **plants** tab, which double-counts nothing but is a
different population from `fleet-summary.devices` (which filters `is_departed = false`); the
directory's `deviceCount` has **no `is_departed` filter**.

**Write actions:** none.

---

# 17. `/reports/root-cause` — Root-Cause Analytics

**Endpoint:** `GET /reports/root-cause` (no query params sent by the page).

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Total Submissions | KPI | same | `Σ root_cause_summary_monthly.submission_count` | — | month range defaults to **the current month only** (`fromMonth = toMonth = now`) |
| Distinct Causes | KPI | same | derived | FE counts slices with `count > 0` | — |
| Top Cause + % | KPI | same | derived | FE max by count | — |
| Distribution bars (category → %) | Chart | same | `root_cause_summary_monthly.root_cause_category`, `.submission_count` | `pct = count/total×100` 2 dp; zero-filled over all 10 categories in schema order | ZM pinned to own zone; company/plant/deviceType/seId filters supported by the API but **not sent by this page** |
| Breakdown table (Root cause / Tickets / Share) | Table | same | as above | `humanize()` on the enum | — |

**Write actions:** none. (`POST /reports/root-cause/recompute` exists, OH-only, not wired to any UI.)

---

# 18. `/reports/system-efficiency` — System Efficiency

**Endpoint:** `GET /reports/efficiency` (no params sent).

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Auto-Dispatch % | KPI | same | `Σ system_efficiency_summary_daily.auto_assignments`, `.manual_assignments` | `auto/(auto+manual)×100` | day range defaults to **today only** (`from = to = today UTC`) |
| Override Rate % | KPI | same | `Σ overrides` / (auto+manual) | — | — |
| First-Time Fix % | KPI | same | `Σ first_time_fixes / Σ cycles_resolved` | — | — |
| Auto-Recovery % | KPI | same | `Σ auto_recoveries / (cycles_resolved + auto_recoveries)` | — | — |
| Failed Verification % | KPI | same | `Σ failed_verifications / (verified_cycles + failed_verifications)` | — | — |
| Auto-Escalations | KPI | same | `Σ auto_escalations` | — | — |
| Auto-dispatch % by zone (bars) | Chart | same | grouped by `zone_id` | — | — |
| "SE active load vs capacity" | Chart | **none** | — | **HARDCODED empty state** — "no aggregation source in this endpoint" | — |
| Efficiency by zone table (Zone / Tickets / Auto-dispatch / Override / First-time fix) | Table | same | `Σ tickets_created` etc. per `zone_id`; `zones.name` | — | ZM pinned |

Additional metrics computed by the backend but **not rendered anywhere**: `slaCompliancePct`,
`totalDowntimeSeconds`, `avgDowntimeSeconds`, and all seven `avg*Seconds` stage times.

**Write actions:** none.

---

# 19. `/reports/zm-scorecard` — ZM Performance Scorecard (OH only)

**Endpoint:** `GET /reports/zm-scorecard` (no params sent).

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Top performer card (name, zone, zone Fleet-Uptime %, override rate %) | Card | same | derived | FE max by `zoneSlaCompliancePct` | — |
| Zonal Manager / Zone | Table | same | `zm_performance_summary_monthly.zm_id → users.name`; `zones.name` | — | month range defaults to **current month only** |
| Overrides | Table | same | `Σ zm_performance_summary_monthly.overrides_total` | — | — |
| Override rate % | Table | same | `Σ overrides_total / Σ auto_assigned_count` | 0 when denominator 0 | — |
| Manual assigns | Table | same | `Σ manual_assignments` | — | — |
| Zone SLA % | Table | same | `Σ zone_downtime_seconds`, `Σ zone_window_seconds` | `(1 − d/w)×100`; **`w=0 ⇒ 100%`** | — |

Payload fields not rendered: `removals`, `deferrals`, `reorders`, `swaps`, `reassignments`,
`splitBatches`, `overrideAfterOnsite`, `autoAssigned`, and the whole `trend[]` series.

**Write actions:** none.

---

# 20. `/reports/csm-approval-share` — CSM Backup Share (OH only)

**Endpoint:** `GET /reports/csm-approval-share` (no `month` param sent → defaults server-side).

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| CSM-acted actions / Total acted actions / Overall CSM share / Zones tracked | Metric strip | same | derived | FE sums; `overallShare = totalCsm/totalActed×100` rounded to **integer** | — |
| CSM share by zone (bars) | Chart | same | `audit_logs.acting_zone`, `.acted_as_role`, `.created_at` | `groupBy(actingZone, actedAsRole)` counting all rows with `acting_zone IS NOT NULL` in the period; `sharePct = csm/total×100` to 1 dp | period = the controller's default (current calendar month) |
| Table: Zone / CSM-acted / Total acted / CSM share | Table | same | as above | zone rendered as **"Zone \<id\>"** — the zone **name is never resolved** | — |

**Write actions:** none.

---

# 21. `/plant-deactivations` — Plant Deactivations (OH only)

**Endpoints:** `GET /plants/deactivations`, `GET /org/plants`, `POST /plants/:id/deactivate`,
`POST /plants/:id/reactivate`.

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Company | Table col | `/plants/deactivations` | correlated subquery: the modal company over `device_states → company_master.name` for that plant (`ORDER BY COUNT(*) DESC LIMIT 1`) | "most common company at the plant", not an FK | — |
| Plant | Table col | same | `plants.name` | — | — |
| source_plant_id | Table col | same | `plants.source_plant_id` | — | — |
| Zone | Table col | same | `zones.name` via `plants.zone_id` | "Unzoned" when null | — |
| Devices | Table col | same | `COUNT(*) FROM device_states WHERE plant_id = …` | **no `is_departed` / eligibility filter** | — |
| Reason | Table col | same | `plant_deactivations.reason` | — | — |
| Deactivated by / on | Table col | same | `plant_deactivations.deactivated_by` (uuid, sliced to 8 chars — **name never resolved**), `.deactivated_at` | `toLocaleDateString()` | — |
| Row set | — | same | `plant_deactivations WHERE reactivated_at IS NULL` | — | — |

**Write actions:**
- Deactivate (mandatory reason) → `plant_deactivations` insert; cancels open tickets:
  `tickets.status='CLOSED'`, `.closure_type='OPERATIONS_HEAD_OVERRIDE_CLOSE'`,
  `.closure_reason='PLANT_DEACTIVATED: …'`, `.closed_at`, `ticket_events`,
  `failure_cycles.state='FAILED'`, `device_states.has_open_failure_cycle=false`, `audit_logs`.
- Reactivate → `plant_deactivations.reactivated_at/.reactivated_by/.reactivation_reason`, `audit_logs`.

---

# 22. `/plant-zones` — Plant Zones (OH only)

**Endpoints:** `GET /org/plant-zone-overrides`, `GET /org/plants`, `GET /org/zones`,
`GET /org/plant-zone-overrides/:sourcePlantId/impact`, `PUT /org/plant-zone-overrides`,
`DELETE /org/plant-zone-overrides/:sourcePlantId`, `POST /org/zone-mappings/reapply`.

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Plant | Table col | `/org/plants` | `plants.name` | — | FE "UNZONED only" toggle |
| source_plant_id | Table col | same | `plants.source_plant_id` | rows with `source_plant_id = null` are **excluded** from the table | — |
| AutoPlant zone | Table col | same | `plants.source_zone_name` (raw mirror) | — | — |
| FSM zone | Table col | same | `plants.zone_id → zones.name` | literal `UNZONED` renders as a warning badge | — |
| Override ("Pinned to \<zone\>" + reason) | Table col | `/org/plant-zone-overrides` | `plant_zone_overrides.fsm_zone_id → zones.name`, `.reason` | joined in FE by `sourcePlantId` | — |
| Impact dialog: plant name, current zone, device count, open ticket count, dispatched-today count, tier overrides detached/attached | Confirm modal | `/org/plant-zone-overrides/:id/impact` | `device_states` count, `tickets` open count, today's `work_schedules`/batches, `company_tier_overrides` (winning per company×zone) | see `zone-mapping.service.ts` | `targetZoneId` optional |
| Reapply receipt (plantsConsidered / updated / unchanged / landedUnzoned) | Toast/panel | `POST /org/zone-mappings/reapply` | recomputed `plants.zone_id` | — | — |

**Write actions:** `PUT` / `DELETE` on `plant_zone_overrides` (mandatory reason on set; the row is
**upserted**, so the previous zone/reason survive only in `audit_logs`), each chained with
`POST /org/zone-mappings/reapply` which updates `plants.zone_id` in bulk.

---

# 23. `/tier-overrides` — Tier Overrides (ZM own-zone / CSM / OH)

**Endpoints:** `GET /org/tier-overrides?status=ACTIVE`, `GET /org/companies`, `GET /org/zones`,
`GET /org/tiers`, `POST /org/tier-overrides`, `DELETE /org/tier-overrides/:id`.

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Company | Table col | `/org/tier-overrides` | `company_tier_overrides.company_id → company_master.name` | — | ZM clamped to home zone |
| Zone | Table col | same | `.zone_id → zones.name` | — | `zoneId`, `status`, `month` supported; page sends `status=ACTIVE` only |
| Override tier + "Winning" badge | Table col | same | `.tier`; `isWinning` from `resolveActiveOverrides()` — newest ACTIVE **and unexpired** per (company, zone) | computed against the whole table, not just the shown rows | — |
| Reason | Table col | same | `.reason` | — | — |
| Expires | Table col | same | `.expires_at` | `toISOString().slice(0,10)` (UTC date) | — |
| Created by | Table col | same | `.created_by` — raw uuid, **name never resolved** | — | — |
| Scope note | Static paragraph | — | — | **HARDCODED copy** (`SCOPE_COPY`) | — |

**Write actions:** create (validates tier ∈ enum, reason ≥10 chars, `expires_at` in (now, now+2mo])
→ `company_tier_overrides` + `audit_logs` (`TIER_OVERRIDE_SET`); cancel → `.status='CANCELLED'`,
`.cancelled_by/.cancelled_at` + `audit_logs`.

---

# 24. `/build-health` — Build Health (OH only)

**Endpoint:** `GET /integration/health`.

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Runtime lock v\<n\> (\<fingerprint\>) | Card | same | `runtime_lock.version`, `.fingerprint` (raw SQL — not a Prisma model) | — | `id = 1` |
| Master sync build badge | Card | same | newest `master_sync_runs.build_version/.build_fingerprint` (`orderBy run_id desc`) | `staleBuild = build_version < lock.version` | — |
| Snapshot build badge | Card | same | newest `snapshot_runs.build_version/.build_fingerprint` | as above | — |
| Recompute history: Computed At / Eligible / Inactive / Departed / Total / Trigger / Build / Swing | Table | same | `device_state_recomputes.computed_at/.eligible_count/.inactive_count/.departed_count/.total_count/.trigger/.build_version/.build_fingerprint` | `swingPct` = relative eligible delta vs the next-older row; `swing` when `|swingPct| > system_settings.recompute_canary_threshold_pct` (default 5) | last 10 rows, newest first |

**Write actions:** none.

---

# 25. `/exports` — Exports (OH only)

**Endpoints:** `GET /exports/entity-mapping/summary`, `GET /exports/entity-mapping` (streamed CSV).

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| "\<N\> devices · data as of \<ts\>" | Card hint | `/exports/entity-mapping/summary` | `COUNT(*)` and `MAX(device_states.computed_at)` | — | none |
| "Last downloaded \<ts\>" | Card | — | — | **browser clock**, session-local only | — |

**CSV columns** (`GET /exports/entity-mapping`, keyset-paged 2000 rows by `device_id`):

| CSV column | Source table.column | Transform |
|---|---|---|
| device_id | `device_states.device_id` | — |
| vehicle_no | `vehicles.vehicle_no` | — |
| company | `company_master.name` | via `device_states.company_id` |
| plant_name | `plants.name` | — |
| source_plant_id | `plants.source_plant_id` | — |
| zone | `zones.name` | via `plants.zone_id` |
| zone_source | derived | `unzoned` when plant/zone null; `override` when a `plant_zone_overrides` row exists; else `mapped` |
| transporter | `transporters.name` | via `device_states.transporter_id` |
| deployment_status | `vehicles.status` | raw AutoPlant mirror |
| plant_fsm_status | derived | `deactivated` when an active `plant_deactivations` row exists, else `active` |
| latest_gps_datetime | `device_states.latest_gps_datetime` | `toISOString()` |
| inactive_hours | `device_states.inactivity_hours` | Decimal `toString()` |
| sla_bucket | `device_states.sla_bucket` | — |
| eligible_for_uptime | `device_states.eligible_for_uptime` | — |
| open_ticket_count | `COUNT(tickets)` where `status NOT IN (CLOSED, CLOSED_AUTO_RECOVERY, CLOSED_NON_OPERATIONAL, FAILED_RECOVERY)` | **note: `FAILED_VERIFICATION` and `FAILED_ACTIVATION` count as "open" here, unlike the device-list LATERAL** |

**Write actions:** none (read-only export).

---

# 26. `/leave-requests` — Leave Requests

**Endpoints:** `GET /leave-requests`, `POST /leave-requests/:id/approve`, `POST /leave-requests/:id/reject`.

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Engineer | Table col | same | `leave_requests.se_id → users.name` | — | zone-scoped server-side |
| Type | Table col | same | `leave_requests.type` | — | — |
| Window | Table col | same | `.window_start`, `.window_end` | `iso.slice(0,10)` — **string slice of the UTC ISO**, not a locale date | — |
| Reason | Table col | same | `.reason` | — | — |
| Status (+ decision reason on REJECTED) | Table col | same | `.status`, `.decision_reason` | — | — |

**Write actions:** approve → `leave_requests.status='APPROVED'` **and writes an `se_availability`
window** (linked via `leave_requests.availability_id`); reject (mandatory reason) →
`.status='REJECTED'`, `.decision_reason`. Both audited.

---

# 27. `/cross-zone` — Cross-Zone Escalations

**Endpoints:** `GET /cross-zone`, `POST /cross-zone/sweep`, `/:id/approve`, `/:id/deny`, `/:id/defer`.

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Auto-Escalations / Manual Flags counts | Metric cards | `/cross-zone` | `cross_zone_escalations.escalation_type` | FE split | — |
| Ticket | Table col | same | `.ticket_id` | `.slice(0,8)` | — |
| Company (+ tier badge) | Table col | same | `.company_id` (**raw id, name never resolved**), `.company_tier` | — | — |
| Bucket | Table col | same | `.trigger_bucket` | `SLABadge` | — |
| Status | Table col | same | `.status` | — | — |
| Age | Table col | same | `.created_at` | browser `floor((now−createdAt)/86400000)` | — |
| Section split | Two tables | same | `.escalation_type ∈ {AUTO_PLATINUM, MANUAL_FLAG}` | FE filter | scope from `listForScope` (per SYSTEM-STATE §3h, DENIED AUTO rows are omitted — open issue #93) |

**Write actions:** sweep → creates `cross_zone_escalations` rows (+ audit + notifications);
approve → `.status`, `.target_zone_id`, `.assigned_se_id` **and** a cross-zone formal assignment via
the override engine; deny → `.status`, `.decision_reason`; defer → `.status`, `.review_date`,
`.decision_reason`. Approve/Deny/Defer collect their inputs via `window.prompt`.

---

# 28. `/install` — Create Install Ticket

**Endpoints:** `GET /org/plants?zoneId=`, `GET /org/companies`, `POST /install`, `POST /install/upload`.

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Plant picker | Form | `/org/plants` | `plants.plant_id/.name` | — | `zoneId` = the ZM's own zone; OH/CSM unscoped |
| Company picker | Form | `/org/companies` | `company_master.company_id/.name` | — | — |
| Created ticket id | Result | `POST /install` | `tickets.ticket_id` | — | — |
| CSV row errors (line, code, field) | Result | `POST /install/upload` | — | backend validation codes mapped to copy by `ERROR_MESSAGE` | — |
| Batch id + count | Result | `POST /install/upload` | `tickets.install_batch_id` | — | — |

**Write actions:** creates `tickets` (work_type INSTALL) with `install_trigger_source`, `created_by`,
`created_by_role`, `install_batch_id`; `ticket_events`; `audit_logs`.

**Note:** these two endpoints are the only place `/org/plants` and `/org/companies` are called by a
non-OH role — both controllers are `@Roles('OPERATIONS_HEAD')`, so for a ZM/CSM the pickers will be
empty. Flagged for the next phase; not verified here.

---

# 29. `/intraday` — Intra-day Queue

**Endpoint:** `GET /intraday-updates`.

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| ADD / REMOVE / REORDER counts | Metric cards | same | derived | FE tallies | — |
| Event label | Table col | same | `audit_logs.action = 'MANUAL_ZM_UPDATE'` → `metadata.updateType` | **the queue is a view over `audit_logs`, not a model** (2026-06-25 decision) | zone-scoped server-side |
| Ticket | Table col | same | `audit_logs` metadata `ticketId` | `.slice(0,8)`; nullable | — |
| SE | Table col | same | metadata `seId` | `.slice(0,8)` | — |
| SE Acceptance | Table col | **none** | — | **HARDCODED "No acceptance required"** for every row | — |
| By | Table col | same | `audit_logs.actor_id` | `.slice(0,8)` — **name never resolved** | — |
| At | Table col | same | `audit_logs.created_at` | `iso.slice(0,16).replace('T',' ')` — **raw UTC string, no locale conversion** | — |

**Write actions:** none on this page (the ADD/REMOVE/REORDER writes live on the Schedule Detail page
and `POST /intraday-updates/add|remove|reorder`). Issue-29 CRITICAL insertions
(`intraday_insertions`) are **not** rendered here despite the page copy claiming they appear.

---

# 30. `/readiness/vehicle-unavailability` — Vehicle Unavailability Review

**Endpoints:** `GET /vehicle-unavailability`, `POST /:id/confirm-date`, `POST /:id/resume-sla`.

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Report id | Table col | same | `vehicle_unavailability_reports.id` | `.slice(0,8)` | — |
| Ticket | Table col | same | `.ticket_id` | `.slice(0,8)` | — |
| Vehicle & Plant | Table col | same | `tickets → plants.name` | `PlantName` | — |
| Reason (+ "transporter contacted") | Table col | same | `.reason_code`, `.transporter_contacted` | label map | — |
| Filed by | Table col | same | `.se_id` | `.slice(0,8)` — name not resolved | — |
| Expected date | Table col | same | `.expected_from` | `iso.slice(0,10)` | — |
| Primary SLA clock | Table col | same | derived from `failure_cycles.opened_at`, `.sla_accumulated_pause_seconds`, `.sla_paused`, `.sla_paused_at` | `primary = max(0, secondary − accumulatedPause − currentPause)` | manager-only surface |
| Secondary SLA clock (never pauses) | Table col | same | `failure_cycles.opened_at` | `secondary = floor((now − opened_at)/1000)` — server `now` | — |
| Paused flag | Table col | same | `failure_cycles.sla_paused` | — | — |
| Row set | — | same | `.status = 'OPEN'` | ZM clamped via `tickets → plants.zone_id` | — |

**Write actions:** confirm-date → `.expected_from`; resume-sla → clears the pause on
`failure_cycles` (`sla_paused=false`, `sla_pause_reason=null`, `sla_paused_at=null`, adds to
`sla_accumulated_pause_seconds`) and resolves the report.

---

# 31. `/readiness/non-operational` — Non-Operational dual-confirmation queue

**Endpoints:** `GET /non-op/queue`, `POST /non-op`, `POST /non-op/:id/confirm`,
`POST /non-op/:id/override-confirm`, `GET /devices/:deviceId` (deal-type lookup in the Mark modal).

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Device | Table col | `/non-op/queue` | `non_operational_markings.device_id` | — | — |
| Reason | Table col | same | `.reason_code` | raw enum | — |
| Deal Type | Table col | same | `.deal_type_at_marking` (snapshot at marking time, not live `devices.deal_type`) | — | — |
| State (+ recovery ticket id) | Table col | same | `.state`, `.recovery_ticket_id` | label map; ticket id `.slice(0,8)` | rows where `state ∈ QUEUE_STATES` |
| Awaiting (Nd) | Table col | same | `.awaiting_since` | `floor((now − awaiting_since)/86400000)` server-side; colour thresholds 3 d / 7 d are FE-only | ordered `awaiting_since asc` |
| Row set | — | same | — | **not zone-scoped** — `NonOperationalService.queue()` takes no scope argument | — |

**Write actions:** request marking → `non_operational_markings` insert (+ customer token);
confirm (manager leg) → `.state` transition + on CONFIRMED may create a RECOVERY `tickets` row for a
RECURRING device with a retrieval reason; override-confirm (OH, mandatory reason) → same, audited.

---

# 32. `/readiness/recovery-decisions` — Recovery ZM Decision Queue

**Endpoint:** `GET /recovery/zm-queue`.

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Awaiting Decision | Metric card | same | derived | `rows.length` | — |
| Ticket | Table col | same | `tickets.ticket_id` | `.slice(0,8)` | — |
| Device | Table col | same | `tickets.device_id` | — | — |
| Unable reason | Table col | same | `tickets.unable_to_collect_reason` | — | — |
| Row set | — | same | `work_type='RECOVERY' AND unable_to_collect_reason IS NOT NULL AND status NOT IN (CLOSED, FAILED_RECOVERY)` | ordered `unable_to_collect_at asc` | **not zone-scoped** — `zmDecisionQueue()` has no scope argument |

**Write actions:** Reschedule (`window.prompt` for SE id) → `POST /recovery/:id/reschedule`;
Close FAILED_RECOVERY (`window.prompt` reason) → `POST /recovery/:id/close-failed`;
Escalate to OH → `POST /recovery/:id/escalate`. All write `tickets.status/.closure_type/
.closure_reason/.last_state_changed_at`, `ticket_events`, `audit_logs`.

---

# 33. `/component-blocked` — Component-Blocked Queue

**Endpoint:** `GET /component-blocked`.

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Blocked Tickets | Metric | same | derived | `rows.length` | — |
| Warehouse Overdue | Metric | same | derived | count of `warehouseOverdue` | — |
| Engineers Affected | Metric | same | derived | distinct `se_id` | — |
| Oldest (Nd) | Metric | same | derived | max `ageDays` | — |
| Company / Zone | Table cols | same | `tickets → company_master.name`, `tickets → plants → zones.name` | — | — |
| Engineer | Table col | same | `component_blocked_queue.se_id` | raw uuid | — |
| Missing parts | Table col | same | `component_blocked_queue.missing_components` (JSONB `[{componentId,name,shortBy}]`) | joined `name (×shortBy)` | — |
| Warehouse (badge) | Table col | same | `.wm_action_status`; `warehouseOverdue = age > 7 d AND wm_action_status='PENDING'` | — | — |
| Age | Table col | same | `.blocked_at` | `floor(days)` server-side | — |
| Row set | — | same | `resolved_at IS NULL` | ZM clamped via `tickets → plants.zone_id` | — |

**Write actions:** none (read-only by design).

---

# 34/35. `/warehouse/requests` and `/component-requests` — Component Requests

Same component; `readOnly` prop switches the endpoint and hides actions.
**Endpoints:** `GET /warehouse/requests` (WM) or `GET /component-requests` (managers, oversight);
`POST /warehouse/requests/:id/approve|ship|reject`.

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| REQUESTED / APPROVED / SHIPPED counts | Metric cards | either | derived | FE tallies | — |
| Request | Table col | either | `component_request.request_id` | `.slice(0,8)` | — |
| Company / Zone | Table cols | either | `tickets → company_master.name`; `tickets → plants → zones.name` | — | oversight is ZM-zone-scoped; the WM queue is **not** zone-scoped |
| Component | Table col | either | `component_master.name` via `.component_id` | — | — |
| Requested by | Table col | either | `.se_id` | raw uuid | — |
| Ticket | Table col | either | `.ticket_id` | `.slice(0,8)`; links `/tickets/:id?tab=Components` | — |
| Status | Table col | either | `.status` | — | — |
| Age | Table col | either | `.created_at` | `floor((now−created_at)/86400000)` server-side | — |
| Row set | — | WM: `status ∈ (REQUESTED, APPROVED, SHIPPED)`; oversight: **all statuses** | — | — | — |

**Write actions (WM only):** approve → `.status='APPROVED'`, `.approved_at`, `.wm_actor_id`;
ship → `.status='SHIPPED'`, `.shipped_at`, `.tracking_ref`, `.delivery_destination`;
reject → `.status='REJECTED'`, `.rejected_at`, `.rejection_reason`. Each + one `audit_logs` row.

---

# 36. `/warehouse/recovery-receipt` — Awaiting Warehouse Receipt (WM)

**Endpoints:** `GET /recovery/awaiting-receipt`, `POST /recovery/:id/receipt`.

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Awaiting Receipt | Metric | same | derived | `rows.length` | — |
| Ticket / Device | Table cols | same | `tickets.ticket_id`, `.device_id` | — | — |
| Confirmed serial | Table col | same | `tickets.collected_device_serial` | — | — |
| Condition notes | Table col | same | `tickets.collection_condition_notes` | — | — |
| Status | Table col | same | `tickets.status` | — | — |
| Row set | — | same | `work_type='RECOVERY' AND status='COLLECTED'`, `orderBy last_state_changed_at asc` | **not zone-scoped** | — |

**Write actions:** Confirm Receipt → `tickets.status`, `.closure_type='AUTO_CLOSED_ON_WAREHOUSE_RECEIPT'`,
`.closed_at`; `ticket_events`; `audit_logs`.

---

# 37. `/warehouse/shadow-use` — Shadow Use Queue (WM)

**Endpoints:** `GET /warehouse/shadow-use`, `POST /:id/reconcile`, `POST /:id/dispute`.

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Unreconciled | Metric | same | derived | `rows.length` | — |
| Ticket | Table col | same | `inventory_transactions.ticket_id` | `.slice(0,8)` | — |
| Component | Table col | same | `component_master.name` | — | — |
| Qty | Table col | same | `.qty` | — | — |
| Engineer | Table col | same | `.se_id` | raw uuid | — |
| Company | Table col | same | `tickets → company_master.name` | — | — |
| Age | Table col | same | `.created_at` | `floor(days)` server-side | — |
| Row set | — | same | `status = 'SHADOW_USE'`, `orderBy created_at desc` | **not zone-scoped** | — |

**Write actions:** reconcile → `.status='RECONCILED'`, `.reconciled_by` + `audit_logs`;
dispute (mandatory reason) → `.status='DISPUTED'`, `.reconciled_by`, `.reason`, a **no-transition**
`ticket_events` row (`from=to=current status`, `reason_code='INVENTORY_DISPUTE'`), and `audit_logs`.

---

# 38. `/verification` — GPS Verification Review

**Endpoints:** `GET /verification/review`, `POST /verification/:ticketId/escalate`,
`POST /verification/:ticketId/mark-auto-recovery`.

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| In Review / Partial Recovery / Failed / Closed-Auto | Metric strip | same | derived | FE tallies over `rowType` **of the currently-loaded rows** | — |
| Verification outcomes donut | Chart | same | derived | same FE tallies | — |
| Ticket / Device | Rows | same | `verification_runs.ticket_id`, `.device_id` | — | — |
| Company / Zone | Rows | same | `tickets → company_master.name`; `tickets → plants → zones.name` | — | ZM pinned; OH/CSM may pass `zoneId` |
| Outcome / rowType | Rows | same | `.outcome`, `.fraud_flag`, `.pings_received_count` | `rowTypeFor()`: CLOSED / CLOSED_AUTO_RECOVERY / FAILED_FRAUD (failed+fraud) / FAILED_NO_PINGS / PARTIAL_RECOVERY (no outcome AND 1–2 pings) / PENDING | filter `outcome` |
| Pings received | Rows | same | `.pings_received_count` | — | — |
| Fraud Δ metres | Rows | same | `.first_ping_distance_meters` | `Number()` cast from Decimal | — |
| 24 h countdown ("Nh left" / "overdue") | Rows | same | `.started_at` | `partialDeadline = started_at + 24 h` server-side; the countdown itself is browser-clock | only for PARTIAL_RECOVERY rows |
| Default row set | — | same | `outcome IS NULL OR outcome <> 'CLOSED'` | `orderBy started_at desc`; **no LIMIT** | filters: outcome, companyId, dateFrom, dateTo |

**Write actions:** Escalate (mandatory reason) → `tickets.status='ESCALATED'` + `ticket_events` +
`audit_logs`; Mark auto-recovery → `verification_runs.outcome='CLOSED_AUTO_RECOVERY'` and closes the
ticket/cycle.

---

# 39. `/vouchers` — Expense Voucher review

**Endpoints:** `GET /vouchers?status=`, `POST /vouchers/:id/review`, `POST /vouchers/mark-paid`,
`GET /vouchers/export?month=`.

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| SE name | Table col | same | `expense_vouchers.se_id → users.name` | — | ZM own zone; CSM/OH all |
| Status | Table col | same | `.status` | — | view toggle sends `ZONAL_MANAGER_REVIEW` or `APPROVED` |
| Total amount | Table col | same | `.total_amount` (Decimal) | `₹` + `toLocaleString('en-IN')` | — |
| Submitted at | Table col | same | `.submitted_at` | `iso.slice(0,10)` | — |
| Items (category + amount + 📎) | Table col | same | `expense_voucher_items.category/.amount/.photo_ref` | over-limit red flag from **hardcoded** `CATEGORY_LIMITS` in `vouchers.service.ts:15-22` (TRAVEL 5000, ACCOMMODATION 3000, PARTS 10000, TOOLS 5000, MEAL 500, OTHER 2000) — not from `system_settings` | — |
| Activity check (linked ticket / "⚠ No activity link" / "ticket missing") | Table col | same | `.ticket_id`, `.plant_id`, existence of the ticket | server-side `activityCheck` | — |
| Review notes | Table col | same | `.review_notes` | — | — |

**Write actions:** review (APPROVE / REJECT / NEEDS_CLARIFICATION, reason mandatory on the last two)
→ `expense_vouchers.status/.review_notes` + audit + SE notification; Mark PAID (OH, multi-select,
optional batchRef) → `.status='PAID'`; Export Finance (OH) → CSV of APPROVED vouchers for a month.

---

# 40. `/help` — Help Center

**Purpose:** role-scoped static guidance + glossary. **No API calls, no data source** — all content
is literal JSX. Reachable by every role.

---

# 41. `/coverage` — Floating-SE Territory (OH only)

**Endpoints:** `GET /org/engineers` (FE-filtered to `coverageType==='FLOATING'`),
`GET /org/geo/states|regions|districts`, `GET /org/se-territory?seId=`,
`POST /org/se-territory`, `DELETE /org/se-territory/:id`.

| Field shown | Where | API endpoint | Source table.column | Transform | Filters |
|---|---|---|---|---|---|
| Floating SE picker | Form | `/org/engineers` | `engineer_master.engineer_id/.coverage_type` | **client-side filter** to FLOATING | — |
| State / Region / District pickers | Form | `/org/geo/*` | `districts.state` (distinct), `regions.region_id/.name/.state`, `districts.district_id/.name/.state/.region_id` | cascading | `state`, `regionId` |
| Territory membership rows | Table | `/org/se-territory` | `engineer_territory_coverage.id/.se_id/.district_id/.region_id/.state` | names resolved client-side from the currently-loaded region/district lists — a row whose district isn't in the loaded page renders its id | `seId` |
| Polygon editor | Panel | — | `engineer_territory_coverage.polygon` | **rendered disabled** — reserved, unused in v1 | — |

**Write actions:** add (most specific of district > region > state) → `engineer_territory_coverage`
insert; remove → delete. Both trigger a `plant_eligible_floating_se` materialized-view refresh
server-side.

---

# 42. `/settings` — Settings (OH only), 9 tabs

All CRUD via `apps/admin/src/api/org.ts`.

| Tab | Fields shown | API endpoint | Source table.column | Write actions |
|---|---|---|---|---|
| Zones | zoneId, name, zonalManagerUserId | `GET/POST /org/zones` | `zones.zone_id/.name/.zonal_manager_user_id` | create zone |
| Plants | plantId, name, zoneId, zoneName, sourcePlantId, sourceZoneName | `GET/POST /org/plants` | `plants.*` | create plant |
| Users | userId, name, role, zoneId, phone, email, status | `GET/POST /org/users` | `users.*` | create user (no credentials — login is in-memory) |
| Companies | companyId, name, companyTier, companyPriorityRank, opsOverride | `GET/POST/PATCH /org/companies` | `company_master.*` | create + patch tier/rank/opsOverride |
| SE Coverage | id, seId, plantId, coverageType | `GET/POST /org/se-coverage`, `GET/POST /org/engineers` | `se_coverage.*`, `engineer_master.*` | add coverage, create engineer |
| SLA Rules | scope, key, submitWithinMinutes, verifyWithinMinutes, escalateAfterMinutes | `GET/PUT /org/sla-rules` | `sla_rule_config.*` | upsert |
| SLA bucket legend (8 rows) | bucket range label + "severity N/8" | **none** | — | derived from `SLA_BANDS` in `@fsm/shared` — **read-only, not editable, and not the same data as the SLA Rules CRUD** |
| Scoring Weights | weightSetRef, component, weight, active | `GET/POST /org/scoring-weights` | `priority_rule_config.*` | upsert |
| Common Kit | id, componentId, minQty, active | `GET/POST /org/common-kit` | `common_kit_definition.*` | upsert |
| Access | feature × role matrix | **none** | — | **HARDCODED** `ACCESS_FEATURES` array — a documentation table, not derived from `RoleRoute`/`@Roles` |

**Not exposed anywhere in the UI:** `system_settings` (the `GET /settings` and `PUT /settings/:key`
endpoints exist, OH-only, but no page calls them). `eligibility_mode`, `inactivity_threshold_hours`,
`plant_cluster_multiplier`, `telemetry_retention_days`, `recompute_canary_threshold_pct` are
therefore **not editable from the admin app**.

---

# 43. `/_kitchensink` — Design-system audit surface (DEV builds only)

Static component gallery. **No API calls, no data source.** Excluded from production builds
(`import.meta.env.DEV` guard in `AppRoutes.tsx:59`).

---

# 44. Mobile app (`apps/mobile`) — auth shell only

| Screen | Route | Purpose | Field shown | API endpoint | Source |
|---|---|---|---|---|---|
| LoginScreen | `app/index.tsx` → `AppEntry` | email/password login | error text | `POST /auth/login` | in-memory user store |
| SessionScreen | same, post-login | show the session | role | `GET /me` / JWT | JWT claim `role` |
| SessionScreen | | | "Zone N" / "All zones" | JWT | claim `zone_id` |
| SessionScreen | | | "Acting as \<role\>" | JWT | claim `acted_as_role` |

Every M-series field screen (Day Plan, troubleshoot form, van stock, vouchers) is **unbuilt** —
per `SYSTEM-STATE-2026-07.md` §1.1 the mobile app is 14 files of auth shell. Backend endpoints
that exist with **no mobile consumer**: `GET /schedules/me`, `GET /me/van-stock`,
`GET /me/shared-pool`, `POST /tickets/:id/troubleshoot`, `POST /tickets/:id/soft-state`,
`POST /me/activity-ping`, `POST /vouchers`, `POST /install/:id/on-site|fitted`,
`POST /recovery/:id/on-site|collected|unable-to-collect`,
`POST /intraday-insertions/:id/accept|decline`, `POST /component-requests/:id/confirm-receipt`,
`GET /non-op/confirm` (public customer token link).

---

# Empty / error / loading states (all pages)

| State | Where | Behaviour | Data implication |
|---|---|---|---|
| Loading | every `DataTable` | skeleton rows | — |
| Error + Retry | `DataTable error/onRetry` — used on Tickets, Device Detail, Dispatch Runs/Detail/Zone/Batch | error banner + Retry button | on other pages a failed fetch shows the **empty state**, i.e. "no rows" is indistinguishable from "request failed" (explicitly called out in `DeviceDetailPage.tsx:409-411` as a fixed bug on that page only) |
| Silent-catch | `SnapshotBanner`, `BuildHealthNotice`, `ZoneOperatingModeCard/Table`, `ManagerDashboard` fleet-summary + fleet-uptime + engineers | `.catch(() => undefined)` — renders nothing / "—" | a failed fleet-summary leaves the Companies/Plants/Active-Fleet KPIs at "—" with no error shown |
| Gated | Reports "Soft-Inactive count trend" | 403 → "Available to Operations Head." | — |
| Placeholder | System Efficiency "SE active load vs capacity"; Scorecard "% Successful Troubleshoot"; 7 Action-Required cards | static text | no backend source |

---

# Values on a page that could NOT be traced to a source (consolidated)

1. **Login page** — all four KPI tiles (`248`, `96.2%`, `14,238`, `84`) and the feature list: hardcoded.
2. **"Snapshot Healthy" badge** on ZmDashboard, CentralDashboard, WarehouseDashboard: hardcoded, not
   wired to `/snapshots/latest`.
3. **Zone Overview "Trend" column** (`trendPctVsPrevDay`): backend hardcodes `null`.
4. **Scorecard "% Successful Troubleshoot"**: hardcoded `"NA"`.
5. **7 of 9 Action Required cards** (`unreviewed_batches`, `vehicle_unavailability`,
   `critical_insertions_awaiting_accept`, `failed_verification`, `component_blocked`,
   `non_op_awaiting_manager`, `manual_assignment_required`): hardcoded `count:0, available:false`.
6. **Intra-day Queue "SE Acceptance" column**: hardcoded "No acceptance required" on every row.
7. **System Efficiency "SE active load vs capacity"**: static empty state.
8. **Settings → Access matrix**: hardcoded array, not derived from the actual guards.
9. **Voucher category limits**: hardcoded in service code, not in `system_settings`.
10. **Top-bar global search input and notification bell**: no handler, no endpoint.
11. **`DateRangeChips`** on Dashboard / SE Activity / VU / Settings: rendered but no page state reads
    the selection — the surfaces are not date-filtered.
12. **Reports "Data as of"**: browser wall-clock at fetch time, not a data watermark.
13. **`SeManagementDirectoryPage` "Companies" column**: always "—" (relationship not modelled).
14. **Fulfillment-SLA window (7 days)**: hardcoded default parameter.
15. **`SnapshotBanner` 15-minute "stuck" threshold**: FE constant, no backend/config equivalent.
