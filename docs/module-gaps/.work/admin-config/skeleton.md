# skeleton — Settings, Org Config & Ops Explorer (admin-config)
generated 2026-09-02 · 0 TEQ · source: gapscope.profile.json

## admin routes (declared)
- `/settings` — AppRoutes.tsx:489
- `/coverage` — AppRoutes.tsx:480
- `/plant-zones` — AppRoutes.tsx:277
- `/plant-deactivations` — AppRoutes.tsx:268
- `/ops-explorer` — AppRoutes.tsx:329
- `/assignment-threshold` — AppRoutes.tsx:299
- `/build-health` — AppRoutes.tsx:308

## backend endpoints
### apps/backend/src/org/common-kit.controller.ts  `@Controller('org/common-kit')`
- `GET /api/org/common-kit` → `list()` :20
- `POST /api/org/common-kit` → `upsert()` :25

### apps/backend/src/org/companies.controller.ts  `@Controller('org/companies')`
- `GET /api/org/companies` → `list()` :24
- `POST /api/org/companies` → `create()` :29
- `PATCH /api/org/companies/:id` → `update()` :37

### apps/backend/src/org/geography.controller.ts  `@Controller('org/geo')`
- `GET /api/org/geo/states` → `states()` :16
- `GET /api/org/geo/regions` → `regions()` :21
- `GET /api/org/geo/districts` → `districts()` :26

### apps/backend/src/org/plants.controller.ts  `@Controller('org/plants')`
- `GET /api/org/plants` → `list()` :16
- `POST /api/org/plants` → `create()` :21

### apps/backend/src/org/scoring-weights.controller.ts  `@Controller('org/scoring-weights')`
- `GET /api/org/scoring-weights/components` → `components()` :29
- `GET /api/org/scoring-weights` → `list()` :34
- `POST /api/org/scoring-weights` → `upsert()` :39

### apps/backend/src/org/se-coverage.controller.ts  `@Controller('org/engineers')`
- `GET /api/org/engineers` → `list()` :31
- `POST /api/org/engineers` → `create()` :36
- `GET /api/org/engineers` → `list()` :52
- `POST /api/org/engineers` → `add()` :57
- `DELETE /api/org/engineers/:id` → `remove()` :65

### apps/backend/src/org/se-territory.controller.ts  `@Controller('org/se-territory')`
- `GET /api/org/se-territory` → `list()` :20
- `POST /api/org/se-territory` → `add()` :25
- `DELETE /api/org/se-territory/:id` → `remove()` :33

### apps/backend/src/org/sla-rules.controller.ts  `@Controller('org/sla-rules')`
- `GET /api/org/sla-rules` → `list()` :20
- `PUT /api/org/sla-rules` → `upsert()` :25

### apps/backend/src/org/tier-overrides.controller.ts  `@Controller('org/tier-overrides')`
- `POST /api/org/tier-overrides` → `create()` :51
- `DELETE /api/org/tier-overrides/:id` → `cancel()` :68
- `GET /api/org/tier-overrides` → `list()` :79

### apps/backend/src/org/tiers.controller.ts  `@Controller('org/tiers')`
- `GET /api/org/tiers` → `list()` :17

### apps/backend/src/org/users.controller.ts  `@Controller('org/users')`
- `GET /api/org/users` → `list()` :16
- `POST /api/org/users` → `create()` :21
- `PATCH /api/org/users/:userId` → `setStatus()` :29

### apps/backend/src/org/zone-mapping.controller.ts  `@Controller('org')`
- `GET /api/org/zone-mappings` → `list()` :55
- `GET /api/org/zone-mappings/pending` → `listPending()` :61
- `POST /api/org/zone-mappings/:id/map` → `map()` :66
- `POST /api/org/zone-mappings/:id/ignore` → `ignore()` :75
- `POST /api/org/zone-mappings/reapply` → `reapply()` :81
- `GET /api/org/plant-zone-overrides` → `listOverrides()` :87
- `PUT /api/org/plant-zone-overrides` → `upsertOverride()` :93
- `GET /api/org/plant-zone-overrides/:sourcePlantId/impact` → `zoneChangeImpact()` :110
- `DELETE /api/org/plant-zone-overrides/:sourcePlantId` → `deleteOverride()` :121

### apps/backend/src/org/zones.controller.ts  `@Controller('org/zones')`
- `GET /api/org/zones` → `list()` :25
- `POST /api/org/zones` → `create()` :31

