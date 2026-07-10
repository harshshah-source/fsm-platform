# Progress — Issue 25: SE Management page + Activity Status + Set Availability

> Build date: 2026-06-24 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **ACCEPTED** (backend AC#1–#5 + admin `/engineers` page complete; mobile SE self-availability
> owned by the M-series, blocked-by Mobile Foundation #54).
> Backend **+4 e2e files / EngineersModule (controller + 2 services) / recommender wiring**; admin
> **+1 page / +1 api / +1 test**; `tsc --noEmit` clean both apps. Migration
> **20260624160000_add_se_availability** (landed with the prior batch).

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | SE list: derived Activity Status (render-time), coverage, ticket count, kit chip | 🟢 | `EngineersQueryService.listForZone` reuses the pure `deriveActivityStatus`; `GET /api/engineers`. `engineers-list` (4) + `engineers-availability-controller` GET (HTTP). |
| 2 | SE detail: Day Plan status, per-component Van Stock (missing in red), availability rows | 🟢 | `EngineersQueryService.getDetail`; `GET /api/engineers/:seId`. `engineers-detail` (3). Admin panel renders shortages in red. |
| 3 | Set Availability writes ON_LEAVE/OFF_SHIFT/WEEKLY_OFF/SOFT_UNAVAILABLE + window | 🟢 | `SeAvailabilityService.setAvailability` + `POST /api/engineers/:seId/availability`. `engineers-availability-controller` (HTTP) + `se-availability-service` (4). |
| 4 | Unavailable SEs excluded from Recommender candidate scoring for the window | 🟢 | `recommender.service` readiness now `available = isActive && currentStatus==='AVAILABLE'` (batched `currentStatusMany`, memoised). `recommender-availability` (2); `recommender-run` regression green. |
| 5 | ZM scoped to own zone; Operations Head has no setter role | 🟢 | Service auth (ZM own-zone / SE-self / CSM acting; never Ops Head); `zoneFilter` on list/detail. HTTP: `@Roles` excludes Ops Head from the setter; manager-read gated. |

## Slice-by-slice RED→GREEN report

- **Slice 1–2 (pre-landed).** `se_availability` schema + `SeAvailabilityService` (setAvailability + auth +
  audit, `currentStatus`/`currentStatusMany`). `se-availability-schema` (3) + `se-availability-service` (4).
- **Slice 3 — HTTP Set Availability.** `EngineersController` `POST :seId/availability` + `EngineersModule`,
  registered in AppModule; token→actor mapping, status/window validation, outcome→201/400/403/404.
  `engineers-availability-controller` (6). RED: route 404 (5/6); GREEN: controller wiring.
- **Slice 4 — Recommender exclusion (AC#4).** Injected `SeAvailabilityService` into `RecommenderService`;
  closed the availability seam in readiness. `recommender-availability` (2). RED: SE recommended despite
  ON_LEAVE; GREEN: drop on active non-AVAILABLE window → ticket UNASSIGNABLE.
- **Slice 5 — SE list (AC#1).** `EngineersQueryService.listForZone` (derived status + kit + ticket count +
  zone scope) + `GET /api/engineers`. `engineers-list` (4) + HTTP gate (4 added to controller test).
- **Slice 6 — SE detail (AC#2).** `getDetail` (Day Plan + van stock + kit + availability windows) +
  `GET /api/engineers/:seId`. `engineers-detail` (3).
- **Slice 7 — Admin page.** `SeManagementPage` (`/engineers`, v2-reference/15-se-activity): metric cards +
  SE table + detail panel + ZM/CSM Set-Availability form (hidden from Operations Head). Route + nav wired.
  `se-management.test.tsx` (4).

## Deviations / decisions

1. **Activity Status derivation reused, not duplicated.** The list/detail compose the real availability
   with active soft states + ping + shift via the pure `deriveActivityStatus` (ADR-0023). This closes the
   Issue-15 seam (`SoftStateService.activityStatusFor` still hardcodes AVAILABLE for its single-SE read;
   left as-is — out of scope, no caller depends on it for the SE list).
2. **Recommender availability is batched + memoised** per run (`currentStatusMany`), mirroring the
   Common-Kit memoisation; `available` now ANDs `isActive` with `currentStatus === 'AVAILABLE'`.
3. **`SeAvailabilityService` provided in three modules** (Engineers, Recommender) via inline providers —
   matching the existing `InventoryService` pattern (stateless, prisma-only) and avoiding a circular import.

## Parity-gate disposition

- **Admin surface built in-issue:** `/engineers` SE Management page (net-new, v2-reference/15).
- **Mobile** SE self set-availability: owned by the M-series, `blocked-by #54` (Mobile Foundation) — the
  only valid external-blocker deferral; tracked, not silent.

## How to run / verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run \
  test/se-availability-schema.e2e-spec.ts test/se-availability-service.e2e-spec.ts \
  test/engineers-availability-controller.e2e-spec.ts test/engineers-list.e2e-spec.ts \
  test/engineers-detail.e2e-spec.ts test/recommender-availability.e2e-spec.ts
cd apps/admin && node node_modules/vitest/vitest.mjs run test/se-management.test.tsx
```
