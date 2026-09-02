# skeleton — Reports & Analytics (reports)
generated 2026-09-02 · 0 TEQ · source: gapscope.profile.json

## admin routes (declared)
- `/reports` — AppRoutes.tsx:186
- `/reports/device` — AppRoutes.tsx:195
- `/reports/commissioning` — AppRoutes.tsx:223
- `/reports/root-cause` — AppRoutes.tsx:213
- `/reports/system-efficiency` — AppRoutes.tsx:232
- `/reports/zm-scorecard` — AppRoutes.tsx:241
- `/reports/csm-approval-share` — AppRoutes.tsx:250
- `/reports/fleet` — AppRoutes.tsx:204
- `/exports` — AppRoutes.tsx:317

## backend endpoints
### apps/backend/src/reports/reports.controller.ts  `@Controller('reports')`
- `GET /api/reports/commissioning/cohort` → `commissioningCohort()` :55
- `GET /api/reports/commissioning/installers` → `commissioningInstallers()` :80
- `GET /api/reports/fleet-uptime` → `fleetUptime()` :108
- `POST /api/reports/fleet-uptime/recompute` → `recompute()` :125
- `GET /api/reports/soft-inactive-trend` → `softInactiveTrend()` :133
- `POST /api/reports/soft-inactive/recompute` → `recomputeSoftInactive()` :141
- `GET /api/reports/root-cause` → `rootCause()` :149
- `POST /api/reports/root-cause/recompute` → `recomputeRootCause()` :176
- `GET /api/reports/zm-scorecard` → `zmScorecard()` :187
- `POST /api/reports/zm-scorecard/recompute` → `recomputeZmScorecard()` :194
- `GET /api/reports/efficiency` → `systemEfficiencyReport()` :205
- `GET /api/reports/work-type-mix` → `workTypeMix()` :232
- `GET /api/reports/verification-outcomes` → `verificationOutcomes()` :246
- `POST /api/reports/efficiency/recompute` → `recomputeEfficiency()` :261

### apps/backend/src/exports/exports.controller.ts  `@Controller('exports')`
- `GET /api/exports/entity-mapping/summary` → `entityMappingSummary()` :20
- `GET /api/exports/entity-mapping` → `entityMappingCsv()` :26

## backend units (services / schedulers / jobs)
- `apps/backend/src/reports/commissioning-aggregation.service.ts` — class CommissioningAggregationService:43 · cohort():54 · installQuality():155 · if():378
- `apps/backend/src/reports/fleet-uptime-aggregation.service.ts` — class FleetUptimeAggregationService:45 · computeMonth():48 · for():152
- `apps/backend/src/reports/installer-classification.ts` — if():67 · if():68 · if():70
- `apps/backend/src/reports/reports.service.ts` — class ReportsService:310 · fleetUptime():313 · softInactiveTrend():351 · rootCause():388 · zmScorecard():439 · workTypeMix():518 · verificationOutcomes():545 · systemEfficiency():626 · if():704 · if():710 · if():722 · if():725 · if():737 · if():740 · +3
- `apps/backend/src/reports/root-cause-aggregation.service.ts` — class RootCauseAnalyticsAggregationService:24 · computeMonth():27
- `apps/backend/src/reports/soft-inactive-count.service.ts` — class SoftInactiveCountService:65 · modeForZone():74 · operatingModes():95 · operatingModeForZone():119 · recompute():125
- `apps/backend/src/reports/system-efficiency-aggregation.service.ts` — class SystemEfficiencyAggregationService:28 · computeDay():31
- `apps/backend/src/reports/zm-performance-aggregation.service.ts` — class ZmPerformanceAggregationService:56 · computeMonth():59
- `apps/backend/src/exports/entity-mapping-export.service.ts` — class EntityMappingExportService:73 · toCsvStream():77 · filename():82 · summary():87 · return():151

## admin UI files
- `apps/admin/src/pages/reports/AssignSePanel.tsx` — 253 loc · **no data hook**
- `apps/admin/src/pages/reports/CommissioningCohortPage.tsx` — 756 loc · **no data hook**
- `apps/admin/src/pages/reports/CsmApprovalSharePage.tsx` — 105 loc · **no data hook**
- `apps/admin/src/pages/reports/DeviceDetailPage.tsx` — 651 loc · **no data hook**
- `apps/admin/src/pages/reports/FleetDirectoryPage.tsx` — 325 loc · **no data hook**
- `apps/admin/src/pages/reports/ReportsPage.tsx` — 343 loc · **no data hook**
- `apps/admin/src/pages/reports/RootCauseAnalyticsPage.tsx` — 80 loc · **no data hook**
- `apps/admin/src/pages/reports/SystemEfficiencyPage.tsx` — 90 loc · **no data hook**
- `apps/admin/src/pages/reports/ZmScorecardPage.tsx` — 86 loc · **no data hook**
- `apps/admin/src/pages/reports/ZoneDrilldownSection.tsx` — 467 loc · **no data hook**
- `apps/admin/src/pages/exports/ExportsPage.tsx` — 87 loc · **no data hook**

## admin api client calls (apps/admin/src/api)

## mobile screens
_no mobile surface declared for this module_

## tests touching this module
- `apps/backend/test/reports-controller.e2e-spec.ts`
