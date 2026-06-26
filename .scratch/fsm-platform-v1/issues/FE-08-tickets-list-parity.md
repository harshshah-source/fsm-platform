# FE-08 — Tickets list parity

Status: done
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

- [x] Filter row uses `FilterBar` (work type/status/SLA bucket/assignment/company/plant) with `aria-label`s preserved
- [x] Dense `DataTable` matches `07` (badge columns, ID formatting, hover, row click → drawer)
- [x] No change to fetch logic / query params

## Outcome (done — presentation-only, FE-08)

`TicketsPage` re-skinned onto `PageHeader` ("Ticket Operations") + `FilterBar` (`FilterSelect` ×4 +
`SearchInput` ×2) + the canonical `DataTable`. Columns: two-line Ticket (id8 mono + device), Work Type,
two-line Plant/Company, `TierBadge`, `StatusPill`, `BucketBadge`, `AgeChip` (from `createdAt`), and the
inline condition flags. Added a loading-skeleton state.

`apiTicketsList` fetch + query params, server SLA-descending order, the `Tickets` table `aria-label`,
all six filter `aria-label`s, the `bucket-*` / `badge-*` test ids, and row-click → `/tickets/:id` drawer
navigation are all preserved (`BucketBadge` / `InlineBadges` reused unchanged). Verified: admin
`tsc --noEmit` clean · vitest **98/98** · `vite build` OK.

## Reusable components introduced

- (consumes FE-03/04; no new)

## Affected pages

- `TicketsPage` (**[RP]**)

## Reference

- `docs/ui/desktop/v2-reference/07-tickets.png`

## Verification

- `tickets-list.test.tsx` green (filter `aria-label`s intact); Playwright ≈ `07`
