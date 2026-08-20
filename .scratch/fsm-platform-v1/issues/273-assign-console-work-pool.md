# 273 — Assign Work Console S1: the work pool, the ledger, and one honest "assignable" predicate

Status: ready-for-agent
Type: AFK · Backend + Admin
Decision: #272 **R1** (one console), **R2** (nothing written until commit), **R3** (one predicate for
"assignable")

## Objective

An operator opening **Assign work** sees, before touching anything, how much unassigned work exists,
where it is, and — as they build a draft — how much will be left when they commit. The number on
screen is the number the commit will move.

## Current behaviour (verified)

- The top-bar **Assign SE** button (`shell/TopBar.tsx:154`) calls `navigate('/')`. It opens nothing;
  there is no `/assign` route.
- `DeviceFilterOptions.plants` is `{plantId, name, companyId}` (`api/devices.ts:133-139`). The
  operator ticks plants blind in `AssignSePanel`.
- `PlantAssignSummary.perPlant[].openUnassigned` exists but is computed **inside the write loop**
  (`override.service.ts:480`), so it is only ever reported after the fact, in a toast.
- Two different definitions of "unassigned work at a plant" are live:
  - `assignPlants` writes where `status='OPEN' AND assignment_state='UNASSIGNED'` and the ticket is
    not deferred today (`override.service.ts:466-471`, via `notDeferredOn(istDate(now))`).
  - `plantDeviceStats` counts by `assignment_state` **with no status filter**
    (`dispatch-transparency-query.service.ts:506-512`).
  Feeding the console from the second while committing through the first over-reports what the
  button does. This is R3's whole point.

## Required change

1. **Extract the predicate once.** One exported function — the OPEN + UNASSIGNED + not-deferred-today
   ticket predicate — used by both the new read and `assignPlants`' existing query. Not a copy: the
   test asserts both call sites resolve to the same ticket set for the same plant and clock.
2. **Backend read** `GET /api/schedules/assignable-work?date=YYYY-MM-DD` (manager roles, server
   zone-clamped exactly as the existing scheduler reads are). Returns company → plant tree:
   `{companyId, companyName, plants: [{plantId, plantName, openUnassigned, totalDevices,
   criticalCount, oldestInactivityHours, heldCount}]}` plus a zone total. `totalDevices` comes from
   `device_states` (the `plantDeviceStats` device leg is reusable as-is — it is only the *ticket* leg
   that carries the mismatch). `heldCount` is the tickets excluded by the deferral predicate, so the
   operator can see what is deliberately withheld rather than wonder where it went.
3. **Admin: the console shell.** Route `/assign`, nav + `RoleRoute` gated to manager roles, and the
   top-bar button pointed at it. Three-column layout per the approved design; only the work-pool
   column and the ledger are populated in this slice.
4. **Work pool column** — company groups, plant rows with the counts above, search (company / plant /
   device) and the filter chips (Critical+, work type, held). Selection at company or plant level
   adds chips to the draft.
5. **Draft + ledger, client-side (R2).** Lanes hold selected work; the header ledger shows
   `open unassigned · in this draft · left after commit · critical+ in draft` and recomputes as chips
   move. **Draft is session-local** and says so on screen (#272 open question 2 — confirm before
   building the draft model; do not invent a persisted draft).
6. **Commit, this slice only:** one `apiAssignPlants` call per lane, sequentially, reporting per lane.
   This is deliberately the existing endpoint — #275 replaces it with `assign-batch`. Ship a usable
   console now rather than blocking S1 on the write rewrite.

## Existing code to reuse

`override.service.ts` `assignPlants` query · `notDeferredOn` / `istDate` (`deferral.ts`) ·
`plantDeviceStats`' device leg · `dispatch-transparency-query.service.ts` zone-clamp pattern ·
`ZoneDispatchTable`'s company→plant grouping · `FilterSelect` / `SearchInput` / `DataTable` ·
`AssignSePanel`'s plant de-duplication (a plant serving several companies).

## Data model / API

No schema change. One new GET. No new write.

## UI surfaces

Admin: new `/assign` console (work pool + ledger + draft lanes), top-bar button re-pointed. Mobile: none.

## Reference

`docs/ui/desktop/approved-designs/assign-work-console.html` — wireframe 1, left column and header
ledger. Chip/lane grammar per #272. No v2 reference image covers this screen; the approved design is
the authority (`docs/agents/domain.md` § UI authority).

## Acceptance criteria

- [ ] One exported predicate; a test calls it and `assignPlants`' selection for the same plant and
      clock and asserts an identical ticket-id set.
- [ ] `assignable-work` returns per-plant `openUnassigned` equal to what a subsequent `assignPlants`
      on that plant actually assigns, with no ticket state changing in between.
- [ ] A ticket deferred to a future date is excluded from `openUnassigned` and counted in `heldCount`.
- [ ] A ZM receives only their own zone; CSM/OH receive every active zone. Acting-zone respected.
- [ ] The top-bar **Assign SE** button navigates to `/assign` (regression pin: it never again resolves
      to `/`).
- [ ] The ledger's "left after commit" equals `open − in draft` and updates on every chip add/remove.
- [ ] Committing a two-lane draft produces two per-lane results; a failing lane does not report the
      other as failed.

## Tests

Backend: predicate-equivalence unit test; e2e for zone clamp, deferred exclusion, count-equals-write.
Admin: component tests for ledger arithmetic, plant-row counts, top-bar navigation, per-lane result
rendering.

## Dependencies / Blocked by

**#178 (hard, for the load figures this console will grow in #274)** — not strictly required for the
work-pool counts, which are ticket-side, but do not surface any capacity number in this slice before
#178 lands. #272 open question 2 (draft persistence) must be answered before the draft model is built.

## Risks

Low–medium. The one real trap is re-deriving "assignable" a third time inside the new read; the
predicate-equivalence AC exists to make that fail loudly.

## Rollback

New route + one additive GET. Revert the top-bar target and the console is unreachable; nothing else
changes.
