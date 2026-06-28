# FE-04 — Domain badges + overlay primitives

Status: done
Type: AFK · Frontend · Phase F0
Effort: M

> Governed by `DESIGN-SYSTEM.md` §1.5/1.6/1.7/5.3/5.4. Global DoD applies.

## What to build

The status/identity badge family and the overlay primitives. Build `SLABadge`, `StatusPill`,
`EntityBadge`, `TierBadge`, `AgeChip`, `TicketCard`, `Timeline`; plus `Tabs`, `Sheet`, `Modal`, `Select`,
`DropdownMenu`. Badge colours reuse `lib/slaBucket` and the existing `CR_STATUS_CLASS` map. Prove by
swapping the `TicketsPage` table badge columns (full list reskin is FE-08).

## Dependencies

- FE-01, FE-03

## Acceptance criteria

- [x] `SLABadge` renders all 8 buckets from `lib/slaBucket`; `StatusPill tone` covers ticket/CR/recovery/non-op statuses from the §1.5 palette
- [x] `TierBadge` (A/B/C) and `AgeChip` (severity-coloured) implemented
- [x] `Sheet`/`Modal`/`Tabs` carry correct `role`/`aria-selected`/`aria-label` (consumed by drawer tests)
- [x] Tickets table swaps inline badges for `SLABadge`/`StatusPill`/`TierBadge` with no data change
- [x] All variants in `/_kitchensink`

## Reusable components introduced

- `SLABadge`, `StatusPill`, `EntityBadge`, `TierBadge`, `AgeChip`, `TicketCard`, `Timeline`, `Tabs`, `Sheet`, `Modal`, `Select`, `DropdownMenu`

## Affected pages

- `TicketsPage` (badge columns only; **[RP]**)

## Reference

- `07`, `10`, `13`, `17`, `18`, `19`, `20`, `28` (pill styles)

## Verification

- `tickets-list.test.tsx`, `ticket-detail-drawer.test.tsx` (tab roles) green
