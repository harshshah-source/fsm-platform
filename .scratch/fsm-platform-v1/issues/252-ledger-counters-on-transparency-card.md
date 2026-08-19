# 252 — Surface the two "engine did not decide" counters on the dispatch transparency zone card

Status: ready-for-agent
Type: AFK · Admin

Filed 2026-08-19 as a follow-up to **#242** (accepted-with-follow-up). #242's own `## UI surfaces`
line claimed the new ledger counts "surface through the existing dispatch transparency page without
layout change". **That was wrong, and is corrected in place in #242's file** — the transparency read
does not project either counter.

## What to build

Two `dispatch_run_zones` columns are written by the engine and read by nobody:

| Column | Written by | Means |
|---|---|---|
| `withheld_below_threshold` | #238 | The engine **deliberately did not look yet** — the device has not been silent for `se_assignment_threshold_hours`. Policy working. |
| `bucketless_dropped` | #242 | The engine **could not look** — no computed `device_states.sla_bucket` to rank on, so the ticket fell out before any decision. A data fault, not an Ops one. |

`DispatchRunZoneCard` (`dispatch-transparency-query.service.ts:26`) projects neither, so
`DispatchZoneDetailPage` cannot render them. The result is a run report on which
`recommended + unassignable` looks like the whole funnel while a large third and fourth population sit
outside it entirely. On the dev mirror at filing, **5,127 of 6,464** OPEN + UNASSIGNED Troubleshoot
tickets carried no computed bucket — the invisible class is the *majority* of the pool, not an edge.

The work is small and additive: project both columns on the zone card, render them beside
`unassignable` with labels that keep the three apart (the distinction is the whole point — folding them
together sends the wrong team), and keep `null` legible as **"not recorded"** rather than as `0`
(`bucketless_dropped` is nullable precisely so a pre-#242 run does not claim a measurement nobody
took).

## Acceptance criteria

- [ ] AC1 — `DispatchRunZoneCard` carries `withheldBelowThreshold` and `bucketlessDropped`
      (`number | null` for the latter), and the run detail response projects both.
- [ ] AC2 — The zone detail page renders both beside `unassignable`, each distinguishable from it and
      from each other; a `null` renders as "not recorded", never as `0`.
- [ ] AC3 — A run whose zone dropped N bucket-less tickets shows N on that zone's card (asserted
      end-to-end, not on the query layer alone).
- [ ] AC4 — Layout, hierarchy and role visibility follow the existing zone-card structure; no
      redesign.

## UI surfaces

`Admin: Dispatch run detail → zone card / zone detail page (modified)`. Mobile: n/a.

## Reference

**No v2 reference image exists for the dispatch transparency pages** — verified by listing
`docs/ui/desktop/v2-reference/` (28 images, none for dispatch runs). The authority for this surface is
therefore the existing built page (`apps/admin/src/pages/dispatch/DispatchZoneDetailPage.tsx` +
`ZoneDispatchTable.tsx`), whose structure is to be extended rather than redrawn. Confirm by listing the
directory rather than trusting this line.

## Blocked by

#238 ✅ and #242 ✅ (both columns must exist first). Nothing else.
