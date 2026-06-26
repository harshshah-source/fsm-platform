# FE-10 — SE Activity parity

Status: ready-for-agent
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

- [ ] MetricStrip of derived Activity-Status counts per `15`
- [ ] Activity `DataTable` with `StatusPill`/availability cells
- [ ] Set-Availability action unchanged (logic + selectors)

## Reusable components introduced

- (consumes FE-03/04/05)

## Affected pages

- `SeManagementPage` (**[RP]**)

## Reference

- `docs/ui/desktop/v2-reference/15-se-activity.png`

## Verification

- `se-management.test.tsx` green; Playwright ≈ `15`
