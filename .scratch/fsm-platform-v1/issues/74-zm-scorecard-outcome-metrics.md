# 74 — ZM Scorecard outcome-causality metrics + weekly trend

Status: ready-for-agent
Type: AFK

## Context

Issue 43 (ZM Performance Scorecard) shipped the **decision-activity** half of the scorecard: every metric
directly attributable to a ZM's audited actions or derivable from existing summaries — overrides (total +
by type), override rate, override-after-ON_SITE, reassignments, split batches, deferrals, manual
assignments, and zone SLA compliance — all from `zm_performance_summary_monthly`.

The remaining AC-listed metrics measure the **outcome / causal impact** of those decisions, which the
current data model cannot express: there is no decision→outcome linkage, no pre/post snapshots, and no
batch-origin success flag. This issue adds that foundation and the metrics that depend on it.

## What to build

The outcome-causality metrics, plus the weekly-grain trend, layered onto the existing scorecard:

1. **Decision→outcome linkage.** A way to tie a ZM override/assignment (audit row + affected ticket/batch)
   to the subsequent ticket outcome (closed-within-SLA vs breached, time-to-close), without raw multi-year
   scans — likely a per-decision outcome snapshot written when the affected cycle closes, summarised into
   `zm_performance_summary_monthly` (or a sibling table).
2. **Metrics:**
   - Tickets improved vs delayed (outcome of overridden tickets vs a baseline).
   - SLA impact of overrides (did the override precede/avert a breach; net SLA-seconds effect).
   - Manual-intervention vs auto-assignment success rate (close-rate / within-SLA-rate by batch origin —
     `ScheduleSource` / `BatchStatus`).
   - SE overload caused/reduced (per-SE workload delta attributable to ZM changes).
   - Long-pending reduction attributable to ZM action.
   - Time-to-intervention (interval from ticket creation to the ZM's first action on it — precise).
   - SE utilization balance (variance/gap across a zone's SEs).
   - Escalations handled (ZM actions resolving ESCALATED/REPEAT cycles).
3. **Weekly trend.** Issue 43 serves the monthly trend; add a weekly grain (AC#4 "weekly/monthly trend").

## Acceptance criteria

- [ ] Decision→outcome linkage captured (no raw multi-year scans; summary-table read)
- [ ] Tickets improved vs delayed, SLA impact of overrides computed
- [ ] Manual-vs-auto success rate computed (by batch origin)
- [ ] SE overload caused/reduced, SE utilization balance, long-pending reduction computed
- [ ] Time-to-intervention + escalations-handled computed
- [ ] Weekly trend added alongside the monthly trend
- [ ] All gated to OPERATIONS_HEAD; never visible to the ZM

## Blocked by

- #43 (done)
- May need #30 (intra-day escalation chain) for full escalation attribution
