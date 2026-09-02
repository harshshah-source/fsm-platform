# dashboard · module primer (first walker, 2026-09-02) — read the shared primer first

Login and instrument: see `../_shared-primer.md`. Nothing here repeats it.

**Where the module lives.** Backend `apps/backend/src/dashboard/` — one `dashboard.controller.ts`
(9 GETs, all `@Roles('ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD')`) plus
`operating-mode.controller.ts`. Frontend `apps/admin/src/pages/dashboard/`: `DashboardHome.tsx`
diverts a WM, then `ManagerDashboard.tsx:157-161` branches to one of three bodies —
`ZmDashboard` / `CentralDashboard` / `OpsHeadDashboard`. Two finished components sit unmounted in
`apps/admin/src/components/dashboard/`.

**The gotcha that costs an hour.** `api-walk` prints only the first 2 array items, so it CANNOT
settle a whole-payload scoping question. Write a 20-line aggregator against the same login flow and
summarise `[...new Set(rows.map(r => r.zoneId))]` instead. Also: pass paths with **no** leading
slash, and prepend the slash inside your own script — Git-Bash rewrites a bare `/dashboard/...`
argument into `C:/Users/.../Git/dashboard/...` and you get a 404 that looks like a missing route.

**Seeded state, measured 2026-09-02 (all via `/api/dashboard/*`):**

| | zm.north (z1) | zm.south (z2) | csm / ops.head (all 5 zones) |
|---|---|---|---|
| critical-queue | 28 groups, 391 tickets | 25 groups, 206 tickets | 178 groups, 3038 tickets |
| company-plant-overview | 82 plants | 38 plants | 340 plants |
| fleet-summary | 9 co / 6560 devices | 8 co / 4370 devices | 33 co / 29394 devices |
| action-required | 9 cards, ALL count 0 | same | same |

`wm` and `se.north` are **403 on every dashboard endpoint** and on `/api/snapshots/latest`.
Snapshot state: run 169 SUCCESS, `dataAsOf 2026-09-01T12:00:08Z` — a ~21h-old but *successful*
snapshot, so the banner is grey, not red. To reproduce any red-banner claim you must fail a run first.

**Three fields are permanently empty by construction, not by data:** `trendPctVsPrevDay` (null,
`dashboard.service.ts:454`), `suggestedSes` (`[]`, `:851`, typed `unknown[]`), and the 5 unwired
Action-Required keys (`available:false`, `:899`). Do not chase these as data problems.
