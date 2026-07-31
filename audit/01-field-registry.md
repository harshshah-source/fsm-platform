# 01 — Field Registry (Data Correctness Audit, Phase 1)

Every distinct **business fact** the application displays, with its canonical source, every surface
it appears on, and its storage class.

**Storage class legend**

- **STORED** — a physical column read directly.
- **COMPUTED-ON-READ (server)** — derived inside the query/service on each request.
- **COMPUTED-ON-READ (browser)** — derived in the React component, usually against the *browser
  clock* or *browser locale*.
- **DERIVED-AT-WRITE** — written by a pipeline/recompute job into a column; the column is stored but
  is not the system of record (the inputs are).
- **DENORMALIZED** — a copy of another table's value, frozen at write time.
- **CACHED/SUMMARY** — pre-aggregated cube or history table rebuilt on a schedule.
- **HARDCODED** — literal in source, no data source.

---

## A. Device & telemetry facts

| Fact | Canonical source table.column | Pages / endpoints where it appears | Stored / computed / denormalized |
|---|---|---|---|
| `device.device_id` | `devices.device_id` (AutoPlant business string) | Device Detail, Tickets, Ticket Drawer, Batch Detail, Critical Queue, Escalation Queue, Recovery queues, Non-Op queue, entity-mapping CSV | STORED (mirrored from AutoPlant) |
| `device.device_type` | `devices.device_type` | Device Detail list, Batch Detail, Device Detail header; report filter `deviceType` | STORED (mirrored via `ap_widgets.tb_vehiclemaster` join) |
| `device.imsi_no` | `devices.imsi_no` | Device Detail list, Batch Detail | STORED (same join) |
| `device.sim_id` | `devices.sim_id` | `GET /devices/:id` payload only — **not rendered** | STORED |
| `device.deal_type` | `devices.deal_type` | Device Detail (header + OH tag buttons); `GET /devices/:id` used by the Non-Op modal | STORED (OH-set, nullable) |
| `device.current_vehicle_id` | `devices.current_vehicle_id` | `GET /devices/:id` payload only | STORED |
| **`device.latest_gps_datetime`** | `device_states.latest_gps_datetime` | Tickets (Inactive badge), Ticket Drawer, Device Detail (Inactive Duration), Batch Detail (Inactive Duration), Critical Queue, Escalation Queue, entity-mapping CSV | DERIVED-AT-WRITE — maintained incrementally **at ingest** by `SnapshotIngestionService` (`GREATEST` upsert), not by the recompute |
| **`device.inactivity_hours`** | `device_states.inactivity_hours` | entity-mapping CSV only | DERIVED-AT-WRITE — `GREATEST(0, (now − latest_gps_datetime)/3600)` at each recompute |
| **`device.is_inactive`** | `device_states.is_inactive` | Zone Overview, Company/Plant Overview, Scorecard, Fleet KPIs, Device Detail filter, Zone-detail plant stats, operating-mode counts, activity trend | DERIVED-AT-WRITE — `NOT departed AND hours >= system_settings.inactivity_threshold_hours` (default 24) |
| **`device.sla_bucket`** | `device_states.sla_bucket` | Zone Overview (8 cols), Company/Plant Overview (8 cols), SLA Distribution chart, Scorecard, Tickets, Ticket Drawer, Device Detail, Schedule Detail badges, Cross-Zone, Critical Queue, Reports, entity-mapping CSV | DERIVED-AT-WRITE — `slaBucketCaseSql()` generated from `SLA_BANDS` (`@fsm/shared`): 4/8/12/24/48/72/120/168 h; NULL for 0–4 h |
| **`device.eligible_for_uptime`** | `device_states.eligible_for_uptime` | operating-mode counts, activity-trend live point, soft-inactive history, entity-mapping CSV | DERIVED-AT-WRITE — mode `pgi`: EXISTS `pgi_history` ≤15 d; mode `all-deployed`: `vehicles.status ∈ (ACTIVE, DEPLOYED)`; both AND NOT departed AND NOT an active Non-Op marking |
| `device.is_departed` | `device_states.is_departed` | Fleet Summary "Active Fleet"; Build Health `departedCount` | DERIVED-AT-WRITE — EXISTS `device_departures WHERE restored_at IS NULL` |
| `device.trip_creation_datetime` | `device_states.trip_creation_datetime` | Device Detail list, Batch Detail | DERIVED-AT-WRITE — maintained at ingest; **UTC offset 0** (source column is a MySQL TIMESTAMP read in a UTC session), unlike `latest_gps_datetime` which is normalised +330 |
| `device.has_open_failure_cycle` | `device_states.has_open_failure_cycle` | not rendered; gates ticket creation | STORED (owned by ticket creation; cleared by plant deactivation) |
| `device_state.computed_at` | `device_states.computed_at` | Exports card "data as of" (`MAX(computed_at)`) | STORED |
| `device.vehicle/plant/company/transporter` | `device_states.vehicle_id/.plant_id/.company_id/.transporter_id` | every device-scoped read | DENORMALIZED from `devices.current_vehicle_id → vehicles` at each recompute |

## B. Fleet / org facts

