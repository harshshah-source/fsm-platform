# Progress — Issue 21: Van Stock + Common Kit Hard Filter + Component-Blocked Queue

> Build date: 2026-06-24 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **PARTIAL (backend core done)**. Scoped per HITL: built the fully-unblocked backend +
> admin-page core; the mobile badge, kit-zero push, and the expected-component leg are deferred to their
> dependencies (see below). Backend **+14 tests / +4 files**; admin **+2 tests / +1 file**;
> `tsc --noEmit` clean both apps. Migration **24** (`add_inventory_van_stock`).

## Scope decision (HITL-confirmed 2026-06-24)

Three of the six ACs depend on not-yet-built pieces: **AC#6 push** needs the notification spine
(Issue 03, HITL/not built); **AC#5 mobile Home badge** needs the mobile ticket UI (app is still an auth
shell); **AC#2's expected-component leg** needs `expected_components` (not built). The user chose to
build the backend core now and mark the issue PARTIAL with follow-ups, rather than ship non-functional
stubs. The Common-Kit Hard Filter, Van Stock, and Component-Blocked Queue (the critical path) are
fully delivered.

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | `se_van_stock` per-component quantities tracked; Common Kit completeness computed | 🟢 | `se_van_stock` table; `InventoryService.vanStockFor` + `commonKitStatus` (shortfall list). `inventory-schema` (3), `inventory-service` (4). |
| 2 | Hard Filter drops Tickets for incomplete Common Kit or OOS expected components before scoring | 🟡 | **Common-Kit leg done** — `RecommenderService` reads real `commonKitComplete` per candidate; a kit-incomplete-only plant goes unassigned. `recommender-common-kit` (2). **Expected-component leg deferred** — needs `expected_components` (Issue 22); left as the existing pass-seam. |
| 3 | Component-Blocked Queue lists dropped Tickets with SE, missing parts, WM action status (ZM read-only) | 🟢 | `component_blocked_queue` recorded on a kit drop; `GET /api/component-blocked` (zone-scoped, manager-only) + the `/component-blocked` admin page. `component-blocked-controller` (3), `component-blocked.test.tsx` (2). |
| 4 | Rows aged > 7 days with no WM action show "Warehouse Overdue" and surface in Action Required | 🟡 | **Overdue badge done** — `warehouseOverdue` (> 7 d & PENDING) on the API + page. **Action Required cross-link deferred** to the dashboard panel (Issue 06/13). |
| 5 | Mobile shows Van Stock + Common Kit completeness badge on Home | 🟡 | **Backend done** — `GET /api/me/van-stock` returns stock + `commonKit` completeness. **Mobile Home UI deferred** (auth shell). |
| 6 | Push fires when a Common Kit item hits zero | 🔴 | **Deferred** — no notification spine (Issue 03, HITL/not built) and no consumption/decrement path (Issue 22/24) to trigger it. |

## Slice-by-slice RED→GREEN report

- **Slice 1 — schema.** `ComponentMaster`, `SeVanStock`, `ComponentBlockedQueue` + the deferred
  `common_kit_definition` → `component_master` FK; migration `20260623170000_add_inventory_van_stock`
  (uniques, `qty >= 0` CHECK, `ux_cbq_active` one-active-block-per-ticket). `inventory-schema` (3).
- **Slice 2 — InventoryService.** `vanStockFor` + `commonKitStatus` (untracked SE ⇒ complete; else
  shortfall vs active kit `min_qty`). `inventory-service` (4).
- **Slice 3 — recommender wiring.** Real `commonKitComplete` per candidate (memoised); on a kit-only
  drop the ticket is recorded on the Component-Blocked Queue with the missing parts; an assignable
  ticket resolves its block. `recommender-common-kit` (2).
- **Slices 4–5 — read surfaces.** `componentBlockedQueue` (zone-scoped, overdue flag) + `GET
  /api/component-blocked`; `GET /api/me/van-stock`; the `/component-blocked` admin page.
  `component-blocked-controller` (3), `component-blocked.test.tsx` (2).

## Deviations / decisions (read before extending)

1. **`common_kit_definition` FK backfill + org-common-kit fix.** Adding the FK exposed that the Issue 02
   `POST /api/org/common-kit` created kit rows with arbitrary `componentId`s **and never tore them
   down**, accumulating junk in the *global* kit. Fixed: `CommonKitService.upsert` now auto-provisions a
   `component_master` row, and the org-common-kit e2e tears down its kit row + component. Pre-existing
   placeholder pollution was cleaned out of the dev DB.
2. **"Untracked SE ⇒ Common-Kit complete".** An SE with **no** `se_van_stock` rows is treated as
   complete (inventory not yet provisioned — don't ground on a data gap). This keeps the Recommender
   suite green regardless of the global kit and is operationally defensible; once an SE carries
   anything, the kit check fully applies. Documented in `InventoryService.commonKitStatus`.
3. **`RecommenderService` gained a defaulted `InventoryService` param** so the 12 test files that
   construct it directly need no change; Nest injects the provider (registered in `RecommenderModule`).
4. **Component-Blocked recording is Common-Kit-only** for now (the expected-component drop reason isn't
   produced until `expected_components` lands). The queue's `wm_action_status` is a placeholder
   (`PENDING`) until the Warehouse flow (Issue 22/23) writes it.

## Follow-ups (to file / track)

- **Expected-component Hard-Filter leg** + `expected_components` (with Issue 22 WAITING_COMPONENT).
- **AC#6 push on kit-zero** — once the notification spine (Issue 03) and consumption (Issue 22/24) exist.
- **AC#5 mobile Home** Van Stock list + Common-Kit badge — with the mobile ticket screens.
- **AC#4 Action Required cross-link** — surface `warehouseOverdue` rows in the ZM dashboard panel.

## Environment note

Migration hand-written + `migrate deploy`. The FK addition initially failed on a pre-existing orphan
kit row; resolved by a placeholder-`component_master` backfill in the migration (and a dev-DB cleanup of
the historical pollution). Shadow-DB `CREATE DATABASE` remains denied to the `fsm` role.

## How to run / verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run \
  test/inventory-schema.e2e-spec.ts test/inventory-service.e2e-spec.ts \
  test/recommender-common-kit.e2e-spec.ts test/component-blocked-controller.e2e-spec.ts
cd apps/admin && node node_modules/vitest/vitest.mjs run test/component-blocked.test.tsx
```
