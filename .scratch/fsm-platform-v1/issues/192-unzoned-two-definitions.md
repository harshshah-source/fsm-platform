# 192 — "UNZONED" means two different things on two surfaces reading the same data

Status: ready-for-agent
Type: AFK · Backend (+ thin admin follow-through)

Filed 2026-08-04 while building the zone drill-down enrichment on `/reports/device`. Found by reading
the two implementations side by side, not by a failing test — nothing asserts the two agree.

## The inconsistency

`UNZONED` is a **real seeded zone row**. `ingestion/autoplant/mapping-table-zone-resolver.ts:24`
declares `UNZONED_ZONE_NAME = 'UNZONED'`, plants that fail zone resolution are assigned to it, and
`org/zone-mapping.service.ts:312-317` throws outright if the row is missing
(*"UNZONED holding zone … is not seeded — cannot re-apply zone mappings"*). On the dev DB it is
zone 5, and INDEX records its device count moving 4,607 → 3,620 under #119 — i.e. thousands of
devices live in it.

The dashboard aggregates agree with that: `dashboard.service.ts` joins `zones z ON z.zone_id =
p.zone_id` at every level, so UNZONED appears as an ordinary zone row with an ordinary `zone_id`, and
the Zone Performance Scorecard renders it (with `zonalManagerName` suppressed to `NA`,
`ScorecardTable.tsx:100-108`).

The device surface disagrees. `devices/device.service.ts:314`:

```ts
if (opts.zoneId === 'UNZONED') conds.push(Prisma.sql`AND p.zone_id IS NULL`);
```

and the dropdown that offers the option, `device.service.ts:365-368`:

```sql
SELECT EXISTS (SELECT 1 FROM device_states ds
  LEFT JOIN plants p ON p.plant_id = ds.plant_id
  WHERE p.zone_id IS NULL …) AS "has"
```

`p.zone_id IS NULL` is **plants with no zone at all** — a different population from the UNZONED
holding zone, and by the resolver's design a near-empty one.

## Consequence

Selecting "UNZONED" in the Device Detail zone filter does not show the UNZONED zone's devices. It
shows unzoned-by-null devices, which is approximately none. The scorecard says UNZONED holds
thousands; the device list says it holds nothing; both are reading `device_states` + `plants`.

`hasUnzoned` has the same bug, so the option's *presence* is also driven by the null population — the
dropdown can hide the entry precisely when the holding zone is full.

Not user-reported. The drill-down path from the scorecard always passes a numeric `zoneId`
(`ScorecardTable.tsx:85`), so the broken value is only reachable by picking it in the dropdown by
hand, which is why it has survived.

Third spelling, for completeness — `exports/entity-mapping-export.service.ts:100` classifies
`p.plant_id IS NULL OR p.zone_id IS NULL` as `'unzoned'`. That one is arguably correct for a
data-quality export (it is reporting on unmapped rows), but it is a third definition of the word in
the same codebase.

## What needs deciding before code

Which population should the Device Detail filter name?

1. **The holding zone** — make `UNZONED` resolve to the seeded zone row by name (or drop the special
   case entirely and let it be an ordinary numeric zone in the dropdown, which is what it is). This
   makes the device list agree with the scorecard.
2. **Genuinely-unzoned plants** — keep `p.zone_id IS NULL` but rename the option so it stops
   colliding with the holding zone's name.

(1) is almost certainly right — the scorecard is the surface operators actually drill from, and the
holding zone is the thing they are trying to look at. But the two populations are not the same set,
the word currently names both, and picking one silently changes what an existing filter returns, so
it wants a decision rather than a unilateral fix.

## Scope note

Filed from the zone drill-down work, **deliberately not fixed there** — that issue does not touch
`device.service.ts` and a fix here changes what an existing shipped filter returns. The drill-down
handles it by refusing to render its aggregate sections for `zoneId=UNZONED` (with an on-screen
explanation) rather than guessing which population the user meant.

## Acceptance criteria

- [ ] Decision recorded on which population `UNZONED` names in the device filter.
- [ ] `device.service.ts` list filter + `filterOptions.hasUnzoned` implement it consistently.
- [ ] A test asserts the device-list UNZONED count and the `zone-overview` UNZONED row describe the
      same device population (whichever definition wins), so the two surfaces cannot drift again.
- [ ] `entity-mapping-export.service.ts:100`'s `'unzoned'` classification either reuses the chosen
      definition or carries a comment saying why a data-quality export legitimately differs.