| Fact | Canonical source | Pages / endpoints | Class |
|---|---|---|---|
| `zone.name` | `zones.name` | Zone Overview, Scorecard, Company/Plant, Device Detail, Fleet Directory, Reports, operating-mode, dispatch zone cards, Plant Zones, entity-mapping CSV | STORED |
| `zone.zonal_manager_name` | `zones.zonal_manager_user_id → users.name` | Scorecard "Zonal Manager" | COMPUTED-ON-READ (join) |
| `company.name` | `company_master.name` | Tickets, Ticket Drawer, Company/Plant, Fleet Directory, Critical/Escalation queues, Component Requests, Shadow Use, Verification Review, Batch Detail, Plant Deactivations, entity-mapping CSV | STORED |
| **`company.company_tier` (global)** | `company_master.company_tier` | Company/Plant Overview, Fleet Directory, Critical Queue, Escalation Queue, Settings→Companies, Device Detail PRIORITY sort | STORED (OH-owned) |
| **`company.effective_tier` (per zone)** | `company_tier_overrides` (newest ACTIVE, unexpired) else `company_master.company_tier` | Recommender scoring; Tier Overrides page "Winning" badge | COMPUTED-ON-READ (`effective-tier.ts` / `resolveActiveOverrides`) |
| **`ticket.company_tier`** | `tickets.company_tier` | Tickets list, Ticket Drawer, Schedule Detail badge, Cross-Zone | DENORMALIZED — stamped at ticket creation from the effective tier; **never re-stamped** |
| `company.company_priority_rank` | `company_master.company_priority_rank` | Settings→Companies; Schedule Detail "Why suggested?" chip (via `recommendations.score_breakdown`); Device Detail PRIORITY sort | STORED |
| `plant.name` | `plants.name` | everywhere a plant appears | STORED (often an AutoPlant short code) |
| `plant.zone_id` | `plants.zone_id` | the scoping key for every ZM-clamped read | STORED — the **only** stored copy of a plant's zone |
| `plant.source_plant_id` | `plants.source_plant_id` | Plant Zones, Plant Deactivations, entity-mapping CSV | STORED |
| `plant.source_zone_name` | `plants.source_zone_name` | Plant Zones "AutoPlant zone" | STORED (raw mirror) |
| `plant.zone_source` | derived | entity-mapping CSV only | COMPUTED-ON-READ — `override` / `mapped` / `unzoned` |
| `plant.fsm_status` | `plant_deactivations.reactivated_at IS NULL` | entity-mapping CSV; Plant Deactivations page | COMPUTED-ON-READ |
| `plant.device_count` | `COUNT(device_states WHERE plant_id=…)` | Fleet Directory, Plant Deactivations, dispatch zone `plantStats` | COMPUTED-ON-READ |
| `vehicle.vehicle_no` | `vehicles.vehicle_no` | Tickets, Ticket Drawer, Device Detail, Batch Detail, SE detail stops, entity-mapping CSV | STORED |
| `vehicle.status` (deployment) | `vehicles.status` | entity-mapping CSV `deployment_status`; feeds `all-deployed` eligibility | STORED (AutoPlant mirror) |
| `transporter.name` | `transporters.name` | Tickets payload, Batch Detail, trace identity, entity-mapping CSV | STORED |

## C. Ticket & failure-cycle facts

| Fact | Canonical source | Pages / endpoints | Class |
|---|---|---|---|
| `ticket.ticket_id` | `tickets.ticket_id` | everywhere; almost always `.slice(0,8)` for display | STORED (uuid) |
| `ticket.work_type` | `tickets.work_type` | Tickets, Drawer, activity trend, work-type mix, recovery queues | STORED |
| `ticket.status` | `tickets.status` | Tickets, Drawer, Batch Detail, Recovery queues, Critical Queue | STORED |
| `ticket.assignment_state` | `tickets.assignment_state` | Tickets, Drawer, Device Detail, dispatch zone plantStats, Company/Plant filter | STORED |
| `ticket.assigned_se` | `batch_assignment_tickets(removed_at IS NULL) → plant_batch_assignments.se_id → users.name` | Tickets, Drawer, Device Detail, Batch Detail | COMPUTED-ON-READ (LATERAL, newest `bat.created_at`) |
| `ticket.overridden` | `plant_batch_assignments.status='OVERRIDDEN' OR work_schedules.status='OVERRIDDEN'` | Tickets, Drawer, Device Detail | COMPUTED-ON-READ |
| `ticket.repeat_failure` | `tickets.repeat_failure` | Tickets flags; Device Detail cycle card; efficiency cube | STORED |
| `ticket.created_at` | `tickets.created_at` | Tickets "Age", Drawer "Created", activity trend, work-type mix | STORED |
| `ticket.last_state_changed_at` | `tickets.last_state_changed_at` | Recovery-stalled count, recovery queues ordering | STORED |
| `ticket.closure_type` / `.closure_reason` / `.closed_at` | `tickets.*` | Device Detail cycle card (`closureType`), Recovery non-standard-closures | STORED |
| `ticket.unable_to_collect_reason` / `.unable_to_collect_at` | `tickets.*` | Recovery ZM Decision Queue | STORED |
| `ticket.collected_device_serial` / `.collection_condition_notes` | `tickets.*` | Recovery Receipt queue | STORED |
| `ticket.install_batch_id` / `.install_trigger_source` / `.created_by(_role)` | `tickets.*` | Install create result | STORED |
| `failure_cycle.state` | `failure_cycles.state` | Tickets flags (WAITING_COMPONENT / ESCALATED), Drawer Components banner | STORED |
| `failure_cycle.opened_at` / `.closed_at` | `failure_cycles.*` | Device Detail cycles, VU secondary clock | STORED |
| **`cycle.duration_seconds`** | `closed_at ?? now` − `opened_at` | Device Detail cycles | COMPUTED-ON-READ (server) |
| **`cycle.sla_bucket_reached`** | derived from `duration_seconds` | Device Detail "Current failure cycle" | COMPUTED-ON-READ — `classifySlaBucket(durationSeconds/3600)`; **a different value from the live `device_states.sla_bucket`** |
| `cycle.sla_paused` / `.sla_paused_at` / `.sla_pause_reason` / `.sla_accumulated_pause_seconds` | `failure_cycles.*` | VU dual clocks, WAITING_COMPONENT badge + overdue count | STORED |
| **`sla.primary_elapsed_seconds`** | derived | VU Review only | COMPUTED-ON-READ — `secondary − accumulated_pause − current_pause`, clamped ≥0 |
| **`sla.secondary_elapsed_seconds`** | derived | VU Review only (manager-gated) | COMPUTED-ON-READ — `now − failure_cycles.opened_at` |
| `ticket_event.*` | `ticket_events.from_state/.to_state/.actor_id/.actor_role/.acted_as_role/.reason_code/.at` | Drawer Lifecycle + Assignment History; `/audit-trail/tickets/:id` | STORED (append-only by construction) |
| `troubleshoot_submission.root_cause_category` | `troubleshooting_submissions.root_cause_category` | Drawer Forms; Device Detail cycle card + root-cause trend; Root-Cause report (via cube) | STORED |
| `component_request.status` (latest per ticket) | `component_request.status` newest by `created_at` | Tickets WAITING_COMPONENT flag | COMPUTED-ON-READ (correlated subquery) |
| `verification_run.outcome` | `verification_runs.outcome` | Drawer Verification, Verification Review, Device Detail cycle card, verification-outcomes report | STORED |
| **`verification.badge` / `rowType`** | derived from `outcome` + `pings_received_count` + `fraud_flag` | Drawer Verification badge; Verification Review row type + KPIs + donut | COMPUTED-ON-READ — `PARTIAL_RECOVERY` is **never stored**; it means `outcome IS NULL AND 1 ≤ pings ≤ 2` |
| `verification.pings_received_count` / `.fraud_flag` / `.first_ping_distance_meters` / `.phase` / `.started_at` | `verification_runs.*` | Drawer, Verification Review | STORED |
| **`verification.partial_deadline`** | `started_at + 24 h` | Verification Review countdown | COMPUTED-ON-READ (server); the "Nh left" text is browser-clock |

