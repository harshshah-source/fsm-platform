# 02 — Open Questions (Data Correctness Audit, Phase 1)

Everything a human needs to answer before correctness can be judged. Nothing here is a bug claim —
each item is either a definition I can read but cannot validate, an inconsistency whose intent is
unclear, or something I could not trace at all.

---

## 1. Metrics I can see computed but cannot confirm are computed *correctly*

### 1.1 Fleet Uptime %

`(1 − Σ downtime_seconds / Σ window_seconds) × 100`, over `device_downtime_summary_monthly` rows
with `eligible = true` (`reports.service.ts:703-706`).

- **A zero window returns 100 %**, not `null` or `—`. A zone with no eligible device-months
  therefore reads as a perfect 100 % rather than "no data". Is that the intended business reading?
- `eligibleDeviceCount` on the Reports page counts **device×month rows**, and is labelled
  "Eligible Devices" next to live device KPIs. Should it be distinct devices?
- The dashboard only shows uptime when `fleet.eligibleDeviceCount > 0`; the Scorecard and
  Company/Plant columns show `—` when a zone/plant has no cube row. Two different "no data" rules
  for the same metric — intended?
- The Reports "last 6 months" trend is **six separate HTTP requests** fanned out client-side, and a
  failed month is silently dropped from the series rather than rendered as a gap. Confirm that a
  missing month should vanish rather than break the line.

### 1.2 "Critical" — two definitions, both live

`criticalOnlyCount` (strictly the `CRITICAL` bucket, 24–48 h) powers the dashboard "Critical Devices"
KPI; `criticalPlusCount` (CRITICAL and worse, 5 buckets) powers the Scorecard "Inactive > 24Hr" and
the Reports "Critical+". The code comments say this split was an explicit Issue-122 decision.
**Confirm this is still the intent**, and that operators reading a dashboard KPI of 40 next to a
scorecard column summing to 900 understand they are different questions.

### 1.3 Inactive-device count — three different predicates (registry T1)

- `is_inactive AND sla_bucket IS NOT NULL` (dashboards, scorecard, company/plant, reports)
- `is_inactive` alone (dispatch zone-detail plant stats)
- `is_inactive AND eligible_for_uptime` (operating mode, activity-trend live point,
  soft-inactive history)

Given `sla_bucket` is NULL only for the 0–4 h band and for departed devices, the first two should
agree in practice — but the third is a materially smaller population. **Which one is "the" inactive
count for the business?**

### 1.4 Total device count — four definitions (registry T2)

"Total Devices" (AutoPlant catalog, pan-India) sits on the same KPI row as "Active Fleet"
(zone-scoped, non-departed), while "Total" in the Inactive/Total denominator and "Devices" in the
Fleet Directory both count `device_states` with **no** `is_departed` filter.
**Should the Inactive/Total denominator exclude departed devices?** Right now a departed device is
excluded from the numerator (`is_inactive` is forced false) but included in the denominator, which
mechanically depresses the ratio.

### 1.5 Ticket counts labelled "Active" / "OPEN"

`EngineersQueryService.activeTicketCountBySe` is documented as "Count of OPEN tickets" and rendered
as "Active Tickets", but the query counts `batch_assignment_tickets WHERE removed_at IS NULL` with
**no filter on `tickets.status`** — a closed ticket still on today's plan is counted. Same shape for
the Schedules list "Tickets", the SE detail Day Plan count, per-stop "device count", and the
dispatch `capacityUsed.used`. **Is a closed-but-still-on-plan ticket meant to count toward an SE's
load and capacity?**

### 1.6 Dispatch zone-detail "Assigned / Unassigned" per plant

Counts **every** ticket at the plant by `assignment_state`, with no status, date or run filter, and
is displayed inside a page scoped to one dispatch run. **Is this meant to be run-scoped, or is the
"current plant standing" reading intentional?**

### 1.7 Capacity used vs cap

