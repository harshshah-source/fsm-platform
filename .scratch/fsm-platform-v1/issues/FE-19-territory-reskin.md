# FE-19 — Territory page reskin

Status: ready-for-agent
Type: AFK · Frontend · Phase F5
Effort: S

> Governed by `DESIGN-SYSTEM.md`. Global DoD applies.

## What to build

Reskin `TerritoryPage` list/config to the design system (tokens, `DataTable`, `SectionCard`). The polygon
map-drawing editor remains a **separate deferred issue** (Issue 09 spatial-editor follow-up) — note the
placeholder in-page.

## Dependencies

- FE-03

## Acceptance criteria

- [ ] Territory/coverage config reskinned to tokens + `DataTable`
- [ ] Polygon editor left as a clearly-labelled deferred placeholder (no behaviour change)
- [ ] Existing coverage API + selectors preserved

## Reusable components introduced

- (consumes FE-03)

## Affected pages

- `TerritoryPage` (**[RP]**)

## Reference

- (org config — no dedicated v2 screen; follows DataTable conventions)

## Verification

- `territory-page.test.tsx` green
