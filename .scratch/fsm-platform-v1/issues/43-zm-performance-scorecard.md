# 43 — ZM Performance Scorecard

Status: done
Type: AFK

## What to build

The Zonal Manager Performance Scorecard (`/reports/zm-scorecard`, Operations Head / Operations Manager only). Measures the quality and impact of each ZM's decisions: overrides, override rate, override-after-ON_SITE, reassignments, split batches, deferrals, manual assignments, time-to-intervention, SLA impact of overrides, tickets improved vs delayed, SE overload caused/reduced, long-pending reduction, escalations handled, zone SLA compliance, SE utilization balance, manual-intervention vs auto-assignment success. Computed from assignment history, audit logs, ticket events, SLA outcomes, and override records — read from `zm_performance_summary_monthly` (not raw multi-year scans) via the `ZmPerformanceSummary` worker. ZM-wise comparison, zone-wise drill-down, weekly/monthly trend. This is **not** shown to the ZM and ZMs never enter their own scores.

## Acceptance criteria

- [x] Scorecard gated to Operations Head; never visible to the ZM *(OPERATIONS_HEAD only — no OPERATIONS_MANAGER role exists; ZM/CSM/SE → 403)*
- [~] All listed ZM decision-quality metrics computed *(decision-activity metrics done; outcome-causality metrics → #74 — see Disposition)*
- [x] Read from `zm_performance_summary_monthly` (no raw multi-year scans)
- [~] ZM-wise comparison, zone-wise drill-down, weekly/monthly trend *(comparison + drill-down + **monthly** trend done; **weekly** trend → #74)*
- [x] Sourced from assignment history, audit logs, ticket events, SLA outcomes, override records

## Blocked by

- #13

## Disposition

**Done — backend slice, decision-activity scope (2026-06-27).** Vertical: schema → migration → worker →
read → HTTP, 12 new e2e (4 + 3 + 5), full suite green, `tsc` clean. Outcome-causality metrics deferred to
**#74** (scoping confirmed with the user: those metrics need a decision→outcome model that does not exist).

- **Migration** `20260627100000_add_zm_performance_summary` (additive; 39 total) + `ZmPerformanceSummaryMonthly`
  model: one row per (month, zone, ZM user) holding that ZM's audited decision counts + the zone denominator
  + zone Fleet-Uptime inputs.
- **`ZmPerformanceAggregationService.computeMonth`** (`src/reports/zm-performance-aggregation.service.ts`):
  pivots `audit_logs` **native ZM actions** (`actor_role = 'ZONAL_MANAGER'`; backup-cascade acted-as actions
  excluded) into per-type counts (`BATCH_OVERRIDE_*` → removals/deferrals/reorders/swaps/reassignments/splits
  summing to `overridesTotal`; `OVERRIDE_AFTER_ON_SITE`; `CRITICAL_ASSIGN` + `MANUAL_ZM_UPDATE` →
  manual assignments); reads the zone auto-assignment denominator from `plant_batch_assignments` and the zone
  SLA inputs from `device_downtime_summary_monthly` (eligible-only). Every ZM user is zero-filled (complete
  comparison). Delete + insert per month → idempotent; on-demand, no scheduler.
- **`ReportsService.zmScorecard`**: ZM-wise comparison (metrics summed over the range), **override rate**
  (overrides ÷ zone auto-assignments) + **zone SLA compliance** (time-weighted over the range), optional
  **zone drill-down**, per-ZM **monthly trend**. Reads the summary only.
- **`/api/reports/zm-scorecard`** (`GET`) + **`/api/reports/zm-scorecard/recompute`** (`POST`), both
  **OPERATIONS_HEAD only** — never the ZM (403), not CSM/SE (403). Invalid month → 400.

**Role note:** the spec's "Operations Manager" gate maps to `OPERATIONS_HEAD` — there is no `OPERATIONS_MANAGER`
role in the enum (SERVICE_ENGINEER, ZONAL_MANAGER, CENTRAL_SERVICE_MANAGER, OPERATIONS_HEAD, WAREHOUSE_MANAGER).

**Deferred → #74 (filed, linked in INDEX):** outcome-causality metrics (tickets improved/delayed, SLA impact
of overrides, manual-vs-auto success, SE overload caused/reduced, SE utilization balance, long-pending
reduction, precise time-to-intervention, escalations-handled) + the **weekly** trend grain. Reason: no
decision→outcome linkage in the data model — a foundational addition, not a presentation gap.

**UI:** the `/reports/zm-scorecard` admin page is an FE-series surface consuming this endpoint (pattern as
#39/#40/#41 → FE chart pages).
