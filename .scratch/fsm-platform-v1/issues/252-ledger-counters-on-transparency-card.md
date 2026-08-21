# 252 — Surface the two "engine did not decide" counters on the dispatch transparency zone card

Status: done (2026-08-21, landed inside #259)
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

- [x] AC1 — `DispatchRunZoneCard` carries `withheldBelowThreshold` and `bucketlessDropped`
      (`number | null` for the latter), and the run detail response projects both.
- [x] AC2 — The zone detail page renders both beside `unassignable`, each distinguishable from it and
      from each other; a `null` renders as "not recorded", never as `0`.
- [x] AC3 — A run whose zone dropped N bucket-less tickets shows N on that zone's card (asserted
      end-to-end, not on the query layer alone).
- [x] AC4 — Layout, hierarchy and role visibility follow the existing zone-card structure; no
      redesign.

## Closed 2026-08-21, inside #259

Landed with #259 per INDEX's "#252's counters … overlap #259's CONTENDED rows — land them inside
whichever of those two ships first and close #252 there".

**Extended to a third column.** This issue named #238's `withheld_below_threshold` and #242's
`bucketless_dropped`. **#177's `component_blocked_withheld` has the identical defect** — written by the
engine, projected by nothing — and was added rather than left to be re-filed. It renders on the same
terms, and is omitted entirely (rather than shown as "not recorded") when a run never measured it, so
the line does not carry two "not recorded"s at once.

**Rendering.** The three use a `label: value` form rather than the `value label` of the four counters
beside them, because one of them can legitimately read "not recorded" and *"not recorded no SLA
bucket"* is not a sentence. The zone-detail subtitle is now built by a `ZoneFunnel` component
(`DispatchZoneDetailPage.tsx`) rather than an inline template string; layout, hierarchy and role
visibility are unchanged (AC4).

Proof: `apps/admin/test/dispatch-zone-detail.test.tsx` (three cases: rendered, `null` → "not recorded",
the #177 column) and `apps/backend/test/dispatch-transparency-api.e2e-spec.ts` (AC3's end-to-end
projection through `GET /api/dispatch-runs/:id/zones/:zoneId`, with NULL surviving as NULL).
Full report: [`docs/progress/259-zone-claim-admission.md`](../../../docs/progress/259-zone-claim-admission.md).

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
