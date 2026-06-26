# FE-18 — Settings parity

Status: ready-for-agent
Type: AFK · Frontend · Phase F5
Effort: M

> Governed by `DESIGN-SYSTEM.md` §8. Global DoD applies.

## What to build

Bring `SettingsPage` + `sections.tsx` to parity with `26`: `DateRangeChips` toolbar, Zone & SE
configuration `DataTable` (with before/after deltas), Role-access matrix grid (features × roles, check/dash),
SLA-bucket-rules table (coloured bucket → range). Reuse the existing `useList` + optimistic-append pattern;
surface code-constant settings (geofence radius, PGI window).

## Dependencies

- FE-03, FE-04

## Acceptance criteria

- [ ] Settings matches `26` (zone config table + role-access matrix + SLA-rules table + range chips)
- [ ] Existing config CRUD (`org.*`) + optimistic updates preserved
- [ ] Code-constant settings surfaced read-only where applicable
- [ ] Operations-Head-only gating preserved

## Reusable components introduced

- `AccessMatrixGrid`, `SlaRulesTable` (composition)

## Affected pages

- `SettingsPage`, `sections.tsx` (**[RP]**)

## Reference

- `docs/ui/desktop/v2-reference/26-settings.png`

## Verification

- `settings.test.tsx` green; Playwright ≈ `26`
