# FE-20 — CSM Backup-Share report parity

Status: done
Type: AFK · Frontend · Phase F5
Effort: S

> Governed by `DESIGN-SYSTEM.md` §5.1/5.6. Global DoD applies.

## What to build

Reskin `CsmApprovalSharePage` to the design system: `MetricCard`s + `BarChartCard` bound to the existing
CSM backup-share data (Issue 27 AC#5). Operations-Head-only.

## Dependencies

- FE-05

## Acceptance criteria

- [x] `MetricCard`s + `BarChartCard` render existing share data
- [x] Ops-Head-only gating + existing API preserved

## Reusable components introduced

- (consumes FE-05)

## Affected pages

- `CsmApprovalSharePage` (**[RP]**)

## Reference

- (report; follows reports chart conventions `21`/`24`)

## Verification

- `csm-approval-share.test.tsx` green

## Outcome

Presentation-only reskin of `CsmApprovalSharePage`
(`apps/admin/src/pages/reports/CsmApprovalSharePage.tsx`):

- `PageHeader` (title + the existing descriptive subtitle) replaces the bare `<h2>`/`<p>`.
- `MetricStrip` of four KPIs **derived from the already-loaded rows** (no new API call): CSM-acted
  actions, Total acted actions, Overall CSM share %, Zones tracked.
- `BarChartCard` (in a `ChartCard` titled "CSM share by zone (%)") plots per-zone `sharePct`; falls back
  to an `EmptyState` when there is no activity.
- The per-zone breakdown moved from a bespoke `<table>` to the canonical `DataTable`, **preserving** the
  `role="table"` accessible name "CSM Backup Share", the `csm-row-${zoneId}` `data-testid`, and the
  `${sharePct}%` cell text — so the locked selectors are intact.
- `apiCsmApprovalShare` and the load/error flow (`role="alert"`) are unchanged; the Operations-Head gate
  remains route-level (untouched).

Verified: `pnpm --filter @fsm/admin run typecheck` clean · `csm-approval-share.test.tsx` 1/1 · full
suite **100/100** · `vite build` OK.
