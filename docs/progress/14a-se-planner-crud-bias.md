# Progress — Issue 14a: SE Planner CRUD + recommender bias

> Build date: 2026-06-21 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **DONE**. All 5 acceptance criteria green. Backend **263 tests / 85 files**, `tsc --noEmit`
> clean (PostgreSQL 16 + PostGIS on :5433). Migration **20** (`add_se_planner`).

## Scope & decisions

Issue 14 was **split** (HITL-confirmed) into **14a** (this issue — `se_planner` schema, ZM-scoped CRUD
API, recommender soft-bias + contract tests) and **14b** (the React drag-to-assign grid UI;
`14b-se-planner-grid-ui.md`). Two forks resolved up front:

1. **Backend now, grid UI as 14b** — matches the 13a/13b split and the backend-first cadence.
2. **Bias = prefer the planned SE among eligible candidates.** The Recommender selects an SE per plant
   by strict precedence (Dedicated→Multi→Floating) then hard filters — it does not score across SEs.
   So the soft bias (ADR-0022) is implemented as a **preference**: among candidates that pass hard
   filters/capacity for a plant on the run date, prefer the planner-named SE; otherwise keep
   precedence. Pure soft bias — an ineligible planned SE is ignored and a more urgent routing still
   wins. The configurable `planner_affinity_weight` (ADR-0022) maps to this binary preference in v1; a
   score-weighted term is deferred (the selection model is precedence-based, not score-ranked).

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | `se_planner` entries persisted (schema + migration) | 🟢 | `SePlanner` model + migration `20260621200000_add_se_planner` (FK chain, UQ(se,plant,date)). `se-planner-schema.e2e-spec.ts`. |
| 2 | ZM-scoped CRUD API (create / list / delete), own zone only | 🟢 | `SePlannerService` (idempotent upsert, list, remove; OUT_OF_SCOPE for foreign-zone plants) + `/api/planner`. `se-planner-crud.e2e-spec.ts`, `se-planner-controller.e2e-spec.ts`. |
| 3 | Planner biases the next batch run (soft, not a hard filter) | 🟢 | `RecommenderService.runForZone` prefers the planner-named SE among eligible candidates; falls back to precedence when ineligible/uncovered. `recommender-planner-bias.e2e-spec.ts`. |
| 4 | Biased assignment surfaces in the Batch Schedule + remains overridable | 🟢 | The biased SE's `recommendation` flows through the existing dispatch (Issue 11) into that SE's batch; override via Issue 13a. Covered by the bias test + dispatch specs. |
| 5 | ZM scoped to own zone | 🟢 | Service scopes by `plant.zoneId`; controller is manager-roled; SE gated out (403). CRUD + controller specs. |

## Slice-by-slice RED→GREEN report

- **Slice 1 — `se_planner` schema.** `SePlanner` model (se/plant FKs, `planned_date`, UQ on the triple,
  `created_by`) + migration; back-relations on EngineerMaster/Plant. `se-planner-schema` (2).
- **Slice 2 — CRUD API.** `SePlannerService` (zone-scoped upsert/list/remove) + `SePlannerController`
  (`GET|POST|DELETE /api/planner`) + `PlannerModule`. `se-planner-crud` (3), `se-planner-controller` (3).
- **Slice 3 — recommender soft bias.** `runForZone` loads `plannerForDate(zone, runDate)` and prefers
  the planned SE among hard-filter-passed candidates; precedence fallback otherwise.
  `recommender-planner-bias` (2).

Test counts added by this issue: **+10 tests / +4 files** (backend 253→263 / 81→85).

## Deviations / deferred (read before extending)

1. **Grid UI is Issue 14b** — multi-day drag-to-assign grid, plant picker, intent rows alongside the
   Batch Schedule. All ACs here are backend + contract tests.
2. **Soft bias is a preference, not a weighted score** — fits the precedence-based SE selection; a real
   `planner_affinity_weight` term in `scoreCandidate` is deferred (ADR-0022 wording) and would only
   matter if selection becomes score-ranked across SEs.
3. **`planner_deviation` logging deferred** — ADR-0022 mentions flagging when the Recommender deviates
   from a planner entry in `recommendation_history`; that table isn't built (only `recommendations`),
   so deviation logging lands with the history table.
4. **No cron** — the bias applies whenever `runForZone` is invoked (same no-scheduler posture as the
   rest of P2).

## Environment note

A crashed earlier full-suite run left orphaned rows for the Issue 06 `dashboard-company-plant` test's
**hardcoded** device_ids (`9_062_001..003`), which then failed its `device.create` (unique) and
`device.delete` (FK from leftover `failure_cycles`). Cleared the orphans (FK-safe order) and the suite
went green. That test's fixed IDs + teardown that deletes devices without first clearing dependent
failure_cycles is a latent isolation fragility worth hardening (namespace its IDs like the newer specs)
— noted for an Issue 06 follow-up; out of 14a scope.

## How to run / verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run     # 263 green (PG16 + PostGIS on :5433)
# focused: node node_modules/vitest/vitest.mjs run test/se-planner-schema.e2e-spec.ts \
#   test/se-planner-crud.e2e-spec.ts test/se-planner-controller.e2e-spec.ts \
#   test/recommender-planner-bias.e2e-spec.ts
```
