# 364 — Report pages consume what the API already offers
Status: ready-for-agent
Type: AFK
Wave: 4 · Severity: P2 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

- The admin clients call five report endpoints with no parameters (`api/reports.ts:120-201`)
  while the backend accepts from / to / zone / company / plant / deviceType / SE
  (`reports.controller.ts:149-257`).
- The ZM scorecard `trend[]` is computed on the backend (`reports.service.ts:470-509`) and typed
  `unknown[]` on the client (`api/reports.ts:199`) — never drawn.
- No report number links to the rows behind it.
- The Exports hub has one card, while the finance voucher export lives only on the Vouchers page.
  Per §1 correction RPT-08: the export itself exists (`GET /vouchers/export`,
  `vouchers.controller.ts:108-116`) — this is a hub card, not an integration.

## Current code

- `apps/admin/src/api/reports.ts:120-201` — parameterless report calls; `:199` — `trend:
  unknown[]`.
- `apps/backend/src/reports/reports.controller.ts:149-257` — accepts the filter params.
- `apps/backend/src/reports/reports.service.ts:470-509` — scorecard trend computed.
- `apps/backend/src/vouchers/vouchers.controller.ts:108-116` — `GET /vouchers/export`.
- `apps/admin/src/pages/exports/ExportsPage.tsx` — single card.

## What to build

- `api/reports.ts` — param builders for the five endpoints; typed `ZmScorecardSeries` for the
  trend.
- `ReportsPage.tsx`, `RootCauseAnalyticsPage.tsx`, `SystemEfficiencyPage.tsx`,
  `ZmScorecardPage.tsx` — filter bar: zone (ZM clamped), date range, company, plant, device
  type, SE; `TrendChart` for the scorecard; row links → `/reports/fleet?zone=`,
  `/tickets?rootCause=`, `/engineers/:id`.
- `pages/exports/ExportsPage.tsx` — Finance voucher batch card → `apiExportVouchers(month)` with a
  month picker; optional `exports.controller.ts` voucher summary (row count for the month).
- Admin tests.

## Acceptance criteria
- [ ] AC1 — every filter round-trips to the API and the ZM clamp is echoed back.
- [ ] AC2 — the scorecard trend is drawn.
- [ ] AC3 — each report table row links to a filtered source list.
- [ ] AC4 — the Exports hub shows the voucher batch card with the row count for the month.

## Verification

Admin tests: filter → request params (including the ZM clamp echo), trend render, row link
targets, exports card with count.

## UI surfaces

Admin: Reports page (modified); Root Cause Analytics page (modified); System Efficiency page
(modified); ZM Performance Scorecard page (modified); Exports hub (modified — new card).

## Reference

- `docs/ui/desktop/v2-reference/21-reports.png`
- `docs/ui/desktop/v2-reference/23-root-cause-analytics.png`
- `docs/ui/desktop/v2-reference/24-system-efficiency.png`
- `docs/ui/desktop/v2-reference/25-zm-performance-scorecard.png`

## Blocked by
- #347 — report freshness stamps (`dataAsOf` on every `/reports/*` payload) + auto-escalations
  cube.

## Absorbs / supersedes
- survey ids: RPT-04, RPT-06, RPT-07, RPT-08 (re-typed per §1 to a hub card).
- existing issues: none.
