# 14b — SE Planner grid UI

Status: done
Type: AFK
Progress: docs/progress/14b-se-planner-grid-ui.md — all 4 ACs green (admin: planner-grid.test.tsx, 5 tests). 2026-06-23.

## What to build

The React admin SE Planner grid on top of the Issue 14a backend (se_planner CRUD + recommender bias).
Split out of Issue 14 (2026-06-21) so 14a could ship the backend + contract tests.

- **Planner grid** (`/engineers/planner`): rows = SEs, columns = days (multi-day / flexible cadence),
  each cell = a plant-visit intent. Reads/writes `GET|POST|DELETE /api/planner`.
- **Drag-to-assign** from a plant picker into a cell; remove/clear a cell.
- Planner entries shown alongside the Batch Schedule so plant-intent and Recommender output stay
  coherent; the entry remains overridable at the Batch Schedule level (Issue 13b).
- ZM scoped to own zone (the API enforces it; the UI reflects scope).

## Acceptance criteria

- [x] Multi-day grid (SE × day) supports drag-to-assign plant intents from a plant picker
- [x] Grid reads/writes planner entries via the API and reflects persisted state
- [x] Planner intent rows surface alongside the affected SEs' Batch Schedule
- [x] ZM scoped to own zone in the UI

## Blocked by

- #14 (14a — se_planner CRUD + recommender bias)
