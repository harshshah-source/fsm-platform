# 351 — Dashboard fidelity: freshness badge, trend, operating mode, grouping, CSV, console link
Status: ready-for-agent
Type: AFK
Wave: 2 · Severity: P2 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

Seven small lies and gaps on the dashboards, each cheap on its own and together enough that a
manager cannot trust the page. "Snapshot Healthy" is a literal string (`ZmDashboard.tsx:106-108`,
`CentralDashboard.tsx:56-58`, `WarehouseDashboard.tsx:171`). `trendPctVsPrevDay` is `null`
unconditionally (`dashboard.service.ts:454`) although `SoftInactiveCountHistory` exists
(`schema.prisma:2651`). `ZoneOperatingModeCard` / `ZoneOperatingModeTable` are built and mounted
nowhere (#136 slice 3). `EscalationQueueList.tsx:16-33` flattens the company/plant groups the backend
supplies. `ZoneOverviewTable.tsx:13,19` promises a CSV export that does not exist. The ZM dashboard
lost its critical queue to `/assign` (#277) with no pointer back. `suggestedSes: []`
(`dashboard.service.ts:192,851`) is a dead field.

## Current code

- `ZmDashboard.tsx:106-108`, `CentralDashboard.tsx:56-58`, `WarehouseDashboard.tsx:171` —
  "Snapshot Healthy" literal.
- `dashboard.service.ts:454` — `trendPctVsPrevDay` always `null`; `schema.prisma:2651` —
  `SoftInactiveCountHistory` exists.
- `ZoneOperatingModeCard` / `ZoneOperatingModeTable` — built, unmounted (#136 slice 3).
- `EscalationQueueList.tsx:16-33` — groups flattened.
- `ZoneOverviewTable.tsx:13,19` — CSV export promised, absent.
- `dashboard.service.ts:192,851` — `suggestedSes: []` dead field; `api/dashboard.ts:79-90` types it.
- `useAssignDraft.ts:163` — the console draft hook the URL preset must feed.

## What to build

- New `components/SnapshotHealthBadge.tsx` reading `apiSnapshotLatest` (+ `overdue` from #348);
  mount on the three dashboards in place of the literal.
- `dashboard.service.ts:411-460` — compute the trend from the two latest history rows per zone;
  `ZoneOverviewTable.tsx:145-151` renders it.
- Mount `ZoneOperatingModeCard` on `ZmDashboard`; `ZoneOperatingModeTable` on `CentralDashboard`
  and `OpsHeadDashboard`.
- `EscalationQueueList.tsx` — group headers with `clusterSize`.
- `ZoneOverviewTable.tsx` — CSV export via `lib/csv.downloadCsv`.
- `ZmDashboard.tsx` — a Critical+ summary tile linking `/assign?filter=critical-plus`;
  `useAssignDraft.ts:163` accepts the URL preset.
- Remove `suggestedSes` from `api/dashboard.ts:79-90` and from the service.
- Tests: `dashboard-zone-overview.e2e-spec.ts`, `dashboard-operating-mode.e2e-spec.ts`, admin tests.

## Acceptance criteria

- [ ] AC1 — the badge reflects the latest snapshot status and age.
- [ ] AC2 — the trend column shows a signed % when two history rows exist.
- [ ] AC3 — operating mode is visible to ZM (own zone) and CSM/OH (all zones).
- [ ] AC4 — the escalation list is grouped with cluster counts.
- [ ] AC5 — CSV export downloads the visible rows.
- [ ] AC6 — ZM sees a Critical+ count that opens the console preset.
- [ ] AC7 — `suggestedSes` is gone from the API type and the service.

## Verification

`dashboard-zone-overview.e2e-spec.ts`, `dashboard-operating-mode.e2e-spec.ts`, admin tests (the
tests the plan names).

## UI surfaces

Admin: ZM dashboard (modified) · CSM dashboard (modified) · OH dashboard (modified) · Warehouse
dashboard (modified — badge only).

## Reference

- `docs/ui/desktop/v2-reference/01-dashboard-zonal-manager.png`
- `docs/ui/desktop/v2-reference/03-dashboard-central-service.png`
- `docs/ui/desktop/v2-reference/04-dashboard-operations-head.png`
- `docs/ui/desktop/v2-reference/05-dashboard-warehouse.png`

## Blocked by

- #348 — `overdue` on `/snapshots/latest`, consumed by the badge

## Absorbs / supersedes

- survey ids: DASH-G01, DASH-G04, DASH-G06, DASH-G07, DASH-G09, DASH-G10, DASH-G11
- existing issues: #136 slice 3 (closes into this slice when it lands)

## Decisions recorded

- **DASH-G01 (ZM dashboard has no critical work queue)** — design-superseded, not a gap to rebuild.
  #277 (DONE 2026-08-24) removed `CriticalQueue.tsx` on purpose; `/assign` is the single
  manual-assignment surface (#272 R1). This slice adds a Critical+ summary tile that links to the
  console preset — a summary + link, not a queue rebuild.
- **DASH-G11 (`suggestedSes` hardcoded empty)** — true, but populating it would re-add one-click
  assign on the dashboard, contradicting #272 R1. The field is removed, not populated.