## D. Scheduling / dispatch facts

| Fact | Canonical source | Pages / endpoints | Class |
|---|---|---|---|
| `work_schedule.status` | `work_schedules.status` | Schedules list, Schedule Detail, SE detail, Tickets `overridden` | STORED — conflates lifecycle (ACTIVE) with provenance (OVERRIDDEN) |
| `schedule.is_live` | `status ∈ LIVE_SCHEDULE_STATUSES` | Schedules list, Schedule Detail, SE Activity, Day Plan | COMPUTED-ON-READ (constant in `scheduling/schedule-status.ts`; excludes COMPLETED/PARTIAL) |
| `work_schedule.date_from` / `.date_to` | `work_schedules.*` | Schedules list, Schedule Detail, SE detail | STORED (Date), rendered `toISOString().slice(0,10)` = **UTC** |
| `work_schedule.run_id` | `work_schedules.run_id` | Tickets payload `runId`; batch-detail run resolution | STORED (nullable — pre-ledger / ZM_MANUAL) |
| `schedule.batch_count` | `COUNT(plant_batch_assignments WHERE status ∈ (AUTO_ASSIGNED, OVERRIDDEN))` | Schedules list "Plant Stops" | COMPUTED-ON-READ |
| **`schedule.ticket_count`** | `COUNT(batch_assignment_tickets WHERE removed_at IS NULL)` | Schedules list "Tickets"; SE detail Day Plan count; SE Activity "Active Tickets" | COMPUTED-ON-READ — **no `tickets.status` filter** despite the "Active/OPEN tickets" labels |
| `batch.stop_sequence` | `plant_batch_assignments.stop_sequence` | Schedule Detail, SE detail, Batch rows | STORED |
| `batch.status` | `plant_batch_assignments.status` | Schedule Detail, Zone Dispatch table, Device Detail Assignment | STORED |
| `batch.se_id` | `plant_batch_assignments.se_id` | everywhere a batch shows | STORED |
| `batch.company_name` | `tickets → company_master.name` over the batch's tickets | Zone Dispatch table, Batch rows | COMPUTED-ON-READ — `distinctLabel()`: single value or `"First +N"` |
| **`batch.capacity_used`** | `COUNT(batch_assignment_tickets WHERE removed_at IS NULL)` grouped by `schedule_id` | Zone Detail batch rows | COMPUTED-ON-READ — a **whole-schedule** count, not per-batch |
| **`se.daily_capacity` (at run)** | `dispatch_runs.config_snapshot.capacity[seId].dailyCapacity` | Zone Detail capacity cap; Run Detail "Engineer capacity" | CACHED — frozen at run start, deliberately not today's `engineer_master.daily_capacity` |
| `se.daily_capacity` (live) | `engineer_master.daily_capacity` | SE Activity, SE Directory, Settings, `/schedules/engineers` | STORED |
| `dispatch_run.trigger/.status/.started_at/.finished_at` | `dispatch_runs.*` | Runs list, Run Detail | STORED |
| `dispatch_run.duration_ms` | `finished_at − started_at` | Runs list, Run Detail | COMPUTED-ON-READ (browser-side JS date diff on ISO strings) |
| `dispatch_run.zones/.schedules/.batches/.tickets_dispatched/.recommended/.unassignable` | `dispatch_runs.*` **or** `dispatch_run_zones.*` for a ZM | Runs list, Run Detail metric strip | STORED; the ZM view substitutes the single zone row |
| `dispatch_run_zone.mode` | `dispatch_run_zones.mode` | Run Detail zone card, Zone Detail header | STORED (DEFICIT/PREVENTIVE frozen at run) |
| `dispatch_run_zone.unassignable_reasons` | `dispatch_run_zones.unassignable_reasons` (JSONB) | Zone card "No coverage / All dropped" | STORED |
| `recommendation.processing_rank` / `.status` / `.score_breakdown` | `recommendations.*` | Batch Detail payload (`rank`, `score`, `recStatus`); Schedule Detail "Why suggested?" | STORED (append-only) |
| `decision_trace` (chosen, runnersUp, dropCounts, poolEmptyReason, scoreDegenerate) | `dispatch_decision_traces.trace` (JSONB) | Batch Detail expanded trace; Zone Detail unassignable table | STORED |
| `se_planner.planned_date` | `se_planner.planned_date` | Planner grid cells | STORED |
| **`zone.operating_mode`** | derived from `device_states.is_inactive` + `.eligible_for_uptime` per zone | ZM operating-mode card; OH/CSM operating-mode table; recommender at dispatch time | COMPUTED-ON-READ — `DEFICIT` iff `silent > 2% × eligible` (threshold is a **constructor default**, `DEFAULT_DEFICIT_THRESHOLD_PCT = 0.02`, not `system_settings`) |

