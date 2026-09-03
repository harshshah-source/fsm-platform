# 371 — The mobile day plan renders the Zone Warehouse pickup stop

Status: `ready-for-agent` — filed 2026-09-04 as the surfacing half of [#366](./366-warehouse-pickup-stop.md).

**Blocked by:** #366 (done). **Design:** [`warehouse-pickup-stop.html`](../../../docs/ui/desktop/approved-designs/warehouse-pickup-stop.html)
— the desktop design, whose *grammar* this inherits; the mobile layout itself is not drawn.

## Why this exists

#366 put the pickup on the day-plan contract and rendered it on the **admin** schedule detail. The
SE's own read (`GET /api/schedules/me`) already serves it. **The mobile screen does not render it.**

So the engineer — the one person who has to physically go to the warehouse — is still the one who
cannot see the stop. They drive to the plant without the part exactly as before, and the fix exists
one layer above them.

Mobile rendering was an explicit scope boundary the operator set on #366 (decision record
[#369](./369-decision-warehouse-pickup-stop.md)), not a parity-gate dodge — but **#366 was the last
of the thirty-one slices, so nothing follows to pick this up.** Hence this issue rather than a note
in a report nobody re-reads.

## Acceptance criteria

- [ ] A day plan whose first stop is `kind: 'WAREHOUSE_PICKUP'` renders it **first, as a stop**, not
      as a banner or a footnote — the ordering is the point: the engineer cannot do stop 1 without
      the part.
- [ ] The stop names the warehouse and **the parts to collect**, with their request references.
- [ ] It renders as a *different kind* of stop, not a plant with fields missing: no ticket list, no
      device count, no SLA. The kind is legible without colour.
- [ ] A plan with no pickup renders **exactly as it does today** — this is a pure addition.
- [ ] Tests under `apps/mobile/src/navigation/screens/` cover both shapes.

## Notes for whoever takes it

- The contract is already typed: `DayPlanStop` is a discriminated union
  (`DayPlanPlantStop | DayPlanWarehousePickupStop`) in `packages/shared/src/index.ts`. Narrow on
  `kind`; do not re-derive the pickup client-side. `packages/shared`'s `dist/` is gitignored — run
  its build after pulling.
- `apps/mobile/src/navigation/screens/HomeScreen.tsx` already takes the union's narrowing from #366
  (Next Visit is deliberately still the first **plant**). Check whether that remains the right
  behaviour once the pickup is visible — an engineer's genuine next stop may now be the warehouse.
- **Open question #366 left, worth settling here:** the day-plan notification's stop count still
  counts plant stops only, left unchanged so #321's "both numbers on one basis" invariant was not
  quietly redefined. If the mobile list shows that count beside a list containing stop 0, the two
  will disagree and somebody has to rule on which basis wins.
- Read `docs/ui/mobile/` for the authoritative references before changing the screen; match the
  existing grammar, do not redesign.
