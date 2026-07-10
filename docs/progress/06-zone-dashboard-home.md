# Progress — Issue 06: Zone Dashboard Home

> Build date: 2026-06-20 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **DONE**. All 6 acceptance criteria green. Backend **142 tests / 42 files**, admin
> **20 tests / 8 files**, both `tsc --noEmit` clean (local PostgreSQL 18, no Docker).

## Decisions taken (HITL, this issue)

1. **Trend % vs previous day → stubbed until Issue 40.** The daily-history table
   (`soft_inactive_count_daily`) belongs to Issue 40; Zone Overview renders live counts now and a
   neutral `—` for trend. Satisfies AC#2's "graceful for not-yet-built sources" posture.
2. **"Export to Excel" → CSV download, no install.** Agent-side `pnpm add` is FortiGate-blocked, so
   export is a Blob-based `.csv` (opens directly in Excel) — zero new dependency.

## Summary

The Zone Operations Dashboard landing (`/`, rendered inside `AdminShell`). Backend: four inline-SQL
aggregations over `device_states`/`tickets` (no MV/Redis — that infra is deferred like Issue 04's
BullMQ), all manager-role-gated with ZM self-scoped to their own zone. Frontend: the four dashboard
sections in plain Tailwind (shadcn still deferred), RTL-tested.

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | Action Required panel, urgency-ordered, graceful stubs | 🟢 | `GET /dashboard/action-required` returns the 8-card contract (all `available:false`, `count:0`) ordered by urgency; `ActionRequiredPanel` renders "coming soon" for unbuilt sources. `dashboard-action-required.e2e-spec.ts` (2), `dashboard-critical-action.test.tsx`. |
| 2 | Zone Overview per-bucket counts + trend + filter + export | 🟢 | `GET /dashboard/zone-overview`; `ZoneOverviewTable` with zone+bucket filters, CSV export, trend `—`. `dashboard-zone-overview.e2e-spec.ts` (4), `dashboard-home.test.tsx`, `dashboard-filters.test.tsx`. |
| 3 | Company/Plant Overview drill-down + filter + export | 🟢 | `GET /dashboard/company-plant-overview` (+companyId/plantId filters); `CompanyPlantTable` company→plant→device drill (device level via `/api/tickets?plantId`), company filter, CSV export. `dashboard-company-plant.e2e-spec.ts` (4), `dashboard-company-plant.test.tsx`, `dashboard-filters.test.tsx`. |
| 4 | Grouped Critical Work Queue | 🟢 | `GET /dashboard/critical-queue` groups CRITICAL+ open tickets by company/plant with `clusterSize`; `CriticalQueue` renders tickets + (stub) suggested SE + inert Assign. `dashboard-critical-queue.e2e-spec.ts` (2), `dashboard-critical-action.test.tsx`. |
| 5 | SLA colour coding; ACTIVE never appears | 🟢 | `lib/slaBucket.ts` `BUCKET_CLASS` (severity gradient); backend aggregations exclude null `sla_bucket`, so ACTIVE is never a column or value. |
| 6 | Role/zone scoping (ZM own zone; CSM/OH all) | 🟢 | Every endpoint `@Roles('ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD')`; `DashboardService` self-filters ZM to `zone_id`. SE→403, unauth→401 covered in each e2e. |

## Slices delivered

**Backend** (`src/dashboard/`): 1 zone-overview · 2 company-plant-overview (+filters) · 3 critical-queue
· 4 action-required contract. `DashboardModule` providers; `DashboardController` registered in AppModule.

**Frontend** (`apps/admin/src`): 5 dashboard shell + Zone Overview (`api/dashboard.ts`, `lib/slaBucket.ts`,
`lib/csv.ts`, `ZoneOverviewTable`, `DashboardHome`; wired into `AdminShell`) · 6 Company/Plant Overview
+ drill-down (`api/tickets.ts`, `CompanyPlantTable`) · 7 Critical Queue + Action Required panel · 8 filters.

## Deviations / deferred (read before extending)

1. **Inline SQL, not the `mv_zone_dashboard_rollup` MV + Redis cache** — deferred until that infra is
   installed. The queries are shaped to swap behind the MV later without changing the controller/views.
2. **Action Required cards are all stubs** — every source (batches→11, readiness→28, insertions→29,
   verification→18/19, component-blocked→21, waiting-component→22, non-op→35, manual-assign→30) is a
   later issue. The card contract + ordering is fixed now; each owning issue flips its card on.
3. **Grouped Critical Work Queue: suggested-SE list is empty and Assign is inert** — the Recommender
   (Issue 10) and batch dispatch / assignment (Issue 11/13) own those. The cluster-size signal is real.
4. **Company→plant→device drill reuses `/api/tickets?plantId`** — the device level shows that plant's
   open tickets. The richer device view is Issue 22 (Device Detail).
5. **Minor UI duplication** — the coloured bucket-count `<span>` is repeated in `ZoneOverviewTable` and
   `CompanyPlantTable`; a shared `BucketCell` is a candidate refactor (left to avoid testid churn now).

## How to run / verify

```
# backend (local PG18 up)
cd apps/backend && node node_modules/vitest/vitest.mjs run        # 142 green
# admin
cd apps/admin && node node_modules/vitest/vitest.mjs run          # 20 green
# demo: start backend + admin, log in as a manager role → "/" shows the Zone Operations Dashboard
#   (Action Required stubs, Zone Overview with filters + CSV, Company/Plant drill-down, Critical Queue).
```

Note: `pnpm exec` triggers a network deps-check that FortiGate blocks; run the vitest/tsc binaries
directly via `node node_modules/...`.
