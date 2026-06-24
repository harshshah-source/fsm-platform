# 42 — System Efficiency Report

Status: ready-for-agent
Type: AFK

## What to build

The System Efficiency Report (`/reports/efficiency`) measuring end-to-end operational performance: devices detected, Failure Cycles, tickets auto-created, auto-assignment success rate, manual assignment rate, ZM override rate, stage times (detection-to-ticket, ticket-to-assignment, assignment-to-ON_SITE, ON_SITE-to-submission, submission-to-verification), total/average downtime, SLA compliance %, pause and aging counts, repeat-failure rate, first-time-fix rate, failed-verification rate, auto-recovery rate, warehouse fulfilment time, recovery closure time, and auto-escalations triggered per zone. Filterable by Fleet / Zone / Company / Plant / device type / SE / time period; served from `system_efficiency_summary_daily` (summary tables for long ranges) via the `SystemEfficiencySummary` worker.

## Acceptance criteria

- [ ] All listed efficiency metrics computed and rendered
- [ ] Filterable by Fleet / Zone / Company / Plant / device type / SE / time period
- [ ] Served from `system_efficiency_summary_daily` for long ranges (no raw multi-year scans)
- [ ] Auto-assignment vs manual-assignment and override rates shown
- [ ] Auto-escalations per zone included

## Blocked by

- #08
- #18
- #30