`capacityUsed.used` is a whole-**schedule** live count while `cap` is the value **frozen in the run's
`config_snapshot`**. Deliberate per the code comments — confirm operators reading "7 / 5" understand
one side is live and the other historical.

### 1.8 Operating mode threshold

`DEFICIT` iff `silentCount > 0.02 × eligibleCount`. The 2 % is a **constructor default**
(`DEFAULT_DEFICIT_THRESHOLD_PCT`), not a `system_settings` key, and is not surfaced or editable.
`soft_inactive_count_history.threshold_pct` records what was used at snapshot time.
**Should this be operator-tunable, and is 2 % still correct?**

### 1.9 Fulfilment SLA

`withinSlaPct` uses a **hardcoded 7-day** window (`slaWindowDays = 7` default parameter) over *all*
RECEIVED component requests ever — no date window, no zone scope. **Should this be a trailing
window, and should it be zone-scoped like the rest of the WM dashboard?**

### 1.10 Voucher over-limit thresholds

`CATEGORY_LIMITS` is a hardcoded map in `vouchers.service.ts` (TRAVEL 5000 / ACCOMMODATION 3000 /
PARTS 10000 / TOOLS 5000 / MEAL 500 / OTHER 2000), described in-code as "advisory only … a future
Issue can move these to `system_settings`". **Are these the current finance limits?**

### 1.11 CSM Backup Share denominator

`totalActedActions` counts **every** `audit_logs` row with a non-null `acting_zone` in the period,
of any action type. `csmActions` counts those where `acted_as_role = 'CENTRAL_SERVICE_MANAGER'`.
**Is "any audited action performed while acting in a zone" the right denominator for "backup
share"**, or should it be restricted to approval/decision actions?

### 1.12 ZM Scorecard "Zone SLA"

Reads `zm_performance_summary_monthly.zone_downtime_seconds / .zone_window_seconds` — a **different
cube** from the Fleet Uptime the dashboards show, but rendered with the same formula and a similar
label. **Should these two always agree?** If yes, they need a reconciliation test; if no, the labels
need to differ.

### 1.13 Rates with unusual denominators (System Efficiency)

- `autoRecoveryRatePct = autoRecoveries / (cyclesResolved + autoRecoveries)` — auto-recoveries are
  added to the denominator, implying they are *not* counted inside `cyclesResolved`. Confirm.
- `failedVerificationRatePct = failedVerifications / (verifiedCycles + failedVerifications)`.
- `overrideRatePct = overrides / (autoAssignments + manualAssignments)` here, but
  `overrides / autoAssignedCount` on the ZM Scorecard.
- `repeatFailureRatePct = repeatFailures / failureCyclesOpened`.
- `firstTimeFixRatePct = firstTimeFixes / cyclesResolved`.

None of these definitions is written down outside the code. **Please confirm each denominator.**

### 1.14 Metrics computed but never displayed

`SystemEfficiencyReport` returns `slaCompliancePct`, `totalDowntimeSeconds`, `avgDowntimeSeconds`
and seven `avg*Seconds` stage timings; the ZM Scorecard returns `removals`, `deferrals`, `reorders`,
`swaps`, `reassignments`, `splitBatches`, `overrideAfterOnsite`, `autoAssigned` and a full `trend[]`
series. **Are these intended to be surfaced, or is the API deliberately wider than the UI?**

---

## 2. Timezone handling

This is the largest single source of ambiguity in the audit.

### 2.1 What is stored

- All Postgres timestamps are `timestamptz` (UTC) per the schema conventions.
- `raw_device_snapshots.gps_datetime` and `device_states.latest_gps_datetime` come from a **naive
  MySQL DATETIME written in IST**, normalised by `AUTOPLANT_SOURCE_UTC_OFFSET_MIN` (documented as
  +330).
