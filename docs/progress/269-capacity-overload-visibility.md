# #269 — Capacity overload visibility (TDD completion report)

**Date:** 2026-08-20 · **Branch:** `feat/autoplant-integration` · **Type:** AFK · Backend + Admin
**Issue:** [`.scratch/fsm-platform-v1/issues/269-capacity-overload-visibility.md`](../../.scratch/fsm-platform-v1/issues/269-capacity-overload-visibility.md)
**Sequenced as:** P8 item 14, gated behind #178 (done 2026-08-20). Unblocks P9 #274.

> Frozen once written, per the progress convention. Corrections go to INDEX / SYSTEM-STATE.

## What was wrong

`daily_capacity` has been on `ZoneEngineer` and `EngineerListRow` since Issue 13b and was rendered in
**zero** places. The automatic paths enforce it (`recommender.service.ts:406,443`); every manual path
ignores it, and nothing showed it — an overload today was discoverable only by counting an SE's batch
rows by hand. #258 **Q2** rules manual overload an administrative right, so the fix is to make the
decision *seen*, never to block it.

## The issue expected one counter. There were three.

The issue's "Current behaviour (verified)" section names `committedDayLoad` as "the one existing
whole-day counter". Verified against the tree before writing code, per the #178 lesson, and it is not:

| Where | Predicate | Disagrees by |
|---|---|---|
| `RecommenderService.committedDayLoad` (`:926-937`) | live rows, live schedule **covering the day** | — (the enforcement authority) |
| `EngineersQueryService.activeTicketCountBySe` | live rows, live schedule, **no date filter**, plus a batch-status filter | counts a still-live plan from an earlier day against today |
| `ZmScheduleRow.ticketCount` | one *schedule*'s live rows | a floating SE working two zones has two schedules |

None of the three had a denominator beside it, which is precisely why the disagreement had never
surfaced: `4` is not obviously wrong until you are told the cap is 6. #269 renders them, so they had
to be made the same number first.

**Resolution (operator-ruled at the seam-agreement step):** collapse. `src/scheduling/committed-day-load.ts`
is the one definition; the recommender delegates to it and `activeTicketCountBySe` was deleted, with
`activeTicketCount` keeping its name and the response shape unchanged — a correction to what the
number *means*, not a new field. `ScheduleRow.ticketCount` keeps its own meaning (it genuinely is a
per-schedule count) and the schedules page's new column joins the shared payload rather than reusing it.

**No batch-status filter, deliberately.** The recommender never applied one, and a PARTIAL batch's
unfinished tickets are exactly the work that still burns the day. Since #178, a resolved ticket's row
is retired at closure, so `removed_at IS NULL` already excludes finished work at the right boundary.

## Two more corrections made in place

- **"Critical queue `availableSesForManualAssign`" is not an admin picker.** It returns bare UUIDs
  (`intraday-insertion.service.ts:291`) and its modal **was never built** — there is no option to
  badge. #277 owns both halves explicitly. Operator confirmed leaving it there rather than absorbing
  a piece of #277. The admin Critical Work Queue's *own* assign control reads `ZoneEngineer` and is covered.
- **Marked at `n >= cap`, not the issue's `n > cap`.** AC-3 settles it: the engine drops a candidate
  at `used >= dailyCapacity` (`hard-filters.ts` `OVER_CAPACITY`), so an SE at exactly `6/6` is one no
  automatic path will add to. Showing them as having room would put the badge straight back into
  disagreement with the enforcement it exists to mirror.

## The v2 reference already drew this

`docs/ui/desktop/v2-reference/16-se-planner.png` carries a rightmost **`LOAD / CAP`** column reading
`13/6` in the critical tone, over an **`OVER SOFT CAP · 3 · SEs above capacity`** KPI tile. Built to
the image — one column at the far right, one tile in the existing strip, no redesign. Reference 12
(Batch Schedule Review) draws no load column; that page got the same single column and nothing else.

## Slices (red → green, one seam at a time)

| # | Seam | Red produced |
|---|---|---|
| 1 | `ZmScheduleQueryService.listZoneEngineers` → `committed` | `expected undefined to be 2` |
| 2 | picker read **vs.** a #250 dry run of the real recommender | invariant pin — green from the start, sensitivity verified (below) |
| 3 | `EngineersQueryService.listForZone` → `activeTicketCount` | `expected 4 to be 2` — **the real defect** |
| 4 | `POST /api/schedules/assign` over HTTP as a ZM | the non-gate pin (Q2) |
| 5 | `PlannerPage` `LOAD / CAP` column + `Over Capacity` tile | 3 reds |
| 6 | Critical-queue / Swap-Reassign-Split / cohort pickers | 2 reds |
| 7 | SE directory column + `AssignSePanel` roster line | 1 red |
| 8 | `SchedulesPage` `Load / Cap` column | 1 red |

