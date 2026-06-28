# FE-14 — Readiness / Vehicle Unavailability parity

Status: done
Type: AFK · Frontend · Phase F3
Effort: M

> Governed by `DESIGN-SYSTEM.md` §8/§9. Global DoD applies.

## What to build

Bring `VehicleUnavailabilityPage` to parity with `10`/`11`: KPI `MetricStrip` + colour-coded readiness
`DataTable` with dual-SLA-clock cells and `StatusPill`s (AVAILABLE_FOR_REPAIR / ON_TRIP / STALE / UNKNOWN /
WAITING_CONFIRMATION). **Omit `EXPECTED_BACK`** (removed — documented deviation). Review actions preserved.

## Dependencies

- FE-03, FE-04

## Acceptance criteria

- [x] Readiness/VU table matches `10`/`11` with colour-coded status + dual-clock cells
- [x] Status vocabulary matches current enum (no `EXPECTED_BACK`)
- [x] ZM review actions preserved (API + selectors)

## Outcome (done — presentation-only, FE-14)

`VehicleUnavailabilityPage` re-skinned onto `PageHeader` (+ `DateRangeChips`) + a tone-coded `MetricCard`
strip + the canonical `DataTable` with dual-clock cells (primary = warning + "(paused)", secondary =
critical/true-elapsed) and a `StatusPill`. The paused rows carry a warning left-accent.

`EXPECTED_BACK` is omitted (removed — documented deviation §9.2). The `vu-metric-strip` / `vu-metric-*` /
`vu-row-*` / `vu-primary-*` / `vu-secondary-*` test ids, the `Vehicle Unavailability Reports`
aria-label, the Confirm-date (edit `Field`/`Input` + Save/Cancel) and Resume-SLA manager actions, and the
ticket→drawer navigation are all preserved. `apiVehicleUnavailability` / `apiConfirmVuDate` /
`apiResumeVuSla` unchanged. Verified: admin `tsc --noEmit` clean · vitest **98/98** · `vite build` OK.

## Reusable components introduced

- `DualClockCell` (composition)

## Affected pages

- `VehicleUnavailabilityPage` (**[RP]**)

## Reference

- `10`, `11`

## Verification

- `vehicle-unavailability.test.tsx` green; Playwright ≈ `10`/`11`