- `device_states.trip_creation_datetime` comes from a MySQL **TIMESTAMP** read in a UTC session and
  therefore takes offset **0**. Two columns on the same row, two different offsets.
- `soft_inactive_count_history.period` is `'MORNING'` / `'AFTERNOON'` decided by
  `now.getUTCHours() < 12` — i.e. **UTC noon**, not IST noon. The cron that writes it is
  `0 6,18 * * *` (server local). **Is the intended split 06:00/18:00 IST or UTC?**

### 2.2 What is computed in

- `device_states.inactivity_hours`, `is_inactive`, `sla_bucket`: server clock, at recompute time.
- Activity trend buckets: `date_trunc(unit, ts AT TIME ZONE 'UTC')` — explicitly **UTC calendar
  days/months**. A ZM in IST looking at "yesterday" sees a UTC day.
- Report month/day parsing: `parseMonth` / `parseDay` build `Date.UTC(...)`; `defaultMonth` /
  `defaultDay` read `getUTCFullYear/Month` / `toISOString().slice(0,10)`. All reports are on **UTC
  calendar boundaries**.
- `work_schedules.date_from/.date_to`, `se_planner.planned_date`, `company_tier_overrides.expires_at`
  are serialised `toISOString().slice(0,10)` — **UTC dates**.
- Cross-zone deferral / same-day logic uses `utcDayStart(now)`.

### 2.3 What is displayed in

- `toLocaleString()` / `toLocaleDateString()` — **browser locale + browser timezone**: Ticket Drawer
  Created / Lifecycle / Assignment History, Component Request cards, Build Health "Computed At",
  Plant Deactivations "Deactivated on", Dispatch Runs "When", Reports "Data as of", Exports hints,
  Snapshot banner.
- `iso.slice(0,10)` / `.slice(0,16)` — **raw UTC string, no conversion**: Leave Requests window,
  VU expected date, Voucher submitted-at, Tier Overrides expiry, Schedules plan date, Schedule
  Detail date range, Planner `planned_date` chips, Intra-day Queue "At".
- Elapsed durations (`formatInactiveDuration`, ticket "Age", cross-zone "Age", verification
  "Nh left") — **browser clock** vs a UTC timestamp.
- The SE Planner grid builds its **7 day columns from local `getFullYear/Month/Date`** while the
  entries it places in them carry **UTC** `planned_date` strings.

**Questions for a human:**

1. What is the operating timezone of the business — IST throughout?
2. Should report "months" and "days" be IST calendar boundaries rather than UTC? (Today a
   month/day report cuts at 05:30 IST.)
3. Should the twice-daily soft-inactive snapshot split at IST noon rather than UTC noon?
4. Should date-only fields (schedule dates, planner dates, leave windows, voucher dates, override
   expiry) be rendered in IST rather than as raw UTC slices? The planner grid in particular can
   place an entry in the wrong column near midnight.
5. Is `AUTOPLANT_SOURCE_UTC_OFFSET_MIN` currently 330 in the live environment, and is the AutoPlant
   MySQL session still UTC (which is what makes `trip_creation_datetime` offset 0 correct)?
6. Is any part of the fleet outside IST?

---

## 3. Soft-delete / cancelled / archived / excluded records

### 3.1 Deactivated plants (`plant_deactivations`)

**Excluded** by `EXCLUDE_DEACTIVATED_PLANTS` in: zone-overview, fleet-summary, fleet-directory,
company-plant-overview, activity-trend (both ticket and live-inactive legs), ticket creation,
recommender dispatch. **Surfaced as a column** in the entity-mapping CSV (`plant_fsm_status`).

**Not excluded** in:
- `GET /devices` and `GET /devices/filter-options` (Device Detail list) — a deactivated plant's
  devices still appear, and the plant still appears in the filter dropdown.
- `GET /tickets` (Ticket Operations).
- `GET /dashboard/operating-mode` — **deliberate**, documented in
  `soft-inactive-count.service.ts:70-76` ("a legibility surface must show the real signal").