## E. Engineer facts

| Fact | Canonical source | Pages / endpoints | Class |
|---|---|---|---|
| `se.name` | `users.name` (via `engineer_master.engineer_id = users.user_id`) | SE Activity, SE Directory, Schedules, Schedule Detail, Batch rows, Leave Requests, Vouchers, trace SE names | STORED |
| `se.coverage_type` | `engineer_master.coverage_type` | SE Activity, SE Directory, `/schedules/engineers`, Territory page filter, trace badges | STORED |
| `se.zone_id` | `engineer_master.zone_id` | SE Activity/Directory, Scorecard "Assigned SEs", planner rows | STORED |
| `se.is_active` | `engineer_master.is_active` | SE Directory toggle; `/schedules/engineers` filter; Scorecard SE count | STORED |
| `se.last_activity_at` | `engineer_master.last_activity_at` | input to Activity Status | STORED (written by `POST /me/activity-ping` — no mobile caller today) |
| `se.shift_end` | `engineer_master.shift_end` | input to Activity Status | STORED |
| **`se.activity_status`** | derived | SE Activity table + the 5 metric cards; SE detail | COMPUTED-ON-READ (server, per request) — `deriveActivityStatus(availabilityStatus, activeSoftStateTypes, lastActivityAt, shiftEnd, now)`; explicitly **never stored** |
| **`se.availability_status`** | `se_availability.status` of the window containing `now`, else `'AVAILABLE'` | SE Activity, SE detail | COMPUTED-ON-READ |
| `se_availability` windows | `se_availability.status/.window_start/.window_end/.reason/.set_by_role` | SE detail (last 10) | STORED |
| `soft_state.type` | `soft_states.type` where `resolved_at IS NULL` | input to Activity Status; ON_SITE override conflict | STORED |
| **`se.kit_complete` / `missing_kit`** | `se_van_stock.qty` vs `common_kit_definition.min_qty (active)` | SE Activity chip, SE detail | COMPUTED-ON-READ — returns *complete* when there is no active kit **or** the SE has zero van-stock rows |
| `se_van_stock.qty` | `se_van_stock.qty` | SE detail Van Stock; `GET /me/van-stock` (no caller) | STORED |
| `leave_request.*` | `leave_requests.type/.status/.window_start/.window_end/.reason/.decision_reason` | Leave Requests page | STORED |
| `engineer_territory_coverage` | `engineer_territory_coverage.state/.region_id/.district_id` | Territory page | STORED (`polygon` reserved, unused) |

## F. Inventory / warehouse facts

| Fact | Canonical source | Pages / endpoints | Class |
|---|---|---|---|
| `component.name` | `component_master.name` | Component Requests, Shadow Use, Warehouse Stock, Component-Blocked missing parts, SE Van Stock | STORED |
| `component_request.status` | `component_request.status` | WM queue, oversight, Ticket Drawer Components tab, Tickets flag | STORED |
| `component_request.delivery_destination` / `.tracking_ref` / `.rejection_reason` | `component_request.*` | WM queue, Drawer Components | STORED |
| `component_request.age_days` | `now − created_at` | WM queue, oversight, Drawer | COMPUTED-ON-READ (server, floor days) |
| **`warehouse.fulfillment_sla_pct`** | `component_request.created_at`, `.received_at`, `.status` | WM dashboard KPI | COMPUTED-ON-READ — `|received ≤ 7 d| / |received| × 100`; window is a hardcoded default |
| `warehouse.open_requests` | `COUNT(component_request WHERE status ∈ (REQUESTED, APPROVED, SHIPPED))` | fulfilment-SLA payload (**not** the WM "Open Requests" KPI, which counts the queue rows client-side) | COMPUTED-ON-READ |
| `zone_warehouse_stock.on_hand` / `.reserved` / `.low_stock_threshold` | `zone_warehouse_stock.*` | WM dashboard stock table | STORED (manually WM-managed) |
| **`stock.available` / `.low_stock`** | derived | WM dashboard | COMPUTED-ON-READ — `on_hand − reserved`; `available <= threshold` |
| `component_blocked_queue.missing_components` | `component_blocked_queue.missing_components` (JSONB) | Component-Blocked Queue | STORED (snapshot of the shortfall at block time) |
| **`blocked.warehouse_overdue`** | derived | Component-Blocked Queue + Action Required | COMPUTED-ON-READ — `age > 7 d AND wm_action_status='PENDING'` |
| `inventory_transactions.status/.qty/.reason` | `inventory_transactions.*` | Shadow Use Queue, WM dashboard | STORED |

