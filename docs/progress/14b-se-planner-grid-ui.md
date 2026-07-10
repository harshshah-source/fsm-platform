# Progress — Issue 14b: SE Planner grid UI

> Build date: 2026-06-23 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **DONE**. All 4 acceptance criteria green. Admin **planner-grid.test.tsx, 5 tests**;
> full admin suite 43 tests / 16 files; `tsc --noEmit` clean. Backend support shipped in 14a
> (`/api/planner` + `/api/planner/plants`).

## Scope & decisions

The React admin SE Planner grid (`/engineers/planner`) on top of the Issue 14a backend
(`se_planner` CRUD + `/planner/plants` picker source + recommender soft-bias). Split out of Issue 14
(2026-06-21) so 14a could ship the backend + contract tests first — same backend-first cadence as
the 13a/13b split.

The grid is the Zonal-Manager plant-visit scheduling tool, **separate from the Day Plan**
(CONTEXT §SE Planner): rows = the zone's SEs, columns = days across a flexible multi-day window
(7-day window, honouring the flexible Schedule Cadence — CONTEXT §Schedule Cadence), each cell = the
plant-visit intents for that (SE, day). Intents are a **soft bias** to the Morning Batch (Issue 14a),
not a hard assignment — they surface alongside each SE's Batch Schedule and stay overridable at the
Schedule level (Issue 13b).

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | Multi-day grid (SE × day) supports drag-to-assign plant intents from a plant picker | 🟢 | `PlannerPage` renders a 7-day SE×day table from the zone engineer list + a plant picker; cells take a dropped plant (`onDrop` reads `text/plant-id`) and a click-to-add path. `planner-grid.test.tsx` slice 1 (rows + multi-day window) + slices 2–3 (assign). |
| 2 | Grid reads/writes planner entries via the API and reflects persisted state | 🟢 | Reads `GET /api/planner` (range) + `GET /api/planner/plants`; writes `POST`/`DELETE /api/planner` then refetches, so the grid always shows server state. Slices 2–3 (POST assign shows the chip; DELETE removes it). |
| 3 | Planner intent rows surface alongside the affected SEs' Batch Schedule | 🟢 | Each SE row carries a Batch-Schedule badge (status + ticket count) from `apiListSchedules`, or a "No batch" marker. `planner-grid.test.tsx` AC#3 test. |
| 4 | ZM scoped to own zone in the UI | 🟢 | Route guarded to manager roles (`RoleRoute`); the grid's engineer list, plant picker, and planner entries all come from the zone-scoped 14a endpoints (server enforces `plant.zoneId`/`user.zone_id`), so a ZM only ever sees their own zone. Tests render as a `ZONAL_MANAGER` session. |

## Slice-by-slice RED→GREEN report

- **Slice 1 — grid skeleton + reads.** `PlannerPage` + `api/planner.ts` typed client
  (`apiListPlannerEntries`, `apiListPlannerPlants`); SE rows from `apiZoneEngineers`, multi-day column
  window from a local-time `buildWindow` (avoids the `toISOString` UTC midnight shift). Persisted
  intents land in the matching `cell-<se>-<date>` testid. `planner-grid` slice-1 (2).
- **Slice 2 — assign (POST).** Plant picker + draggable chip + cell `onDrop`/click `+ add` →
  `apiCreatePlannerEntry` → refetch. `planner-grid` writes (1 of 2).
- **Slice 3 — remove (DELETE).** Chip `×` → `apiDeletePlannerEntry` → refetch. `planner-grid` writes
  (2 of 2).
- **Slice 4 (AC#3) — Batch Schedule surfaced.** SE row badge from `apiListSchedules`
  (`scheduleFor(seId)`), "No batch" fallback. `planner-grid` AC#3 (1).

Test counts added by this issue: **+5 tests / +1 file** (admin 38→43 / 15→16).

## Deviations / deferred (read before extending)

1. **Drag is wired but tests exercise the click path.** The cell `onDrop` + draggable picker chip
   implement HTML5 drag-to-assign (AC#1), but jsdom does not faithfully simulate native drag events,
   so the assign/remove tests drive the equivalent `+ add` / `×` button path. The drag handlers are
   present and identical in effect (both call `assign`); a real-browser drag check belongs in a future
   Playwright/e2e pass, not unit tests.
2. **Window is a fixed 7 days from today.** `WINDOW_DAYS = 7`, anchored on the local "today". A
   ZM-selectable date range / cadence picker (alternate-day, weekly start) is deferred — the backend
   range API already accepts arbitrary `dateFrom`/`dateTo`, so this is a UI-only follow-up.
3. **Zone scope is server-enforced, UI-reflected.** The page does no client-side zone filtering of its
   own — it trusts the 14a zone-scoped endpoints (same posture as 13b). An OPERATIONS_HEAD / CSM sees
   whatever those endpoints return for their scope; no cross-zone zone-selector is built here.
4. **Engineer label is the raw `engineerId`.** Rows show the engineer id, not a display name (no
   engineer-name field is surfaced by the schedules/engineers endpoint yet) — consistent with the
   13b schedule views.

## Environment note

Full admin suite occasionally shows a 1-file flake in `ticket-detail-drawer.test.tsx` (Issue 07) under
parallel load — the drawer renders "Loading…" and the assertion misses. It passes 2/2 in isolation;
this is the known fake-timer/shared-state-under-parallelism flake documented in the 2026-06-21 handoff,
**not** a 14b regression. Re-run the single file to confirm green.

## How to run / verify

```
cd apps/admin && node node_modules/vitest/vitest.mjs run test/planner-grid.test.tsx   # 5 green
cd apps/admin && node node_modules/typescript/bin/tsc --noEmit                          # clean
# backend support (14a): /api/planner, /api/planner/plants — see docs/progress/14a-se-planner-crud-bias.md
```
