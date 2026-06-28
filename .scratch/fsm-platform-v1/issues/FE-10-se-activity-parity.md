# FE-10 — SE Activity parity

Status: done
Type: AFK · Frontend · Phase F3
Effort: M

> Governed by `DESIGN-SYSTEM.md` §8. Global DoD applies.

## What to build

Bring `SeManagementPage` to parity with `15`: KPI `MetricStrip` (SEs by derived Activity Status) + activity
`DataTable` (Activity/Availability/active tickets/on-site/plants/last-seen) with `StatusPill`. Set-
Availability action preserved.

## Dependencies

- FE-03, FE-04, FE-05

## Acceptance criteria

- [x] MetricStrip of derived Activity-Status counts per `15`
- [x] Activity `DataTable` with `StatusPill`/availability cells
- [x] Set-Availability action unchanged (logic + selectors)

## Outcome (done — presentation-only, FE-10)

`SeManagementPage` re-skinned onto `PageHeader` ("SE Activity" + `DateRangeChips`) + a `MetricCard` row
(BUSY/ON_SITE/AVAILABLE/OFFLINE/SHIFT_ENDING, tone-coded) + the canonical `DataTable`, with the detail
panel + Set-Availability form rebuilt on `Field`/`Input`/`FilterSelect`/`Button`.

Selector contract preserved: the `se-metric-*` cards keep their test ids (each `MetricCard` wrapped in
its testid div), the `SE Management` table `aria-label`, the `se-row-*` ids, the `SE detail` region, the
`/status/` `/window start/` labels and the `set availability` button. The Activity cell renders the
**literal** status (e.g. `BUSY`) via `Badge` with an explicit label (not `StatusPill`'s humanizer) to
honour the existing assertions, and Operations-Head stays read-only (no Set-Availability). `apiEngineers`
/ `apiEngineerDetail` / `apiSetAvailability` and the render-time count derivation are unchanged. Verified:
admin `tsc --noEmit` clean · vitest **98/98** · `vite build` OK.

## Reusable components introduced

- (consumes FE-03/04/05)

## Affected pages

- `SeManagementPage` (**[RP]**)

## Reference

- `docs/ui/desktop/v2-reference/15-se-activity.png`

## Verification

- `se-management.test.tsx` green; Playwright ≈ `15`