## G. Reporting / summary facts (all CACHED)

| Fact | Canonical source | Pages / endpoints | Class |
|---|---|---|---|
| **`fleet.uptime_pct`** | `device_downtime_summary_monthly.downtime_seconds`, `.window_seconds` where `eligible=true` | ZM/CSM/OH dashboard KPI, Scorecard column, Company/Plant column, Reports KPI + 2 charts + zone breakdown | CACHED cube + COMPUTED-ON-READ `(1 − Σd/Σw)×100`; **zero window ⇒ 100%** |
| `fleet.eligible_device_count` | `COUNT(device_downtime_summary_monthly rows WHERE eligible)` | Reports KPI; gates whether the dashboard shows uptime at all | CACHED |
| `fleet.auto_recovery_closures` / `.se_repaired_closures` | `device_downtime_summary_monthly.*` | Reports KPIs; Device Detail lifetime stats | CACHED |
| `device.lifetime_downtime_hours`, `.total_cycles`, `.repeat_failures`, `.longest_episode_hours`, `.avg_time_to_recover_hours`, `.component_downtime_hours` | `device_downtime_summary_monthly.*` per device | Device Detail stat cards + monthly trend | CACHED cube; hours = seconds/3600 rounded 2 dp |
| **`zone.soft_inactive_count`** | `soft_inactive_count_history.soft_inactive_count` | Reports soft-inactive trend; dashboard activity-trend "inactive" series | CACHED (twice-daily snapshot at 06:00/18:00 cron) — the activity trend **overwrites the current bucket with a live count** |
| `zone.eligible_device_count` (history) | `soft_inactive_count_history.eligible_device_count` | soft-inactive-trend payload | CACHED |
| `root_cause.distribution` | `root_cause_summary_monthly.root_cause_category`, `.submission_count` | Root-Cause Analytics | CACHED monthly cube; `pct` computed on read |
| `efficiency.*` (23 counters + 8 sums/counts) | `system_efficiency_summary_daily.*` | System Efficiency KPIs + zone table | CACHED daily cube; all rates computed on read |
| `zm.overrides/.removals/.deferrals/.reorders/.swaps/.reassignments/.split_batches/.override_after_onsite/.manual_assignments/.auto_assigned_count` | `zm_performance_summary_monthly.*` | ZM Scorecard | CACHED monthly cube |
| `zm.zone_sla_compliance_pct` | `zm_performance_summary_monthly.zone_downtime_seconds`, `.zone_window_seconds` | ZM Scorecard, Top-performer card | CACHED + `(1 − d/w)×100` on read |
| `work_type_mix` | live `COUNT(tickets) GROUP BY work_type` | Reports chart | COMPUTED-ON-READ (no cube) |
| `verification_outcomes` | live `COUNT(verification_runs) GROUP BY outcome` | Reports chart | COMPUTED-ON-READ (no cube) |
| `csm_backup_share` | `audit_logs.acting_zone`, `.acted_as_role` grouped | CSM Backup Share | COMPUTED-ON-READ over `audit_logs` |
| `plant_eligible_floating_se` | materialized view | recommender candidate selection (no UI) | MATERIALIZED VIEW, refreshed on territory edits |

## H. Ingestion / build-health facts

| Fact | Canonical source | Pages / endpoints | Class |
|---|---|---|---|
| `snapshot.data_as_of` | `snapshot_runs.data_as_of` of the newest SUCCESS run | Snapshot banner | STORED (conservative high-water of succeeded chunks) |
| `snapshot.latest_status` | `snapshot_runs.status` of the newest run | Snapshot banner alert | STORED |
| `snapshot.is_stuck` | derived | Snapshot banner | COMPUTED-ON-READ (browser) — `RUNNING` and `now − started_at > 15 min` |
| `master_sync.entity_stats.devices.observed` | `master_sync_runs.entity_stats` JSONB | **"Total Devices" KPI** (OH dashboard) | STORED, newest SUCCESS run only, pan-India |
| `runtime_lock.version/.fingerprint` | `runtime_lock` (raw SQL, no Prisma model) | Build Health page + banner; dispatch-run stale badge | STORED |
| `run.stale_build` | `run.build_version < runtime_lock.version` | Build Health, banner, Dispatch Run Detail | COMPUTED-ON-READ |
| `recompute.eligible/inactive/departed/total_count` | `device_state_recomputes.*` | Build Health history table | STORED (ledger) |
| `recompute.swing_pct` / `.swing` | derived from consecutive ledger rows | Build Health, banner | COMPUTED-ON-READ vs `system_settings.recompute_canary_threshold_pct` (default 5) |
| `integration.reconciliation` (source vs FSM plant/vehicle counts) | AutoPlant MySQL counts vs `plants.count()` / `vehicles.count()` | `GET /integration/health` payload — **not rendered by any page** | COMPUTED-ON-READ |
| `integration.source.connected` / `.vehicleRows` | live AutoPlant `ping()` | `GET /integration/health` payload — **not rendered** | COMPUTED-ON-READ |
| `masterSync.lastAt` / `.ageMinutes`, `snapshot.lastAt` / `.ageMinutes` | `master_sync_runs.finished_at`, `snapshot_runs.data_as_of` | `GET /integration/health` payload — **not rendered** | COMPUTED-ON-READ |

## I. Config facts

