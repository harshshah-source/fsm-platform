# skeleton — AutoPlant Ingestion & Device State (ingestion)
generated 2026-09-02 · 0 TEQ · source: gapscope.profile.json

## admin routes (declared)
- `/build-health` — AppRoutes.tsx:308

## backend endpoints
### apps/backend/src/ingestion/autoplant/integration-health.controller.ts  `@Controller('integration')`
- `GET /api/integration/health` → `check()` :17

### apps/backend/src/ingestion/autoplant/integration-sync.controller.ts  `@Controller('integration')`
- `POST /api/integration/sync-masters` → `syncMasters()` :37
- `POST /api/integration/run-pipeline` → `runPipeline()` :44

### apps/backend/src/ingestion/snapshots.controller.ts  `@Controller('snapshots')`
- `GET /api/snapshots/latest` → `latest()` :28
- `GET /api/snapshots/runs` → `listRuns()` :34
- `POST /api/snapshots/run` → `run()` :48

### apps/backend/src/devices/devices.controller.ts  `@Controller('devices')`
- `GET /api/devices` → `list()` :52
- `GET /api/devices/filter-options` → `filterOptions()` :87
- `GET /api/devices/:deviceId` → `get()` :93
- `GET /api/devices/:deviceId/cycles` → `cycles()` :103
- `GET /api/devices/:deviceId/downtime-trend` → `downtimeTrend()` :112
- `PATCH /api/devices/:deviceId/deal-type` → `tagDealType()` :120

## backend units (services / schedulers / jobs)
- `apps/backend/src/ingestion/autoplant/autoplant-departure-dryrun.ts` — if():60
- `apps/backend/src/ingestion/autoplant/autoplant-master-source.ts` — for():72 · class AutoPlantMasterSource:81 · countPlants():170 · countVehicleMasters():183 · readCompanies():191 · readTransporters():201 · readPlants():211 · readVehicleMasters():227
- `apps/backend/src/ingestion/autoplant/autoplant-mysql.client.ts` — if():44 · if():118 · class AutoPlantMysqlClient:134 · isConfigured():140 · ping():197 · onModuleDestroy():206
- `apps/backend/src/ingestion/autoplant/autoplant-ping.ts` — if():21
- `apps/backend/src/ingestion/autoplant/autoplant-source-reader.ts` — class AutoPlantSourceReader:68 · readChunk():87
- `apps/backend/src/ingestion/autoplant/autoplant-sync.ts` — if():33
- `apps/backend/src/ingestion/autoplant/health.service.ts` — isConfigured():17 · ping():18 · countPlants():82 · countVehicleMasters():84 · class AutoPlantHealthService:191 · check():199 · reconciliationHealth():283 · lifecycleHealth():342 · ingestionHealth():393
- `apps/backend/src/ingestion/autoplant/integration-scheduler.service.ts` — isConfigured():11 · class IntegrationSchedulerService:56 · **CRON** :76 · telemetryTick():77 · **CRON** :98 · mastersTick():99
- `apps/backend/src/ingestion/autoplant/integration-sync.service.ts` — class IntegrationSyncService:70 · syncMasters():82 · ingestTelemetry():94 · syncMastersTick():196 · runPipeline():219
- `apps/backend/src/ingestion/autoplant/mapping-table-zone-resolver.ts` — if():35 · class MappingTableZoneResolver:47 · resolve():62
- `apps/backend/src/ingestion/autoplant/mapping.ts` — if():170 · if():171 · report():172 · if():202 · if():203 · if():205 · if():206 · if():208 · if():209 · if():215 · if():216 · if():218 · if():226 · if():235 · +4
- `apps/backend/src/ingestion/autoplant/master-mapping.ts` — if():45 · if():47 · if():48 · if():149 · if():362 · if():389 · if():414
- `apps/backend/src/ingestion/autoplant/master-sync-run.service.ts` — class MasterSyncRunService:42 · reapStaleRuns():55 · heartbeat():64 · startRun():71 · finishRun():99
- `apps/backend/src/ingestion/autoplant/master-sync.service.ts` — readCompanies():37 · readTransporters():38 · readPlants():39 · readVehicleMasters():40 · resolve():50 · for():82 · class MasterSyncService:121 · sync():159
- `apps/backend/src/ingestion/autoplant/state-map-zone-resolver.ts` — zoneIdByName():12 · districtIdByName():14 · class PrismaZoneDirectory:18 · zoneIdByName():21 · districtIdByName():29 · class StateMapZoneResolver:54 · resolve():60
- `apps/backend/src/ingestion/autoplant/state-zone-map.ts` — if():74 · if():75 · if():76 · if():77
- `apps/backend/src/ingestion/ingestion-alert.ts` — if():118 · for():120 · for():127 · while():146 · for():151 · findFinalizedRuns():192 · findFailedChunks():193 · while():207
- `apps/backend/src/ingestion/normalize.ts` — if():46
- `apps/backend/src/ingestion/partition-maintenance.service.ts` — class PartitionMaintenanceService:50 · **CRON** :67 · scheduledMaintenance():68 · runMaintenance():94
- `apps/backend/src/ingestion/partition-planner.ts` — if():47 · if():66 · for():96 · for():104
- `apps/backend/src/ingestion/snapshot-ingestion.service.ts` — class SnapshotIngestionService:39 · ingestChunk():44
- `apps/backend/src/ingestion/snapshot-ingestion.worker.ts` — ingestChunk():8 · for():32 · class SnapshotIngestionWorker:57 · run():65 · for():199 · for():208
- `apps/backend/src/ingestion/snapshot-query.service.ts` — class SnapshotQueryService:95 · latest():98 · listRuns():128
- `apps/backend/src/ingestion/snapshot-run.service.ts` — class SnapshotRunService:25 · reapStaleRuns():39 · heartbeat():55 · startRun():62 · lastResumeCursor():90 · finishRun():108
- `apps/backend/src/ingestion/source-reader.ts` — readChunk():98 · class InMemorySourceReader:109 · readChunk():112
- `apps/backend/src/devices/device-detail.service.ts` — class DeviceDetailService:76 · deviceCycles():79 · downtimeTrend():124
- `apps/backend/src/devices/device.service.ts` — class DeviceService:161 · setDealType():167 · getDevice():186 · listDevices():212 · filterOptions():373
- `apps/backend/src/device-state/departure-invariant.ts` — if():24
- `apps/backend/src/device-state/device-state.service.ts` — class DeviceStateService:45 · recompute():71
- `apps/backend/src/device-state/eligibility.ts` — if():36 · if():37
- `apps/backend/src/device-state/recompute-canary.ts` — if():24
- `apps/backend/src/device-state/sla-bucket.ts` — for():67
- `apps/backend/src/device-departure/device-departure.service.ts` — class DeviceDepartureService:114 · activeDepartedDeviceIds():124 · reconcile():137
- `apps/backend/src/device-departure/stand-down-export.ts` — if():34 · if():89 · if():91

## admin UI files

## admin api client calls (apps/admin/src/api)

## mobile screens
_no mobile surface declared for this module_

## tests touching this module
- `apps/backend/test/ingestion-alert.e2e-spec.ts`
- `apps/backend/test/ingestion-alert.spec.ts`
- `apps/backend/test/snapshot-ingestion-schema.e2e-spec.ts`
