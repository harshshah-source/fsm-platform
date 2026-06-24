# 43 — ZM Performance Scorecard

Status: ready-for-agent
Type: AFK

## What to build

The Zonal Manager Performance Scorecard (`/reports/zm-scorecard`, Operations Head / Operations Manager only). Measures the quality and impact of each ZM's decisions: overrides, override rate, override-after-ON_SITE, reassignments, split batches, deferrals, manual assignments, time-to-intervention, SLA impact of overrides, tickets improved vs delayed, SE overload caused/reduced, long-pending reduction, escalations handled, zone SLA compliance, SE utilization balance, manual-intervention vs auto-assignment success. Computed from assignment history, audit logs, ticket events, SLA outcomes, and override records — read from `zm_performance_summary_monthly` (not raw multi-year scans) via the `ZmPerformanceSummary` worker. ZM-wise comparison, zone-wise drill-down, weekly/monthly trend. This is **not** shown to the ZM and ZMs never enter their own scores.

## Acceptance criteria

- [ ] Scorecard gated to Operations Head / Operations Manager; never visible to the ZM
- [ ] All listed ZM decision-quality metrics computed
- [ ] Read from `zm_performance_summary_monthly` (no raw multi-year scans)
- [ ] ZM-wise comparison, zone-wise drill-down, weekly/monthly trend
- [ ] Sourced from assignment history, audit logs, ticket events, SLA outcomes, override records

## Blocked by

- #13
