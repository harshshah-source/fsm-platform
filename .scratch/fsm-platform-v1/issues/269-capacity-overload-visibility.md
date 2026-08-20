# 269 — Capacity overload visibility (no gate — Q2 ruled manual overload an administrative right)

Status: **DONE 2026-08-20** (`docs/progress/269-capacity-overload-visibility.md`) — one shared predicate `src/scheduling/committed-day-load.ts` now serves the recommender's enforcement *and* every manager read; **three** counters collapsed, not the one the issue expected. Unblocks [#274](./274-assign-console-candidates.md) (P9), which consumes `{committed, dailyCapacity}` and defines no second counter.
Type: AFK · Backend + Admin
Decision: #258 Q2. Explicitly NOT a blocking/confirmation feature — visibility only.
Consumed by: **#274** (Assign Work Console, P9) — this issue owns the **one** `{committed,
dailyCapacity}` definition and P9 defines no second counter (#272 R9). The "existing pages, no
redesign" scope below is unchanged and not superseded: #269 is the instrumentation, P9 is the
surface it makes possible. Keep the shared-predicate AC — it is what stops the two forking.

## Objective

An SE's committed day load vs. `daily_capacity` is visible wherever a manager assigns or reviews
work, so overload is a deliberate, seen decision — never silent, never blocked.

## Current behaviour (verified)

- The automatic paths respect capacity (`recommender.service.ts:406,455`; #268 adds the intraday
  system path). Every manual path ignores it — `assignTicket`, `swapSe`, `moveTickets`,
  `assignPlants` (`override.service.ts:451-483`), same-day ADD — and **nothing shows it**: an
  overload today is discoverable only by counting batch rows by hand.
- `committedDayLoad` (`recommender.service.ts:926-937`) is the one existing whole-day counter;
  note it overcounts tickets closed mid-day until the 04:00 recycle (#178) — an accepted Phase 1
  caveat, displayed as-is and tightened when #178 lands. **#178 landed 2026-08-20, so the figure is
  honest before it is displayed and the caveat does not ship.**

**Corrected in place during implementation (verified against the tree, not assumed):**

- **"One existing whole-day counter" was wrong — there were three.** `EngineersQueryService`
  had its own (`activeTicketCountBySe`) with **no date filter** and an extra batch-status filter, so a
  still-live plan from an earlier day counted against today; `ZmScheduleRow.ticketCount` counts one
  *schedule*, so a floating SE working two zones has two of them. Both were rendered bare, with no
  denominator to make the disagreement visible. All three now route through
  `src/scheduling/committed-day-load.ts`.
- **"Critical queue `availableSesForManualAssign`" is not an admin picker.** It returns bare UUIDs
  (`intraday-insertion.service.ts:291`) and its modal **was never built** — there is no option to
  badge. #277 explicitly owns giving it a row shape and building that modal; left there, not
  duplicated here. The admin Critical Work Queue's own assign control reads `ZoneEngineer`, and is
  covered.
- **Marked at `n >= cap`, not `n > cap`.** The prose said `>`; AC-3 settles it the other way. The
  engine drops a candidate at `used >= dailyCapacity` (`hard-filters.ts` `OVER_CAPACITY`), so an SE at
  exactly `6/6` is one no automatic path will add to — showing them as having room would put the badge
  straight back into disagreement with the enforcement it exists to mirror.

## Required change

1. Backend: expose per-SE `{committed, dailyCapacity}` for a zone/day — extend
   `zm-schedule-query.service.ts` (day-plan read) and `engineers-query` rows rather than a new
   endpoint; reuse `committedDayLoad`'s predicate as one shared function (no second definition of
   "committed").
2. Admin surfaces (existing pages, no redesign):
   - SE Planner grid / ZM schedules view: per-SE `n/cap` with an over-capacity treatment when
     `n > cap`.
   - Assign/reassign/swap pickers (Critical queue `availableSesForManualAssign`, override drawers):
     the SE option shows `n/cap`, over-capacity options remain SELECTABLE (Q2) but visibly marked.
   - Dispatch transparency SE lines already show the snapshot capacity denominator — align the
     live surfaces to the same `n/cap` vocabulary.
3. Assert the NON-gate: e2e that a MANAGER-role assign to an at/over-capacity SE succeeds with no
   confirm and no new audit requirement (Q2 pinned so a future "helpful" gate fails a test).

## Existing code to reuse

`committedDayLoad`; `engineer_master.dailyCapacity` map; #13b/#14b planner-grid components;
`availableSesForManualAssign`.

## Data model / API

None / additive fields on existing manager reads.

## UI surfaces

Admin: SE Planner grid, ZM schedule view, assign pickers (badge only). Mobile: n/a.

## Reference

`docs/ui/desktop/v2-reference/` planner-grid + schedules pages (badge within existing cells).

## Acceptance criteria

- [x] Planner grid shows `committed/capacity` per SE for the selected day; over-capacity visually
      distinct. *(v2 reference 16's rightmost `LOAD / CAP` column + its `OVER SOFT CAP` KPI tile —
      built to the image. Also on the ZM Batch Schedule list and the SE Management directory.)*
- [x] Assign pickers mark over-capacity SEs and still allow selection; assignment succeeds 200.
      *(Critical queue · Swap/Reassign/Split targets · commissioning cohort · Device-Detail
      `AssignSePanel`, all through one `engineerOptionLabel`/`LoadBadge` vocabulary.)*
- [x] The committed figure equals the recommender's own count (one shared predicate — asserted by
      calling both in one test). *(Picker read vs. a #250 dry run of the real recommender, on a
      fixture where they would disagree if the predicate forked; sensitivity verified.)*
- [x] No manual path gained a capacity block or forced confirmation (regression pin). *(HTTP
      `POST /api/schedules/assign` as a ZM to an at-capacity SE, no `confirm`, no `reasonCode` → 200,
      plus the admin-side pin that the option is neither disabled nor gated behind a dialog.)*

## Tests

Backend: query-shape unit + e2e; admin: component tests for badge states.

## Dependencies / Blocked by

**#178 (closure clears assignment) is now a hard prerequisite** — upgraded by the pre-implementation
review. `committedDayLoad` has no ticket-status filter (`recommender.service.ts:926-937`), so until
#178 lands, a ticket closed at 10:00 keeps burning a capacity slot until the 04:00 recycle and the
badge would display an inflated number as fact. #268 reads the same figure for its Q-B escalation
decision, which is the second reason to fix the source before surfacing it.

## Risks

Low. The only trap is defining "committed" twice — the shared-predicate AC exists to prevent it.

## Rollback

UI/read-only; trivial.
