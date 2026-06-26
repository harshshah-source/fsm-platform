# FE-08 — Tickets list parity

Status: ready-for-agent
Type: AFK · Frontend · Phase F2
Effort: S/M

> Governed by `DESIGN-SYSTEM.md` §8. Global DoD applies.

## What to build

Bring `TicketsPage` to parity with `07`: filter chips/controls via `FilterBar`, dense badge-rich
`DataTable` (SLABadge/StatusPill/TierBadge/AgeChip + two-line ID cells). Same filter state and query
params; server still returns rows pre-sorted + zone-scoped.

## Dependencies

- FE-04

## Acceptance criteria

- [ ] Filter row uses `FilterBar` (work type/status/SLA bucket/assignment/company/plant) with `aria-label`s preserved
- [ ] Dense `DataTable` matches `07` (badge columns, ID formatting, hover, row click → drawer)
- [ ] No change to fetch logic / query params

## Reusable components introduced

- (consumes FE-03/04; no new)

## Affected pages

- `TicketsPage` (**[RP]**)

## Reference

- `docs/ui/desktop/v2-reference/07-tickets.png`

## Verification

- `tickets-list.test.tsx` green (filter `aria-label`s intact); Playwright ≈ `07`