- `soft_inactive_count_history.recompute()` — the snapshot the trend chart reads.
- `plantDeviceStats` on the dispatch zone detail.
- All five reporting cubes.

**Question:** which of these are intentional? In particular, the operating-mode card excludes nothing
while the dashboard KPI right above it excludes deactivated plants — an operator can see a zone in
"Catch-up" mode driven by devices that do not appear in any of their counts.

### 3.2 Departed devices (`device_departures` → `device_states.is_departed`)

Excluded from `is_inactive`, `sla_bucket` and `eligible_for_uptime` at recompute. Excluded from
"Active Fleet". **Included** in the Inactive/Total denominators, Fleet Directory device counts,
Plant Deactivations `deviceCount`, dispatch `plantStats.totalDevices` and the entity-mapping CSV.
**Question:** should departed devices count toward "total devices" anywhere an operator reads a
ratio?

### 3.3 Non-operational markings

An active `non_operational_markings` row (`state ∈ CONFIRMED, ACTIVE`) forces
`eligible_for_uptime = false` in both eligibility modes, but does **not** affect `is_inactive` or
`sla_bucket`. So a Non-Op device still ages through the SLA bands and still appears in every zone
/ company / plant inactive count and bucket column.
**Question:** should a confirmed Non-Op device drop out of the inactive queues?

### 3.4 Removed / deferred batch tickets

`batch_assignment_tickets.removed_at IS NULL` is the liveness filter everywhere. `deferred_to_date`
is stored but is **only** consulted by the cross-zone sweep (`notDeferredOn`) — the Schedules,
Schedule Detail, SE Activity and dispatch surfaces do not distinguish a deferred ticket.
**Question:** should a deferred ticket still count on today's plan?

### 3.5 Cancelled / expired tier overrides

`company_tier_overrides.status` is swept hourly to `EXPIRED`, but the resolver keys on `expires_at`,
so an override goes inert the instant it expires regardless of the swept status. The Tier Overrides
page requests `status=ACTIVE` only, so an ACTIVE-but-expired row **is listed** and correctly shows
no "Winning" badge. **Confirm** that listing expired-but-unswept rows under an ACTIVE filter is
acceptable.

### 3.6 Terminal ticket statuses — two different lists

- `device.service.ts` LATERAL "latest live ticket" excludes 7 statuses: CLOSED,
  CLOSED_AUTO_RECOVERY, CLOSED_NON_OPERATIONAL, FAILED_VERIFICATION, FAILED_ACTIVATION,
  FAILED_RECOVERY, RECEIVED_AT_WAREHOUSE.
- `entity-mapping-export.service.ts` `open_ticket_count` excludes only 4: CLOSED,
  CLOSED_AUTO_RECOVERY, CLOSED_NON_OPERATIONAL, FAILED_RECOVERY.
- `plant-deactivation.service.ts` `TERMINAL_TICKET_STATUSES` also lists 4 (the same as the export).

So a `FAILED_VERIFICATION` ticket is "not live" on the Device Detail page but **is** counted as an
open ticket in the OH export. **Which list is canonical?**

### 3.7 Cross-zone DENIED AUTO rows