| Fact | Canonical source | Pages / endpoints | Class |
|---|---|---|---|
| `inactivity_threshold_hours` (24) | `system_settings` | drives `is_inactive` | STORED — **no UI** |
| `eligibility_mode` (`pgi`) | `system_settings` | drives `eligible_for_uptime`; echoed in Run Detail "Engineer eligibility" | STORED — **no UI to change it** |
| `plant_cluster_multiplier` (1.25) | `system_settings` | Run Detail "Same-plant clustering" | STORED — no UI |
| `telemetry_retention_days` (7) | `system_settings` | partition maintenance | STORED — no UI |
| `recompute_canary_threshold_pct` (5) | `system_settings` | Build Health swing flag | STORED — no UI |
| `sla_resume_on_receipt` (default false) | `system_settings` | component-request confirm-receipt | STORED — no UI, not in `SETTINGS_DEFAULTS` |
| SLA band boundaries (4/8/12/24/48/72/120/168 h) | `SLA_BANDS` in `packages/shared/src/index.ts` | backend classifier (SQL + TS) **and** every FE bucket label / Settings legend | HARDCODED in shared code — the single source; not DB-configurable |
| `sla_rule_config` (submit/verify/escalate minutes) | `sla_rule_config` | Settings → SLA Rules CRUD | STORED — **separate from `SLA_BANDS`; no read path found that consumes it in a displayed metric** |
| `priority_rule_config` weights | `priority_rule_config` | Settings → Scoring Weights; Run Detail "Priority weighting" (frozen copy) | STORED |
| Voucher category limits | `CATEGORY_LIMITS` in `vouchers.service.ts` | Voucher over-limit red rows | HARDCODED |
| Deficit threshold 2 % | `DEFAULT_DEFICIT_THRESHOLD_PCT` in `soft-inactive-count.service.ts` | operating mode, DEFICIT/PREVENTIVE | HARDCODED constructor default |
| Cross-zone auto thresholds (60 min CRITICAL+, 240 min OPEN) | constants in `cross-zone-escalation.service.ts` | auto-escalation sweep | HARDCODED |
| Recovery stall (14 d), WAITING_COMPONENT overdue (7 d), component-blocked overdue (7 d), partial-recovery window (24 h), snapshot-stuck (15 min), fulfilment SLA (7 d) | constants across services / components | Action Required, Component-Blocked, Verification Review, Snapshot banner, WM dashboard | HARDCODED |

---

# CROSS-PAGE TARGETS

Facts that appear on **two or more** surfaces. These are the reconciliation targets for the next
phase. Aliasing is called out explicitly.

## T1. Inactive device count — 7 surfaces, 3 different populations

| Surface | Label used | Query population |
|---|---|---|
| ZM/CSM/OH dashboard KPI | "Inactive Devices" | Σ over `zone-overview` = `is_inactive AND sla_bucket IS NOT NULL`, deactivated plants excluded |
| Zone Overview table | "Inactive / Total Device" | same rows, per zone |
| Zone Performance Scorecard | "Inactive / Total" | same |
| Company/Plant Overview | per-company/plant inactive | `is_inactive AND sla_bucket IS NOT NULL` + company join, deactivated excluded |
| Reports KPI | "Total Inactive" | same `zone-overview` source |
| Dispatch Zone Detail plant stats | "Inactive / Total" | `COUNT FILTER (device_states.is_inactive)` — **no `sla_bucket IS NOT NULL` filter, no deactivated-plant exclusion** |
| Activity-trend current bucket / operating mode | "Devices quiet" | `is_inactive AND eligible_for_uptime` — **a different predicate again** |

**Aliases:** "Inactive Devices" = "Total Inactive" = "Inactive / Total" = "Devices quiet" = the
inactive stock series on the Fleet Activity Trend.

## T2. Total device count — 6 surfaces, 4 different definitions

| Surface | Label | Definition |
|---|---|---|
| OH dashboard | **"Total Devices"** | `master_sync_runs.entity_stats.devices.observed` — raw AutoPlant catalog, **pan-India, never zone-scoped** |
| ZM/OH dashboard | **"Active Fleet"** | `COUNT(device_states) FILTER (is_departed = false)`, zone-scoped, deactivated plants excluded |
| Zone Overview / Scorecard | **"Total"** (denominator of Inactive/Total) | `COUNT(device_states)` per zone — **no `is_departed` filter** |
| Fleet Directory | **"Devices"** (KPI + per-company + per-plant) | `COUNT(device_states)` grouped — **no `is_departed` filter** |
| Dispatch Zone Detail | **"Total devices"** | `COUNT(device_states)` per plant — no exclusions at all |
| Exports card | **"\<N\> devices"** | `COUNT(*) FROM device_states` — no filters |

**Aliases to reconcile:** Total Devices ≠ Active Fleet ≠ Total (scorecard) ≠ Devices (directory).

## T3. Critical-severity count — 4 surfaces, 2 definitions

| Surface | Label | Definition |
|---|---|---|
| ZM + OH dashboard KPI | "Critical Devices" | `criticalOnlyCount` = **strictly `byBucket.CRITICAL`** (24–48 h) |
| Zone Performance Scorecard | "Inactive > 24Hr" | `criticalPlusCount` = CRITICAL + HIGH_CRITICAL + SEVERE + VERY_SEVERE + LONG_PENDING |
| Reports KPI | "Critical+" | same 5-bucket sum, re-declared locally in `ReportsPage.tsx:29` |
| Company/Plant Overview export | "Critical" column | `criticalOnlyCount` (CRITICAL only) |
| Device Detail deep-link | `criticalPlus=true` | the 5-bucket set, applied server-side |

