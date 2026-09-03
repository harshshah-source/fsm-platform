# 351 — Dashboard fidelity: freshness badge, trend, operating mode, grouping, CSV, console link
Status: done 2026-09-04 — report docs/progress/351-dashboard-fidelity.md
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

- [x] AC1 — the badge reflects the latest snapshot status and age.
- [x] AC2 — the trend column shows a signed % when two history rows exist.
- [x] AC3 — operating mode is visible to ZM (own zone) and CSM/OH (all zones).
- [x] AC4 — the escalation list is grouped with cluster counts.
- [x] AC5 — CSV export downloads the visible rows. **Premise was wrong** — `DataTable`'s shared
      download control already provided it (Issue 160 d3); the defect was a stale docstring. Now pinned.
- [x] AC6 — ZM sees a Critical+ count that opens the console preset.
- [x] AC7 — `suggestedSes` is gone from the API type and the service.

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

## Outcome (2026-09-04)

Done — `docs/progress/351-dashboard-fidelity.md`.

**#136 slice 3 is closed by this slice**, together with slice 2's outstanding mount: the operating-mode
card is on `ZmDashboard` and the cross-zone table on `CentralDashboard` / `OpsHeadDashboard`. Both had
been built and rendered nowhere since August, behind a deferred-wiring note about a file conflict that
had long since cleared.

Two premises in this issue were wrong and are recorded in the report:

- **AC5** — the CSV export was never absent. `ZoneOverviewTable` renders through `DataTable`, whose
  shared `TableDownloadButton` (CSV/Excel/PDF/PNG, DOM-read so it equals the post-filter view) has
  existed since Issue 160 decision 3, and `dashboard-home.test.tsx:87` already asserted it. The real
  defect at `ZoneOverviewTable.tsx:13` was a stale docstring calling the trend cell a placeholder.
- **`api/snapshots.ts` needed no change at all.** #349 shaped it so the badge is a read, not a rewrite.

`dashboard-operating-mode.e2e-spec.ts` had never exercised the CSM role that AC3 requires; that case is
added and passed on arrival.

Cited line refs had drifted: `dashboard.service.ts:454` → `:465`, `:192,851` → `:194,862`.