`SYSTEM-STATE-2026-07.md` §3h records that `listForScope` omits DENIED AUTO escalations, so the home
ZM cannot see the row they are supposed to be able to re-escalate (tracked as open issue #93).
**Confirm this is still open** — it affects what the Cross-Zone page shows.

---

## 4. Caching, materialized views, replicas, precomputed tables

There is **no Redis, no BullMQ, no read replica** (`SYSTEM-STATE-2026-07.md` §1.3). Everything below
sits between the source data and a page.

| Layer | Object | Refresh | Consumers | Staleness question |
|---|---|---|---|---|
| Derived hot row | `device_states` | every recompute (`ingestTelemetry` tick, default `*/30 * * * *`, gated by `INGESTION_SCHEDULER_ENABLED`) | almost every page | If the ingestion scheduler is off, `is_inactive` / `sla_bucket` stop ageing. **What is the live cadence today?** |
| Monthly cube | `device_downtime_summary_monthly` | cron `0 3 1 * *` (`business-fleet-uptime`), gated by `BUSINESS_SWEEPS_ENABLED`; manual `POST /reports/fleet-uptime/recompute` | Fleet Uptime everywhere, Device Detail lifetime stats + trend | The current month is only as fresh as the last recompute. **Is the current month ever recomputed intra-month?** |
| Monthly cube | `root_cause_summary_monthly` | cron `15 3 1 * *` | Root-Cause Analytics | Same; the page defaults to **the current month**, so it may be empty until the next month-start run |
| Monthly cube | `zm_performance_summary_monthly` | cron `30 3 1 * *` | ZM Scorecard | Same; page defaults to current month |
| Daily cube | `system_efficiency_summary_daily` | cron `30 1 * * *` (previous day) | System Efficiency | Page defaults to **today**, which the cube has not yet written. **Should the default be yesterday?** |
| Twice-daily history | `soft_inactive_count_history` | cron `0 6,18 * * *` | Reports soft-inactive trend; the activity-trend "inactive" series | The activity trend **mixes** a cached history series with a **live** count for the current bucket. Confirm that is the intended reading |
| Materialized view | `plant_eligible_floating_se` | refreshed by `PlantEligibleFloatingSeService` on territory edits + a refresh scheduler | recommender only (no page) | — |
| Frozen JSON | `dispatch_runs.config_snapshot` | written at run start | Run Detail "Configuration in effect"; zone-detail capacity caps | Deliberately historical |
| Frozen column | `tickets.company_tier` | stamped at ticket creation | Tickets, Drawer, Schedule Detail, Cross-Zone | Never re-stamped, so a tier change does not move existing tickets. Documented as decision Q-B |
| Frozen column | `non_operational_markings.deal_type_at_marking` | stamped at marking | Non-Op queue | — |
| Browser state | dashboard data | fetched once on mount; refetched only after a manual OH ingestion run | all dashboards | No polling except the Snapshot banner (60 s) |

**Question:** are the three month-start cubes and the daily cube expected to be recomputed on demand
(the OH-only `POST /reports/*/recompute` endpoints exist but **no UI calls them**), or should the
pages that default to the current period be changed to default to the last completed period?

---

## 5. Entity lifecycles / state machines inferred — please confirm

I inferred these from enum values, transition code and guards. None is documented in a spec I could
read.

### 5.1 Ticket (`tickets.status`), discriminated by `work_type`

- **TROUBLESHOOT:** `OPEN → VERIFICATION_PENDING → {CLOSED | FAILED_VERIFICATION}`; side paths
  `→ SUBMITTED`, `→ ESCALATED`, `→ CLOSED_AUTO_RECOVERY`, `→ CLOSED_NON_OPERATIONAL`,
  `→ CLOSED` (plant deactivation, `OPERATIONS_HEAD_OVERRIDE_CLOSE`).
- **INSTALL:** `REQUESTED → SCHEDULED → ON_SITE → FITTED → {ACTIVATED | FAILED_ACTIVATION}`.
- **RECOVERY:** `REQUESTED → SCHEDULED → ON_SITE → COLLECTED → RECEIVED_AT_WAREHOUSE → CLOSED`;
  side paths `unable_to_collect → {reschedule | FAILED_RECOVERY | escalate}`, plus a web-only
  manual close.

### 5.2 Failure cycle (`failure_cycles.state`)

`OPEN → SUBMITTED → {VERIFIED | FAILED}`; plus `WAITING_COMPONENT` (SLA paused), `REPEAT`,
`ESCALATED`. The one-active-per-device partial unique covers `OPEN, WAITING_COMPONENT, SUBMITTED,
REPEAT, ESCALATED`. Plant deactivation forces `FAILED` (explicitly not `VERIFIED`, to avoid a
false REPEAT flag).

### 5.3 Work schedule (`work_schedules.status`)

`ACTIVE` ↔ `OVERRIDDEN` are both **live**; `COMPLETED` / `PARTIAL` are terminal and excluded from
`LIVE_SCHEDULE_STATUSES`. Per `SYSTEM-STATE-2026-07.md` the column conflates lifecycle with
provenance and there is an open issue (#154) to split it. **Confirm nothing else should be treated
as live.**

### 5.4 Batch (`plant_batch_assignments.status`)

Reads filter to `AUTO_ASSIGNED` and `OVERRIDDEN` everywhere. Other enum values exist but are never
read. **What are they, and should any of them be visible?**

### 5.5 Component request

`REQUESTED → {APPROVED | REJECTED}`; `APPROVED → SHIPPED → RECEIVED`; then a ZM-confirmed resubmit
binds ownership (SOFT_OWN_ORIGINAL vs RETURN_TO_POOL for a FLOATING SE whose part went to the plant
warehouse). Out-of-order transitions are refused.

### 5.6 Non-operational marking

`AWAITING_ZM_CONFIRMATION` / `AWAITING_CUSTOMER_CONFIRMATION → CONFIRMED` (dual confirmation), with
an OH override-confirm after 7 days. The FE type also lists `ACTIVE` as a state used by the
eligibility predicate but **not** by the queue's `NonOpState` union — **is `ACTIVE` a real state?**

### 5.7 Verification run

`phase` progresses through three GPS phases; `outcome` is null until resolved, then one of
`CLOSED | CLOSED_AUTO_RECOVERY | PARTIAL_RECOVERY | FAILED_VERIFICATION | FAILED_ACTIVATION`.
`PARTIAL_RECOVERY` is **derived on read** (1–2 pings, no outcome) on the ticket drawer and review
page — but is also a first-class enum value in the outcome report. **Can a run actually store
`PARTIAL_RECOVERY`, or is that report row always zero?**

### 5.8 Cross-zone escalation

`PENDING → {APPROVED | DENIED | DEFERRED}`; a denied AUTO row can be re-escalated by the home ZM.

### 5.9 Intraday insertion

`PENDING_ACCEPTANCE → {ACCEPTED | DECLINED | TIMED_OUT}`; 3 retries → `ESCALATION_REQUIRED`.
**No admin page renders this table** — the Intra-day Queue reads `audit_logs` instead.

### 5.10 Expense voucher

`DRAFT → SUBMITTED/ZONAL_MANAGER_REVIEW → {APPROVED | REJECTED | NEEDS_CLARIFICATION} → PAID`.

### 5.11 Tier override

`ACTIVE → {EXPIRED (hourly sweep) | CANCELLED (manual)}`; effective-ness keys on `expires_at`, not
`status`.

### 5.12 Device (implied)

`devices` has no status column. A device's operational standing is the combination of
`device_states.is_departed`, `is_inactive`, `eligible_for_uptime`, `has_open_failure_cycle` and any
active `non_operational_markings` / `device_departures` row. **Is there a canonical "device state"
the business thinks in, and does the UI reflect it?**

---

## 6. Everything marked UNKNOWN

These could not be traced from code.

1. **`sla_rule_config`** (`scope`, `key`, `submitWithinMinutes`, `verifyWithinMinutes`,
   `escalateAfterMinutes`) is fully CRUD-able in Settings, but I found **no read path** where these
   values affect a displayed metric or a state transition. The SLA *buckets* come from `SLA_BANDS`
   in `@fsm/shared`, which is a different mechanism. **What consumes `sla_rule_config`?**
2. **`zones.zonal_manager_user_id`** is displayed on the Scorecard but I found no UI that sets it.
   **How is a ZM assigned to a zone?**
3. **`priority_rule_config` "active" flag** — the Settings page shows `active`, and the recommender
   uses "the active weight set", but the create form posts only `weightSetRef/component/weight`.
   **How does a weight set become active?**
4. **`zone_warehouse_stock.reserved`** — editable in the WM dashboard, subtracted in
   `available`, but `SYSTEM-STATE-2026-07.md` §2.5 records it has **no automated writer**.
   **Who is meant to set it?**
5. **`pgi_history`** has no production writer, so with `eligibility_mode = 'pgi'`
   `eligible_for_uptime` is false fleet-wide, which zeroes Fleet Uptime's eligible population, the
   soft-inactive counts and the operating-mode denominators. **Which mode is live today?** The
   `dispatch_runs.config_snapshot.settings.eligibility_mode` shown on Run Detail is the only place
   this surfaces in the UI.
6. **Which crons are actually running.** `SYSTEM-STATE-2026-07.md` §1.2 says `BUSINESS_SWEEPS_ENABLED`
   is `"true"` while `INGESTION_SCHEDULER_ENABLED` and `PARTITION_MAINTENANCE_ENABLED` are `"false"`
   in `apps/backend/.env` — I did not read the live environment. **Confirm the current values**;
   every "as of" question above depends on it.
7. **`intraday_insertions`** — a full state machine with no admin read surface. Is the Intra-day
   Queue supposed to show these (its own page copy says "System-triggered CRITICAL insertions appear
   here too", but the endpoint it calls only reads `audit_logs`)?
8. **`notifications` / `notification_deliveries`** — endpoints exist (`GET /notifications`,
   `POST /notifications/read-all`, `POST /notifications/:id/read`) and rows are written by many
   flows, but **no admin page calls them**; the bell icon has no handler. **Is an in-app
   notification surface expected?**
9. **`GET /audit-trail/tickets/:ticketId`** is implemented and role-gated but **no page calls it** —
   the Ticket Drawer builds its own timeline from `ticket_events` only, so `audit_logs` actions
   (overrides, deal-type tags, tier changes) are invisible in the UI. **Is the audit-trail viewer
   supposed to be reachable?**
10. **`GET /integration/health`** returns `source` (connectivity), `reconciliation` (source-vs-FSM
    plant/vehicle drift) and `masterSync/snapshot` freshness+age. The Build Health page renders
    **only** the build/canary subset; the reconciliation and connectivity data are never shown.
    **Should they be?**
11. **`GET /snapshots/runs`** (OH-only run history) — implemented, no UI.
12. **`GET /verification/fraud-flags`** — implemented, no UI (the Verification Review page derives
    fraud rows from `/verification/review` instead).
13. **`GET /recovery/stalled`** and **`GET /recovery/non-standard-closures`** — implemented, no UI.
14. **`GET /install/:ticketId`** — implemented, no UI.
15. **`GET /intraday-insertions`**, **`/:id/available-ses`**, **`POST /:id/manual-assign`** —
    implemented, no UI. The Action Required card "Manual assignment required (retry exhausted)" is a
    hardcoded stub even though the data exists.
16. **`GET /org/zone-mappings`** / `/pending` / `:id/map` / `:id/ignore` — the zone-crosswalk queue
    (`zone_mappings` PENDING rows) has **no admin page**; only `reapply` is called, from Plant Zones.
    **How are PENDING zone mappings meant to be triaged?**
17. **`GET /settings` / `PUT /settings/:key`** — implemented, OH-only, **no UI**. Every
    `system_settings` key is therefore curl-only.
18. **`POST /reports/{fleet-uptime,soft-inactive,root-cause,zm-scorecard,efficiency}/recompute`** —
    implemented, OH-only, **no UI**.
19. **`POST /snapshots/run`**, **`POST /integration/sync-masters`** — implemented, no UI (only the
    combined `run-pipeline` has a button).
20. **`POST /role-unavailability`** — the role-backup cascade that drives `acted_as_role` attribution
    (and therefore the entire CSM Backup Share report) has **no UI**. **How is a role marked
    unavailable in practice?**
21. **`GET /zones/:zoneId`** — a thin controller with no caller found.
22. **`/org/plants` and `/org/companies` are `@Roles('OPERATIONS_HEAD')`**, yet the Install Create
    page (ZM/CSM/OH) uses them for its plant and company pickers. I did not test this;
    **is a ZM able to create an install ticket today?**
23. **`DateRangeChips`** appears on the Dashboard, SE Activity, VU Review and Settings but no page
    reads its value. **Are these surfaces supposed to be date-filtered?**
24. **Top-bar global search and notification bell** have no handlers. **Intended?**
25. **`GET /tickets` has no pagination in the UI** — the list always shows the first 100 rows sorted
    by SLA severity, with no pager and no total. **Is a 100-row cap acceptable, or is the missing
    pager a gap?**
26. **`GET /verification/review` has no LIMIT at all** — it returns every matching run. On a mature
    dataset this is unbounded.
27. **The `runtime_lock` table** is read via `$queryRawUnsafe` and is not a Prisma model.
    **Who writes it, and what is a "fingerprint"?**
28. **`master_sync_runs.entity_stats -> 'devices' -> 'observed'`** is the sole source of the OH
    "Total Devices" KPI. I could not confirm what the master-sync writer counts into `observed`
    (all deployment statuses? pre- or post-filter?). **What exactly is this number?**
29. **`plant_deactivations` "Company" column** is the modal company across the plant's
    `device_states` rows (`ORDER BY COUNT(*) DESC LIMIT 1`). **Is "the company with the most devices
    at this plant" the right identity to show?**
30. **`company_master.ops_override`** is editable in Settings but I found no consumer.
31. **`engineer_territory_coverage.polygon`** is reserved and the map editor is rendered disabled.
    Confirm v1 is hierarchy-only.
32. **Mobile app** — every field screen is unbuilt, so ~20 backend write endpoints (troubleshoot
    submission, soft states, activity ping, van stock, day plan, vouchers, install/recovery field
    steps, intraday accept/decline) currently have **no producer**. That means several displayed
    metrics (Activity Status, root-cause distribution, verification outcomes, first-time-fix rate,
    voucher queues) have **no live input path**. **Confirm this is the expected pre-launch state**,
    because it changes what "correct" means for every one of those numbers.

---

## 7. Things that are stated in code comments but which I could not verify

These are load-bearing claims from doc-comments in the code. Flagging them so a human can confirm
rather than treating a comment as evidence.

1. `device_states.trip_creation_datetime` takes UTC offset **0** because the AutoPlant session is
   UTC, while `latest_gps_datetime` takes **+330**. Pinned by `test/autoplant-mapping.spec.ts` per
   the comment.
2. `EXCLUDE_DEACTIVATED_PLANTS` is deliberately omitted from the operating-mode read.
3. The dashboard "Critical Devices" KPI is deliberately CRITICAL-only while the scorecard column is
   deliberately a superset (Issue-122 decision).
4. `capacityUsed.used` is deliberately the whole-day count (NEW-A1).
5. `tickets.company_tier` is deliberately never re-stamped (Q-B).
6. `ZmScheduleQueryService` reasoning is deliberately gated behind "Why suggested?" while the
   SLA/tier/partial badges are an ungated separate leg (#79).
7. `LIVE_SCHEDULE_STATUSES` deliberately includes `OVERRIDDEN` (#153) — a fix for the ZM-override
   blanking the SE's day plan.
8. `commonKitStatus` deliberately returns *complete* for an SE with zero van-stock rows
   ("inventory not yet tracked — don't ground them on a data gap").