Both helpers live in `lib/slaBucket.ts` and are documented as intentionally different; the Reports
page keeps its own copy of the 5-bucket list.

## T4. Fleet Uptime % — 6 surfaces, one source

`device_downtime_summary_monthly` → `(1 − Σdowntime/Σwindow)×100`, `eligible=true` rows only.
Appears as: dashboard hero KPI (all 3 manager variants) · Scorecard "Fleet Uptime" column (per zone)
· Company/Plant Overview "Fleet Uptime %" column (per plant) · Reports KPI · Reports "last 6 months"
trend (6 separate requests) · Reports "by zone" bars · Reports zone-breakdown table · ZM Scorecard
"Zone SLA" (from a **different cube**, `zm_performance_summary_monthly.zone_downtime_seconds`).

**Alias:** "Fleet Uptime" = "Zone SLA" = "zoneSlaCompliancePct" — but the last one reads a different
table.

## T5. SLA bucket distribution — 6 surfaces

`device_states.sla_bucket` appears as: Zone Overview 8 columns · SLA Bucket Distribution bar chart
(ZM/CSM/OH) · Company/Plant Overview 8 columns · Reports "Inactivity by SLA bucket" · Device Detail
badge + filter · Tickets "Inactive" badge + filter · Schedule Detail per-ticket badge ·
Cross-Zone "Bucket" · entity-mapping CSV. Bucket **labels** everywhere derive from `SLA_BANDS`.

## T6. Inactive duration (elapsed since last ping) — 5 surfaces

`device_states.latest_gps_datetime`, rendered by the shared browser helper
`formatInactiveDuration()`: Tickets "Inactive" badge · Ticket Drawer "Inactive for" · Device Detail
"Inactive Duration" column · Batch Detail "Inactive Duration" column · Critical Queue and Escalation
Queue duration badges. All five use the **browser clock**; the backend's own `inactivity_hours`
(server clock, recompute time) appears only in the entity-mapping CSV.

**Alias:** "Inactive Duration" (device/batch tables) = "Inactive for" (drawer) = the duration badge
on the queues = `inactive_hours` in the CSV — but the CSV value is as-of the last recompute.

## T7. Company tier — 5 surfaces, 3 sources

| Surface | Label | Source |
|---|---|---|
| Tickets list / Drawer / Schedule Detail / Cross-Zone | "Tier" | `tickets.company_tier` (**denormalised, frozen at creation**) |
| Company/Plant Overview, Fleet Directory, Critical/Escalation Queue, Settings→Companies | "Tier" | `company_master.company_tier` (live global) |
| Tier Overrides page "Winning" | "Override tier" | `company_tier_overrides` newest ACTIVE + unexpired per (company, zone) |
| Recommender sort key 1 | — | effective tier = override else global |

## T8. Assigned SE — 5 surfaces, one resolution path

`batch_assignment_tickets (removed_at IS NULL) → plant_batch_assignments.se_id → users.name`:
Tickets "Assignment" · Ticket Drawer "Assigned SE" · Device Detail "Assignment" column + detail card
· Batch Detail "SE" column · SE Activity/detail (inverse direction). Same LATERAL shape in
`ticket-query.service.ts` and `device.service.ts`.

## T9. Assignment state — 4 surfaces

`tickets.assignment_state`: Tickets column + filter · Ticket Drawer · Device Detail column ·
Company/Plant Overview filter · Dispatch Zone Detail per-plant `assigned`/`unassigned` counts
(the last one counts **all** tickets at the plant regardless of status or run).

## T10. Ticket count per SE/schedule — 4 surfaces

`COUNT(batch_assignment_tickets WHERE removed_at IS NULL)`:
Schedules list "Tickets" · SE Activity "Active Tickets" · SE detail Day Plan `ticketCount` ·
Zone Detail `capacityUsed.used` · Schedule Detail per-stop "device count".
**Aliases:** "Tickets" = "Active Tickets" = "device count" = "capacity used" — all the same count,
none of them filtered on `tickets.status`.

## T11. Batch / stop counts — 3 surfaces

`COUNT(plant_batch_assignments WHERE status ∈ (AUTO_ASSIGNED, OVERRIDDEN))`:
Schedules list "Plant Stops" · Schedule Detail stop cards · Dispatch Runs "Batches" and Run Detail
"Batches" (these last two read `dispatch_runs.batches` / `dispatch_run_zones.batches` — a
**stored counter written by the run**, not a live count).

**Alias:** "Plant Stops" = "Batches" — but from two different sources.

## T12. Company / plant counts — 3 surfaces

| Surface | Label | Source |
|---|---|---|
| Dashboard KPI cards | "Companies", "Plants" | `COUNT(DISTINCT device_states.company_id / .plant_id)`, zone-scoped, deactivated excluded |
| Fleet Directory metric strip | "Companies", "Plants" | `dir.companies.length` / `dir.plants.length` — **row counts of the returned lists**, where a plant serving 2 companies produces 2 rows |
| Fleet Directory company row | "Plants" | `COUNT(DISTINCT device_states.plant_id)` per company |

## T13. Zone name & zone scoping — every manager surface

`plants.zone_id → zones.name` is the scoping key for tickets, devices, dispatch, verification,
component requests, VU, planner and every report. `engineer_master.zone_id` is a **separate**
zone assignment for SEs, and `work_schedules.zone_id` a third. Surfaces that display a zone name:
Zone Overview, Scorecard, Company/Plant, Device Detail, Fleet Directory, Reports scope chips + zone
breakdown, dispatch zone cards, operating-mode table, Component Requests, Component-Blocked,
Shadow Use, Verification Review, Plant Zones, Plant Deactivations, entity-mapping CSV.
**Exception:** CSM Backup Share renders `"Zone <id>"` — the only surface that never resolves the name.

