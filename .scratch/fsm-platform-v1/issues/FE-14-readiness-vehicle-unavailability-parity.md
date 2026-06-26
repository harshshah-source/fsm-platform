# FE-14 — Readiness / Vehicle Unavailability parity

Status: ready-for-agent
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

- [ ] Readiness/VU table matches `10`/`11` with colour-coded status + dual-clock cells
- [ ] Status vocabulary matches current enum (no `EXPECTED_BACK`)
- [ ] ZM review actions preserved (API + selectors)

## Reusable components introduced

- `DualClockCell` (composition)

## Affected pages

- `VehicleUnavailabilityPage` (**[RP]**)

## Reference

- `10`, `11`

## Verification

- `vehicle-unavailability.test.tsx` green; Playwright ≈ `10`/`11`
