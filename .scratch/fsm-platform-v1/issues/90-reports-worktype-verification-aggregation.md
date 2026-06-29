# 90 — Reports: Work-type-mix + Verification-outcome aggregation endpoints

Status: ready-for-agent
Type: AFK · Backend
Origin: FE-21 parity follow-up (2026-06-29).

## Business purpose

The Reports landing (ref `21`, FE-21) shows a **Work-type mix** panel and a **Verification outcomes**
donut. FE-21 ships every panel that has a backend source (Fleet Uptime #39, Soft-Inactive #40,
zone-overview), but these two have **no aggregation endpoint** — FE-21 renders them as gated
placeholders ("→ #90") rather than fabricating data (documented-omission pattern, cf. FE-06/07/17).
This issue adds the two read endpoints so those panels light up.

## PRD / reference

- `docs/ui/desktop/v2-reference/21-reports.png` — the Work-type-mix bar + Verification-outcomes donut.
- CONTEXT — WorkType (TROUBLESHOOT / INSTALL / RECOVERY) and VerifyOutcome
  (CLOSED / CLOSED_AUTO_RECOVERY / PARTIAL_RECOVERY / FAILED_VERIFICATION).

## API specification

- `GET /api/reports/work-type-mix` → counts by `work_type` for the scope/period
  `{ period, rows: [{ workType, count }] }` (ZM zone-scoped; CSM/OH cross-zone).
- `GET /api/reports/verification-outcomes` → distribution by `outcome`
  `{ period, rows: [{ outcome, count }] }` (same scoping).
- Both are read-only aggregations over existing `tickets` / `verification_runs`; reuse the report
  scoping + filter conventions from `ReportsService` (39–44). No new business rule.

## Acceptance criteria

- [ ] `GET /api/reports/work-type-mix` returns per-work-type counts, scoped + filterable
- [ ] `GET /api/reports/verification-outcomes` returns per-outcome distribution, scoped + filterable
- [ ] ZM zone-scoped; CSM/OH cross-zone (mirror existing ReportsController RBAC)
- [ ] FE-21's two gated panels (Work-type mix bar, Verification-outcomes donut) wired to real data

## Dependencies

- #05/#07 (tickets), #18 (verification), ReportsService (39–44). Consumes nothing new.
- Unblocks the two gated FE-21 panels (admin `ReportsPage`).

## Test plan (TDD)

- work-type-mix returns correct counts per work_type; zone scoping enforced (ZM sees own zone only).
- verification-outcomes returns all outcomes (zero-filled); CSM/OH cross-zone.
- FE: the two panels render bar/donut from the endpoints (replace the gated EmptyState).

## TDD implementation notes

- Backend-first (like 39–44): e2e for each endpoint + RBAC, then the FE wiring swaps the two
  `EmptyState` placeholders in `ReportsPage` for `BarChartCard` / `DonutChart`.

## Blocked by

- (none — all sources exist; pure aggregation + FE wiring)