## T14. Age in days — 6 surfaces, 2 clocks

| Surface | Label | Computed where |
|---|---|---|
| Tickets | "Age" | **browser** — `floor((Date.now() − createdAt)/86400000)` |
| Cross-Zone | "Age" | **browser** |
| Component Requests / oversight / Drawer | "Age" | server (`ComponentRequestService.buildRows`) |
| Shadow Use | "Age" | server |
| Component-Blocked | "Age" / "Oldest" | server |
| Non-Op queue | "Awaiting" | server (`awaiting_since`) |

## T15. SLA bucket "reached" vs live bucket — 2 surfaces, easily confused

- `device_states.sla_bucket` — the device's **current** band (live, ages with wall-clock).
- Device Detail "Current failure cycle → SLA bucket" — `classifySlaBucket(cycleDurationSeconds/3600)`,
  i.e. the band the **cycle's elapsed duration** reaches. Both render through the same `SLABadge`.

## T16. Verification outcome — 4 surfaces

`verification_runs.outcome`: Ticket Drawer Verification badge · Verification Review row type + KPIs +
donut · Device Detail "Current failure cycle → Verification" · Reports "Verification outcomes" chart.
`PARTIAL_RECOVERY` is derived (never stored) on the first two; the Reports chart lists it as a
first-class outcome key, so it will only appear there if a run actually stores that enum value.

## T17. Root cause — 3 surfaces

`troubleshooting_submissions.root_cause_category`: Ticket Drawer Forms tab (raw, per submission) ·
Device Detail "Current failure cycle → Root cause" (latest submission of the cycle) + per-device
monthly root-cause trend (live `GROUP BY`) · Root-Cause Analytics page (**`root_cause_summary_monthly`
cube**, not the raw table).

## T18. Override count / rate — 3 surfaces

- Schedules list "Overridden" — `COUNT(work_schedules.status='OVERRIDDEN')` (live).
- System Efficiency "Override Rate %" — `Σ system_efficiency_summary_daily.overrides / (auto+manual)`.
- ZM Scorecard "Overrides" / "Override rate %" — `Σ zm_performance_summary_monthly.overrides_total /
  Σ auto_assigned_count`.

Three different denominators for the same-named metric.

## T19. Auto-recovery closures — 3 surfaces

- Reports KPI "Auto-Recovered" — `Σ device_downtime_summary_monthly.auto_recovery_closures`.
- Device Detail lifetime "autoRecoveryClosures" — same cube, per device.
- System Efficiency "Auto-Recovery %" — `Σ system_efficiency_summary_daily.auto_recoveries`.
- Tickets "auto" flag / Verification Review CLOSED_AUTO_RECOVERY rows — live `tickets.status` /
  `verification_runs.outcome`.

## T20. Repeat failure — 3 surfaces

`tickets.repeat_failure` (Tickets "🔥 REPEAT" flag) · `failure_cycles.repeat_failure` → Device Detail
cycle card + lifetime `repeatFailures` (from `device_downtime_summary_monthly.repeat_failure_count`)
· System Efficiency "repeatFailureRatePct" (from the daily cube).

## T21. WAITING_COMPONENT / SLA pause — 4 surfaces

`failure_cycles.state='WAITING_COMPONENT'` + `.sla_paused_at`:
Tickets flag (with days + latest CR status) · Ticket Drawer Components banner · Action Required
"WAITING_COMPONENT over 7 days" count · VU Review primary-clock arithmetic (which subtracts
`sla_accumulated_pause_seconds` regardless of pause reason).

## T22. Build / run attribution — 3 surfaces

`runtime_lock.version` vs `*.build_version`: global BuildHealthNotice banner · Build Health page ·
Dispatch Run Detail stale-build alert. Three independent `staleBuild` computations over the same
comparison.

## T23. Snapshot freshness — 3 surfaces

`snapshot_runs.data_as_of`: global Snapshot banner · Exports card "data as of" (which actually reads
`MAX(device_states.computed_at)`, a **different** watermark) · `GET /integration/health`
`snapshot.lastAt` (not rendered).

**Alias trap:** "data as of" on the banner ≠ "data as of" on the Exports card.

## T24. Plant deactivation exclusion — inconsistent across surfaces

`EXCLUDE_DEACTIVATED_PLANTS` is applied in `dashboard.service.ts` (zone-overview, fleet-summary,
fleet-directory, company-plant-overview, activity-trend, live inactive count) and in ticket creation,
recommender dispatch and the entity-mapping CSV's `plant_fsm_status` column. It is **not** applied in:
`device.service.ts` (Device Detail list + filter options), `ticket-query.service.ts` (Tickets),
`soft-inactive-count.service.ts` (operating mode — deliberate, documented),
`dispatch-transparency-query.service.ts` (`plantDeviceStats`), and the reporting cubes.

## T25. SE name resolution — resolved on some surfaces, raw uuid on others

Resolved to `users.name`: Schedules, Schedule Detail, SE Activity/Directory, Batch Detail, Tickets,
Ticket Drawer, Device Detail, Leave Requests, Vouchers, decision traces.
**Rendered as a raw uuid (or 8-char prefix):** Component Requests "Requested by", Shadow Use
"Engineer", Component-Blocked "Engineer", Intra-day Queue "SE" and "By", VU "Filed by",
Tier Overrides "Created by", Plant Deactivations "Deactivated by", Cross-Zone "Company"
(company **id**, not name).