### apps/backend/src/settings/assignment-threshold.controller.ts  `@Controller('settings/assignment-threshold')`
- `GET /api/settings/assignment-threshold` → `get()` :69
- `PUT /api/settings/assignment-threshold` → `set()` :76
- `POST /api/settings/assignment-threshold/lock` → `lock()` :84
- `DELETE /api/settings/assignment-threshold/lock` → `unlock()` :90
- `POST /api/settings/assignment-threshold/revert` → `revert()` :97

### apps/backend/src/settings/settings.controller.ts  `@Controller('settings')`
- `GET /api/settings` → `list()` :24
- `PUT /api/settings/:key` → `update()` :29

### apps/backend/src/zones/zones.controller.ts  `@Controller('zones')`
- `GET /api/zones/:zoneId` → `getZone()` :8

### apps/backend/src/ops-explorer/ops-explorer.controller.ts  `@Controller('ops-explorer')`
- `GET /api/ops-explorer/meta` → `meta()` :68
- `GET /api/ops-explorer/datasets/:key` → `dataset()` :93
- `POST /api/ops-explorer/datasets/:key/query` → `query()` :99
- `POST /api/ops-explorer/datasets/:key/export` → `export()` :116
- `GET /api/ops-explorer/reconciliation` → `reconcile()` :158

### apps/backend/src/plant-deactivation/plant-deactivation.controller.ts  `@Controller('plants')`
- `GET /api/plants/deactivations` → `list()` :16
- `POST /api/plants/:plantId/deactivate` → `deactivate()` :22
- `POST /api/plants/:plantId/reactivate` → `reactivate()` :40

## backend units (services / schedulers / jobs)
- `apps/backend/src/org/common-kit.service.ts` — class CommonKitService:25 · list():31 · upsert():37
- `apps/backend/src/org/companies.service.ts` — class CompaniesService:34 · list():40 · create():46 · update():80
- `apps/backend/src/org/effective-tier.ts` — if():25 · if():57 · for():64
- `apps/backend/src/org/geography.service.ts` — class GeographyService:22 · listStates():26 · listRegions():34 · listDistricts():42
- `apps/backend/src/org/org-seed.ts` — for():134 · for():142 · if():173 · for():177 · for():186 · for():195 · for():213 · for():223 · for():248
- `apps/backend/src/org/plant-eligibility-refresh-scheduler.service.ts` — class PlantEligibilityRefreshScheduler:58 · **CRON** :71 · refreshTick():75
- `apps/backend/src/org/plant-eligible-floating-se.service.ts` — if():24 · class PlantEligibleFloatingSeService:35 · refresh():47 · freshness():91 · eligibleSeIdsForPlant():102
- `apps/backend/src/org/plants.service.ts` — class PlantsService:24 · list():30 · create():40
- `apps/backend/src/org/scoring-weights.service.ts` — class ScoringWeightsService:23 · list():29 · upsert():38
- `apps/backend/src/org/se-coverage.service.ts` — class SeCoverageService:48 · listEngineers():54 · createEngineer():61 · listCoverage():100 · addCoverage():110 · removeCoverage():155
- `apps/backend/src/org/se-territory.service.ts` — class SeTerritoryService:31 · listTerritory():38 · addTerritory():48 · removeTerritory():96
- `apps/backend/src/org/sla-rules.service.ts` — class SlaRulesService:26 · list():32 · upsert():38 · if():68 · if():69
- `apps/backend/src/org/tier-override-expiry.service.ts` — class TierOverrideExpiryService:21 · sweepExpiredOverrides():24
- `apps/backend/src/org/tier-overrides.service.ts` — if():45 · class TierOverridesService:59 · create():65 · cancel():136 · list():170
- `apps/backend/src/org/tiers.service.ts` — class TiersService:11 · list():14
- `apps/backend/src/org/users.service.ts` — class UsersService:27 · list():33 · create():39 · setStatus():73
- `apps/backend/src/org/zone-mapping.service.ts` — class ZoneMappingService:79 · listMappings():85 · listPending():95 · mapValue():100 · ignoreValue():123 · listOverrides():144 · upsertOverride():159 · zoneChangeImpact():202 · deleteOverride():283 · reapply():310
- `apps/backend/src/org/zones.service.ts` — class ZonesService:15 · list():21 · create():27
- `apps/backend/src/settings/aging-threshold.ts` — if():70 · if():71 · if():97
- `apps/backend/src/settings/assignment-threshold.service.ts` — class AssignmentThresholdService:111 · view():118 · set():159 · revert():181 · setLock():257
- `apps/backend/src/settings/assignment-threshold.ts` — if():58 · if():59 · if():86
- `apps/backend/src/settings/setting-authority.ts` — if():57 · if():59
- `apps/backend/src/settings/settings.service.ts` — class SettingsService:137 · onModuleInit():144 · seedDefaults():149 · getAll():166 · set():175
- `apps/backend/src/settings/special-threshold.ts` — if():57 · if():58 · if():85
- `apps/backend/src/ops-explorer/dataset-query.service.ts` — class DatasetQueryService:41 · requireDataset():45 · query():53 · exportRows():105 · for():119
- `apps/backend/src/ops-explorer/dataset-query.ts` — if():105 · if():108 · if():119 · if():130 · if():141 · if():170 · if():181 · if():187 · switch():196 · if():276 · if():282 · if():291 · for():297 · if():307 · +5
- `apps/backend/src/ops-explorer/ops-explorer-enabled.guard.ts` — class OpsExplorerEnabledGuard:19 · canActivate():20 · class OpsExplorerConfigService:30
- `apps/backend/src/ops-explorer/ops-explorer.config.ts` — if():34 · if():36
- `apps/backend/src/ops-explorer/ops-explorer.dto.ts` — class OpsExplorerQueryDto:21
- `apps/backend/src/ops-explorer/reconciliation.service.ts` — class ReconciliationService:126 · run():132
- `apps/backend/src/plant-deactivation/plant-deactivation.service.ts` — class PlantDeactivationService:53 · deactivate():59 · reactivate():97 · list():123
- `apps/backend/src/build-info/build-info.ts` — if():40 · if():68 · if():104 · if():107
- `apps/backend/src/build-info/migration-skew.ts` — if():61 · if():78 · if():86
- `apps/backend/src/build-info/runtime-lock-reset.ts` — if():24 · if():29 · if():58 · emit():85
- `apps/backend/src/build-info/runtime-lock.ts` — return():43 · if():102 · if():110 · if():116 · if():122 · if():132 · emitWarn():137 · if():141

