# 333 — `auto_escalations` counts current status, so a resolved escalation vanishes from the day
Status: done 2026-09-03 (landed inside #347) — report docs/progress/347-report-freshness-stamps-auto-escalations-cube.md
Type: AFK
Wave: 3 · Severity: P2 · Found by: #298 (CB-2) regression check, 2026-09-02

## Problem

`system_efficiency_summary_daily.auto_escalations` under-reports, and the faster managers resolve
escalations the more it under-reports. An escalation raised and answered on the same day is counted
as though it never happened, so the metric reads lowest exactly on the days the queue was busiest —
the opposite of what "auto-escalations per zone" is for (PRD system-efficiency reporting).

This was **found while verifying #298**, whose regression-risk section asked the implementer to
"confirm the cube reads creation, not current status". It does not. #298 was landed anyway because
the defect predates it (see below) and closing escalations is the correct behaviour; this issue owns
the metric.

## Root cause

`apps/backend/src/reports/system-efficiency-aggregation.service.ts:226-231` — the intra-day leg of
the auto-escalations rollup:

```sql
SELECT ${d}, zone_id, COUNT(*)::int, ${now}
FROM intraday_insertions
WHERE updated_at >= ${dayStart} AND updated_at < ${dayEnd} AND status = 'ESCALATION_REQUIRED'
GROUP BY zone_id
```

Two faults in one predicate:

- **`status` is the *current* status, not the status on day D.** Every path that resolves an
  escalation rewrites the row in place to `ACCEPTED` — `moveTickets` (#288),
  `IntradayInsertionService.manualAssign`, and now `assignTicket` / `assignLane` (#298). A row so
  resolved matches nothing, on any day.
- **`updated_at` is the resolution instant once it has been resolved**, so the row does not even
  land on the day it was raised. The window and the status filter fail in the same direction.

The **sibling leg immediately above it** (`:221-225`, cross-zone `AUTO_PLATINUM`) reads `created_at`
and no status at all — which is the correct shape, and the disagreement between two adjacent legs of
one metric is the clearest evidence this is drift rather than a decision.

## Affected files / symbols

- `apps/backend/src/reports/system-efficiency-aggregation.service.ts` — the intra-day
  auto-escalations insert (`:226-231`); the cross-zone leg at `:221-225` is the reference shape
- Read-only reference: `intraday-insertion.service.ts` (`escalateToZm` writes the row),
  `scheduling/override.service.ts` (`assignTicket`/`assignLane`/`moveTickets` resolve it)

## Intended behavior after fix

- `auto_escalations(D, zone)` counts escalations **raised** on day D in that zone, whatever happened
  to them afterwards. Same basis as the cross-zone leg it sits beside.
- Resolving an escalation never changes a historical day's number.

## Implementation boundaries

- Reporting only. Do **not** change any escalation writer, and do not stop resolving escalations —
  #288/#298 are correct and this issue exists because the metric must survive them.
- Do not widen the metric's meaning (e.g. adding "resolved within the day") in this slice; that is a
  new figure with its own definition and its own place on the report.

## DB / API / frontend impact

- DB: no schema change. `system_efficiency_summary_daily` rows for past days will change value once
  recomputed — **the recompute/backfill decision is part of this issue's ACs**, not a silent
  side-effect. Establish whether the aggregation is idempotent per day before recomputing history.
- API/frontend: none. The System Efficiency report renders whatever the cube holds.

## Dependencies

None. Independent of #298 (which is done) — this can land at any time.

## Regression risks

- `created_at` on `intraday_insertions` must actually be the escalation instant for the
  `ESCALATION_REQUIRED` rows; confirm against the writer rather than assuming (an `ASSIGNED_DIRECT`
  row is created at the same moment but must not be counted, so the `insertion_type` /
  raised-as-escalation distinction has to be expressed without leaning on current `status`).
- A row that was raised as an escalation and later resolved carries **no surviving marker** of having
  been one, once `status` is `ACCEPTED`. Check whether one exists (`insertion_type`,
  `acceptance_deadline IS NULL`, an event row) before writing the predicate — if none does, that is
  an HITL/backlog finding, not something to infer.

## Tests required

- e2e: raise an escalation on day D, resolve it the same day through `assignTicket`, run the
  aggregation for D — the count is 1, not 0. This is the exact case that reads 0 today.
- e2e: an escalation raised on D and resolved on D+1 counts on D and not on D+1.
- e2e: an `ASSIGNED_DIRECT` insertion (never escalated) counts in neither.
- The cross-zone leg keeps its existing behaviour (regression pin on the sibling that was right).

## Acceptance criteria

- [x] AC1 — an escalation resolved on the day it was raised still counts for that day.
- [x] AC2 — the intra-day and cross-zone legs of `auto_escalations` use the same basis (raised, not
      current status), stated in a comment so the next reader does not re-derive it.
- [x] AC3 — the recompute decision for historical days is recorded (applied, or deliberately not,
      with the reason) rather than left implicit.

## UI surfaces

Admin: System Efficiency report (existing — the number corrects itself; no layout change).

## Reference

n/a (no layout change).

## Blocked by

— (independent)
