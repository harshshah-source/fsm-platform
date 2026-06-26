# FE-18 — Settings parity

Status: done
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

- [x] Settings matches `26` (zone config table + role-access matrix + SLA-rules table + range chips)
- [x] Existing config CRUD (`org.*`) + optimistic updates preserved
- [x] Code-constant settings surfaced read-only where applicable — `AccessMatrixGrid` + `SlaRulesTable`
- [x] Operations-Head-only gating preserved (route-level, unchanged)

## Outcome (done — presentation-only, FE-18)

`SettingsPage` re-skinned onto `PageHeader` ("Settings" + `DateRangeChips` + role badge + logout) + a
token tab bar. All eight CRUD sections kept their structure/selectors; the visual lift came from
restyling the three shared primitives in `sections.tsx` (`Field` / `inputClass` / `btnClass`) + token
table rows, so every form `aria-label`, the `role="tab"` set, and the `org.*` CRUD + optimistic appends
are untouched.

New read-only reference panels (reference 26): **`SlaRulesTable`** (the colour-coded SLA-bucket legend,
single colour source `lib/slaBucket`, rendered above the SLA-rules CRUD) and **`AccessMatrixGrid`** (a
feature × role check/dash matrix mirroring the shell's nav scoping, on a new "Access" tab).

The reference's Zone & SE before/after **delta** columns have no backend source, so the zone/SE config
stays the live CRUD without fabricated deltas. Verified: admin `tsc --noEmit` clean · vitest **100/100**
· `vite build` OK.

## Reusable components introduced

- `AccessMatrixGrid`, `SlaRulesTable` (composition)

## Affected pages

- `SettingsPage`, `sections.tsx` (**[RP]**)

## Reference

- `docs/ui/desktop/v2-reference/26-settings.png`

## Verification

- `settings.test.tsx` green; Playwright ≈ `26`