## admin UI files
- `apps/admin/src/pages/settings/AssignmentThresholdSection.tsx` — 377 loc · **no data hook**
- `apps/admin/src/pages/settings/primitives.tsx` — 319 loc · **no data hook**
- `apps/admin/src/pages/settings/sections.tsx` — 1093 loc · **no data hook**
- `apps/admin/src/pages/settings/SettingsPage.tsx` — 261 loc · **no data hook**
- `apps/admin/src/pages/admin/AssignmentThresholdPage.tsx` — 33 loc · **no data hook**
- `apps/admin/src/pages/admin/BuildHealthPage.tsx` — 205 loc · **no data hook**
- `apps/admin/src/pages/admin/BulkUnassignPage.tsx` — 344 loc · **no data hook**
- `apps/admin/src/pages/admin/PlantDeactivationsPage.tsx` — 246 loc · **no data hook**
- `apps/admin/src/pages/admin/PlantZonesPage.tsx` — 405 loc · **no data hook**
- `apps/admin/src/pages/admin/TierOverridesPage.tsx` — 376 loc · **no data hook**
- `apps/admin/src/pages/coverage/TerritoryPage.tsx` — 231 loc · **no data hook**
- `apps/admin/src/pages/ops-explorer/ColumnSource.tsx` — 143 loc · **no data hook**
- `apps/admin/src/pages/ops-explorer/FilterBuilder.tsx` — 202 loc · **no data hook**
- `apps/admin/src/pages/ops-explorer/OpsExplorerPage.tsx` — 429 loc · **no data hook**
- `apps/admin/src/pages/ops-explorer/ReconciliationPanel.tsx` — 131 loc · **no data hook**
- `apps/admin/src/pages/ops-explorer/useOpsExplorerMeta.ts` — 79 loc · **no data hook**

## admin api client calls (apps/admin/src/api)

## mobile screens
_no mobile surface declared for this module_

## tests touching this module
- `apps/backend/test/autoplant-config.spec.ts`
- `apps/backend/test/boot-config.spec.ts`
- `apps/backend/test/dispatch-schedule-config.e2e-spec.ts`
- `apps/backend/test/engineer-admin.e2e-spec.ts`
