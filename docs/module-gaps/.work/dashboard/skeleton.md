# skeleton — Zone Dashboard Home (dashboard)
generated 2026-09-02 · 0 TEQ · source: gapscope.profile.json

## admin routes (declared)
- `/` — AppRoutes.tsx:77 → <DashboardHome>

## backend endpoints
### apps/backend/src/dashboard/dashboard.controller.ts  `@Controller('dashboard')`
- `GET /api/dashboard/zone-overview` → `zoneOverview()` :39
- `GET /api/dashboard/company-plant-overview` → `companyPlantOverview()` :45
- `GET /api/dashboard/zone-operations` → `zoneOperations()` :61
- `GET /api/dashboard/critical-queue` → `criticalQueue()` :71
- `GET /api/dashboard/action-required` → `actionRequired()` :89
- `GET /api/dashboard/fleet-composition` → `fleetComposition()` :103
- `GET /api/dashboard/fleet-summary` → `fleetSummary()` :110
- `GET /api/dashboard/fleet-directory` → `fleetDirectory()` :117
- `GET /api/dashboard/activity-trend` → `activityTrend()` :128

### apps/backend/src/dashboard/operating-mode.controller.ts  `@Controller('dashboard/operating-mode')`
- `GET /api/dashboard/operating-mode` → `operatingMode()` :26

### apps/backend/src/soft-state/soft-state.controller.ts  `@Controller('')`
- `POST /api/tickets/:id/soft-state` → `setSoftState()` :34
- `POST /api/me/activity-ping` → `activityPing()` :60

## backend units (services / schedulers / jobs)
- `apps/backend/src/dashboard/dashboard.service.ts` — class DashboardService:398 · zoneOverview():411 · fleetSummary():474 · fleetComposition():512 · fleetDirectory():600 · companyPlantOverview():651 · zoneOperations():743 · criticalQueue():803 · actionRequired():883 · activityTrend():1008 · switch():1105 · if():1128 · if():1129 · for():1143
- `apps/backend/src/soft-state/activity-status.ts` — if():42 · if():46 · if():47 · if():51 · if():57 · if():65
- `apps/backend/src/soft-state/soft-state-conflict.adapter.ts` — class PrismaSoftStateConflictPort:12 · activeOnSiteTicketIds():15 · activeTroubleshootStartedTicketIds():33
- `apps/backend/src/soft-state/soft-state.service.ts` — class SoftStateService:102 · advance():127 · clearExpiredViewed():139 · staleWorkWarnings():159 · activityStatusFor():194 · recordActivityPing():214 · setOnSite():226

## admin UI files
- `apps/admin/src/pages/dashboard/ActionRequiredPanel.tsx` — 56 loc · **no data hook**
- `apps/admin/src/pages/dashboard/ActivityTrendSection.tsx` — 134 loc · **no data hook**
- `apps/admin/src/pages/dashboard/CentralDashboard.tsx` — 97 loc · **no data hook**
- `apps/admin/src/pages/dashboard/CompanyPlantTable.tsx` — 1054 loc · **no data hook**
- `apps/admin/src/pages/dashboard/DashboardHero.tsx` — 126 loc · **no data hook**
- `apps/admin/src/pages/dashboard/DashboardHome.tsx` — 16 loc · **no data hook**
- `apps/admin/src/pages/dashboard/EscalationQueueList.tsx` — 84 loc · **no data hook**
- `apps/admin/src/pages/dashboard/ingestionEvents.ts` — 23 loc · **no data hook**
- `apps/admin/src/pages/dashboard/ManagerDashboard.tsx` — 163 loc · **no data hook**
- `apps/admin/src/pages/dashboard/OperationalFleetSection.tsx` — 118 loc · **no data hook**
- `apps/admin/src/pages/dashboard/OpsHeadDashboard.tsx` — 181 loc · **no data hook**
- `apps/admin/src/pages/dashboard/RunIngestionButton.tsx` — 150 loc · **no data hook**
- `apps/admin/src/pages/dashboard/ScorecardTable.tsx` — 285 loc · **no data hook**
- `apps/admin/src/pages/dashboard/WarehouseDashboard.tsx` — 264 loc · **no data hook**
- `apps/admin/src/pages/dashboard/ZmDashboard.tsx` — 150 loc · **no data hook**
- `apps/admin/src/pages/dashboard/ZoneOverviewTable.tsx` — 204 loc · **no data hook**

## admin api client calls (apps/admin/src/api)

## mobile screens
_no mobile surface declared for this module_

## tests touching this module
- `apps/backend/test/dashboard-acting-scope.e2e-spec.ts`
- `apps/backend/test/dashboard-action-required.e2e-spec.ts`
- `apps/backend/test/dashboard-activity-trend.e2e-spec.ts`
- `apps/backend/test/dashboard-company-plant.e2e-spec.ts`
- `apps/backend/test/dashboard-critical-queue.e2e-spec.ts`
- `apps/backend/test/dashboard-kpi-reconciliation.e2e-spec.ts`
- `apps/backend/test/dashboard-operating-mode.e2e-spec.ts`
- `apps/backend/test/dashboard-total-devices.e2e-spec.ts`
- `apps/backend/test/dashboard-zone-drilldown.e2e-spec.ts`
- `apps/backend/test/dashboard-zone-overview.e2e-spec.ts`
- `apps/backend/test/issue-122-dashboard-reads.e2e-spec.ts`
