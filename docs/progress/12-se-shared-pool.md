# Progress — Issue 12: SE Shared Pool (always-visible secondary work)

> Build date: 2026-06-21 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **DONE**. All 5 acceptance criteria green. Backend **228 tests / 73 files**, `tsc --noEmit`
> clean (PostgreSQL 16 + PostGIS on :5433). Migrations: **19 applied**.

## Scope & decisions

The SE Shared Pool (CONTEXT.md *Shared Pool*; LLD `GET /api/me/shared-pool` + CoverageScopeGuard):
always-visible secondary work — OPEN, not-yet-assigned Tickets at the SE's covered plants, shown
regardless of how many Formal Assignments the SE holds, never including out-of-coverage plants.
Backend-only, matching the Issue 11 posture (RN two-list screen deferred to a mobile issue).

**One backlog-ownership fork (HITL-confirmed): retrofit Issue 11.** The `assignment_state` enum
comment + LLD say batch dispatch flips tickets to `FORMALLY_ASSIGNED`, but Issue 11 left them
`UNASSIGNED`. The Shared Pool (LLD partial index `(plant_id) WHERE status='OPEN' AND
assignment_state='UNASSIGNED'`) depends on that flip to separate committed work from pickable work.
Chosen: **retrofit `dispatchForZone` to do the flip** (with a regression test) rather than work around
it with a batch-join exclusion — matches the schema/LLD intent and keeps the Shared Pool query clean.
Issue 11's progress doc was updated to record the change.

**Coverage = union of two sources:** `se_coverage` (Dedicated / Multi-Plant) ∪ the
`plant_eligible_floating_se` MV (Floating territory). Enforced server-side; the controller scopes to
the caller's own `user_id` (never an arbitrary `se` param). Read-only — there is no Reject/pick
mutation on the pool (AC#4 satisfied by absence of a mutation surface).

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | "Assigned to Me" and Shared Pool render as separate lists | 🟢 (backend) | Distinct endpoints — `/api/schedules/me` (Issue 11) vs `/api/me/shared-pool`. **RN two-list render deferred.** |
| 2 | Shared Pool shows covered-plant open tickets with zero formal assignments | 🟢 | `getSharedPool` queries OPEN+UNASSIGNED at covered plants; not gated on assignments. `shared-pool-query.e2e-spec.ts`. |
| 3 | Out-of-coverage tickets never shown | 🟢 | Coverage-scoped query; out-of-coverage plant excluded (dedicated + floating). `shared-pool-query.e2e-spec.ts`, `shared-pool-floating.e2e-spec.ts`. |
| 4 | No Reject action on either list | 🟢 | Read-only `GET`; no mutation endpoint exists. `shared-pool-controller.e2e-spec.ts`. |
| 5 | Coverage scoping enforced server-side | 🟢 | `SharedPoolService.coveredPlantIds` (se_coverage ∪ MV); controller uses authenticated `user_id`, SE role-gated. `shared-pool-controller.e2e-spec.ts`. |

## Slice-by-slice RED→GREEN report

- **Slice 1 — Issue 11 retrofit: dispatch flips `assignment_state`.**
  - RED: added "flips dispatched tickets to FORMALLY_ASSIGNED" to `batch-dispatch.e2e-spec.ts` — tickets were left UNASSIGNED.
  - GREEN: `dispatchForZone` updates `ticket.assignment_state → FORMALLY_ASSIGNED` per dispatched ticket. 4/4.
- **Slice 2 — Shared Pool partial index.**
  - RED: `shared-pool-index.e2e-spec.ts` (1 test) — partial `(plant_id) WHERE status='OPEN' AND assignment_state='UNASSIGNED'` absent.
  - GREEN: raw-SQL migration `20260621190000_add_shared_pool_index` (+ schema note on `tickets`). 1/1.
- **Slice 3 — Shared Pool read model (coverage scoping).**
  - RED: `shared-pool-query.e2e-spec.ts` (2 tests) — `SharedPoolService` missing.
  - GREEN: `getSharedPool(seId)` → OPEN+UNASSIGNED tickets at covered plants; excludes out-of-coverage / committed / closed. 2/2.
- **Slice 4 — Floating-SE territory coverage.**
  - RED→GREEN: `shared-pool-floating.e2e-spec.ts` (1 test) — Floating SE's territory plants (via the MV) appear; out-of-territory excluded. Passed on the slice-3 union path (MV already joined). 1/1.
- **Slice 5 — `/api/me/shared-pool` controller.**
  - RED: `shared-pool-controller.e2e-spec.ts` (3 tests) — endpoint 404.
  - GREEN: `SharedPoolController` (`@Controller('me')` + `@Get('shared-pool')`, `@Roles('SERVICE_ENGINEER')`), `SharedPoolModule`, registered in `AppModule`. 200 empty / non-SE 403 / unauth 401. 3/3.

Test counts added by this issue: **+8 tests / +4 files** (backend 220→228 / 69→73; the +1 retrofit
test lives in the existing `batch-dispatch.e2e-spec.ts`).

## Deviations / deferred (read before extending)

1. **RN two-list UI deferred.** AC#1's backend is two distinct endpoints; the Expo screen that renders
   "Assigned to Me" + Shared Pool as visually separate, non-mixed lists is a later mobile issue. A
   shared view type can be lifted from `SharedPoolTicket` then.
2. **Override-assigned visibility (AC#3 parenthetical) not yet modelled.** "unless explicitly
   override-assigned" — the ZM override path that can place an out-of-coverage ticket in front of an SE
   is Issue 13; the Shared Pool itself stays strictly coverage-scoped.
3. **`expected_component` / Zone-Warehouse hints not in the payload** — the Shared Pool row is a lean
   work card (ticket / plant / tier / bucket / device); component context lands with Issues 21/22.

## How to run / verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run     # 228 green (PG16 + PostGIS on :5433)
# focused: node node_modules/vitest/vitest.mjs run test/shared-pool-index.e2e-spec.ts \
#   test/shared-pool-query.e2e-spec.ts test/shared-pool-floating.e2e-spec.ts \
#   test/shared-pool-controller.e2e-spec.ts test/batch-dispatch.e2e-spec.ts
```