**Slice 2 is the load-bearing one** and is an invariant pin rather than a red. Its sensitivity was
**verified, not asserted**: deleting the date predicate from `committedDayLoad` turns both it and
slice 1 red, and slice 2 fails in exactly the shape the defect takes in the field — the run reports
`seId: null`, *nobody available*, while two engineers demonstrably have room. The fixture is built to
discriminate (an SE at `2/3` today carrying a second still-ACTIVE plan from yesterday), not to agree.

**Slice 4 runs on the wall clock, unlike its neighbours.** `POST /schedules/assign` stamps
`new Date()` (`schedules.controller.ts:313`) and there is no clock seam on the HTTP path, so a fixture
frozen at the file's `NOW` had the endpoint quietly build a second, present-day schedule — the first
attempt measured the wrong day and read as a green 200 with an unchanged count. Recorded because the
same trap waits for any future HTTP-driven capacity test.

## One shared vocabulary on the admin side too

`src/lib/capacity.ts` (`isOverCapacity` / `formatLoad` / `engineerOptionLabel`) and
`components/ui/LoadBadge.tsx`. A surface answering "is this engineer full?" with its own inline `>`
would be the front-end half of exactly the fork the backend slice closed. The over-capacity state is
exposed as `data-over-capacity` and a `title`, not by tone alone — a colour-only treatment tells a
screen reader nothing, and it makes tests assert a class name where they should assert a meaning.
`<option>` cannot carry a badge, so pickers spell it out in words (`Amit Yadav — 8/6 · over capacity`).

## Never a gate — pinned on both sides

Backend: a ZM assigns over HTTP to an at-capacity SE with **no `confirm` and no `reasonCode`** → 200,
and the badge then reads one higher. Admin: the marked option is asserted **not disabled**, the Assign
button **enabled**, and the resulting POST body asserted to carry neither `confirm` nor `reasonCode` —
no dialog was interposed. Three issues now pin Q2; this is the pair that guards the surface where the
number is actually shown.

## Verification

- Backend `tsc` (`tsconfig.json` + `tsconfig.test.json`): clean for every file touched. The
  suite-wide pre-existing `tsconfig.test.json` errors in unrelated specs are unchanged.
- Admin `tsc`: clean (its `include` covers `src`, `test` and `vite.config.ts`).
- **Full admin suite: 102 files, 525 passed / 0 failed.** One pre-existing unhandled render error in
  `TicketDetailDrawer.tsx:440` surfaces from `ticket-drawer-tabs.test.tsx`; it reproduces with that
  spec run **alone**, neither file is modified in the working tree, and neither imports anything #269
  touches. Not this slice.
- **Full backend suite: 390 files passed / 3 skipped (393), 1923 tests passed / 0 failed / 5 skipped,
  exit 0, 671s.** Clean on the **first attempt** — no `Worker exited unexpectedly`, so
  `scripts/run-tests.mjs` had nothing to re-run and there is no #184 recovery line to check. Four of
  the new tests are this slice's; the rest of the delta from #178's 1917/388 baseline is pre-existing
  **untracked** specs sitting in the working tree from the #239 acting-zone work
  (`dashboard-acting-scope.e2e-spec.ts`, `manager-scope.spec.ts`), not this slice's.
- One existing admin test needed a scope correction, not a loosening: `planner-ist-day.test.tsx`
  asserted `headers.slice(3)` equalled the seven day columns, which the new trailing column broke.
  Its subject is *which IST days appear*, so the slice is now `slice(3, -1)` — still exact.

## Deliberately not done

- **`EngineerDetail.dayPlan` / `currentAssignments` pick the SE's newest live schedule with no date
  predicate**, so a still-live plan from an earlier day can render as "today's" on the SE detail
  panel. Same family as the defect slice 3 fixed, but it is about *which schedule is current* rather
  than about capacity, it is not a #269 acceptance criterion, and fixing it means deciding what the
  panel should show for a multi-day plan. Its own slice — filed as a follow-up in INDEX.
- The intra-day `available-ses` row shape and its never-built modal — #277, operator-confirmed.
