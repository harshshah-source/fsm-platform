# skeleton — Batch Scheduling & Dispatch (scheduling)
generated 2026-09-02 · 0 TEQ · source: gapscope.profile.json

## admin routes (declared)
- `/schedules` — AppRoutes.tsx:105
- `/schedules/:engineerId` — AppRoutes.tsx:123
- `/schedules/preview` — AppRoutes.tsx:115
- `/dispatch/today` — AppRoutes.tsx:96
- `/dispatch-runs` — AppRoutes.tsx:133
- `/dispatch-runs/:runId` — AppRoutes.tsx:141
- `/dispatch-runs/:runId/zones/:zoneId` — AppRoutes.tsx:149
- `/batches/:batchId` — AppRoutes.tsx:159
- `/assign` — AppRoutes.tsx:85
- `/bulk-unassign` — AppRoutes.tsx:259

## backend endpoints
### apps/backend/src/scheduling/batches.controller.ts  `@Controller('batches')`
- `GET /api/batches/:batchId` → `batchDetail()` :59
- `POST /api/batches/:id/override/preview` → `previewOverride()` :85
- `POST /api/batches/:id/override` → `overrideBatch()` :108

### apps/backend/src/scheduling/dispatch-runs.controller.ts  `@Controller('dispatch-runs')`
- `GET /api/dispatch-runs` → `list()` :46
- `GET /api/dispatch-runs/:runId` → `detail()` :54
- `GET /api/dispatch-runs/:runId/zones/:zoneId` → `zoneDetail()` :62
- `GET /api/dispatch-runs/:runId/decisions` → `decisions()` :81
- `GET /api/dispatch-runs/:runId/tickets/:ticketId/trace` → `ticketTrace()` :99

### apps/backend/src/scheduling/dispatch-today.controller.ts  `@Controller('dispatch')`
- `GET /api/dispatch/today` → `today()` :39
- `GET /api/dispatch/changes-today` → `changesToday()` :45
- `POST /api/dispatch/card-summaries` → `cardSummaries()` :65

### apps/backend/src/scheduling/intraday-updates.controller.ts  `@Controller('intraday-updates')`
- `GET /api/intraday-updates` → `list()` :34
- `POST /api/intraday-updates/add` → `add()` :40
- `POST /api/intraday-updates/remove` → `remove()` :75
- `POST /api/intraday-updates/reorder` → `reorder()` :99

### apps/backend/src/scheduling/schedules.controller.ts  `@Controller('schedules')`
- `GET /api/schedules/dispatch-schedule` → `dispatchScheduleGet()` :176
- `PUT /api/schedules/dispatch-schedule` → `dispatchSchedulePut()` :182
- `POST /api/schedules/dispatch-run` → `dispatchRunNow()` :225
- `GET /api/schedules/dispatch-run/in-flight` → `dispatchInFlight()` :277
- `POST /api/schedules/bulk-unassign` → `bulkUnassignRoute()` :290
- `GET /api/schedules/bulk-unassign/history` → `bulkUnassignHistory()` :317
- `GET /api/schedules/preview` → `schedulerPreviewGet()` :333
- `POST /api/schedules/holds` → `placeHold()` :356
- `POST /api/schedules/holds/release` → `releaseHold()` :400
- `GET /api/schedules/me` → `me()` :418
- `POST /api/schedules/assign` → `assign()` :424
- `POST /api/schedules/assign-plants` → `assignPlants()` :465
- `POST /api/schedules/assign-batch` → `assignBatchRoute()` :491
- `GET /api/schedules` → `list()` :523
- `GET /api/schedules/engineers` → `zoneEngineers()` :557
- `GET /api/schedules/assignable-work` → `assignableWorkPool()` :579
- `GET /api/schedules/candidates` → `candidates()` :595
- `GET /api/schedules/assignable-tickets` → `assignableTicketIds()` :612
- `POST /api/schedules/distribute-preview` → `distributePreview()` :629
- `GET /api/schedules/:engineerId` → `detail()` :647

### apps/backend/src/shared-pool/shared-pool.controller.ts  `@Controller('me')`
- `GET /api/me/shared-pool` → `list()` :19

## backend units (services / schedulers / jobs)
- `apps/backend/src/scheduling/add-source.ts` — if():139 · switch():140
- `apps/backend/src/scheduling/assignable-work-query.service.ts` — class AssignableWorkQueryService:64 · listForScope():67 · ticketIdsForPlants():209
- `apps/backend/src/scheduling/batch-assignment.service.ts` — if():57 · if():58 · if():59 · class BatchAssignmentService:114 · dispatchForZone():136 · conflictingScheduleSeIds():516
- `apps/backend/src/scheduling/bulk-unassign.service.ts` — class BulkUnassignService:113 · preview():123 · history():146 · execute():179
- `apps/backend/src/scheduling/business-sweep-scheduler.service.ts` — class BusinessSweepSchedulerService:147 · **CRON** :218 · verificationTick():219 · **CRON** :223 · installVerificationTick():224 · **CRON** :228 · criticalAssignTick():229 · **CRON** :235 · crossZoneTick():236 · **CRON** :240 · repeatEscalationTick():241 · **CRON** :245 · tierOverrideExpiryTick():246 · **CRON** :250 · +11
- `apps/backend/src/scheduling/candidate-query.service.ts` — class CandidateQueryService:86 · listForPlants():94
- `apps/backend/src/scheduling/close-assignment.ts` — if():40
- `apps/backend/src/scheduling/committed-day-load.ts` — for():47 · for():98
- `apps/backend/src/scheduling/coverage-at-assign.ts` — if():32 · if():33 · if():34 · if():47 · for():67
- `apps/backend/src/scheduling/cron-tick-claim.service.ts` — class CronTickClaimService:29 · claimTick():51 · claimTickOrLog():80 · pruneExpiredClaims():95
- `apps/backend/src/scheduling/cron-tick-claim.ts` — claimTickOrLog():64 · pruneExpiredClaims():74
- `apps/backend/src/scheduling/day-plan-notification-outbox.ts` — if():73 · if():83 · if():117 · if():140 · for():142 · for():161 · if():175
- `apps/backend/src/scheduling/day-plan-notifier.ts` — dayPlanDispatched():28 · dayPlanOverridden():29 · class LoggingDayPlanNotifier:35 · dayPlanDispatched():37 · dayPlanOverridden():42 · class SpineDayPlanNotifier:57 · dayPlanDispatched():60 · dayPlanOverridden():70
- `apps/backend/src/scheduling/day-plan-query.service.ts` — class DayPlanQueryService:19 · getDayPlan():26
- `apps/backend/src/scheduling/dispatch-changes-today.service.ts` — class DispatchChangesTodayService:61 · changesToday():64
- `apps/backend/src/scheduling/dispatch-cron.ts` — setTime():114 · start():115 · nextDate():116 · if():149
- `apps/backend/src/scheduling/dispatch-run.service.ts` — class DispatchRunService:222 · runForActiveZones():233 · reapStaleDispatchRuns():510 · recoverAbandonedDispatchTick():584 · recoverMarkedZones():706 · previewActiveZones():899 · inFlightZones():935
- `apps/backend/src/scheduling/dispatch-schedule.service.ts` — class DispatchScheduleService:53 · onApplicationBootstrap():75 · applyStoredSchedule():88 · current():107 · setCron():116
- `apps/backend/src/scheduling/dispatch-scheduler.service.ts` — class DispatchSchedulerService:64 · **CRON** :84 · dispatchTick():85 · **CRON** :131 · dispatchReaperTick():132 · **CRON** :170 · dispatchRecoveryTick():171
- `apps/backend/src/scheduling/dispatch-today-query.service.ts` — class DispatchTodayQueryService:313 · today():328 · cardSummaries():532
- `apps/backend/src/scheduling/dispatch-transparency-query.service.ts` — if():289 · class DispatchTransparencyQueryService:299 · listRuns():302 · getRunDetail():366 · getZoneDetail():478 · getBatchDetail():647 · getTicketTrace():740 · getRunDecisions():794 · if():930 · return():940
- `apps/backend/src/scheduling/distribute-projection.service.ts` — class DistributeProjectionService:57 · project():64
- `apps/backend/src/scheduling/dto/card-summaries.dto.ts` — class CardSummariesDto:17
- `apps/backend/src/scheduling/dto/override-command.dto.ts` — class OverrideCommandDto:73
- `apps/backend/src/scheduling/override-projection.service.ts` — class OverrideProjectionService:110 · projectOverride():113
- `apps/backend/src/scheduling/override.service.ts` — class OverrideService:253 · override():265 · assignTicket():608 · assignPlants():889 · assignBatch():970
- `apps/backend/src/scheduling/preview-token.ts` — if():48 · if():79 · if():84 · if():92
- `apps/backend/src/scheduling/same-day-update.service.ts` — class SameDayUpdateService:31 · addTicket():45 · removeTicket():59 · reorder():79 · listIntradayUpdates():103
- `apps/backend/src/scheduling/schedule-closure-scheduler.service.ts` — class ScheduleClosureScheduler:90 · **CRON** :103 · closeTick():104
- `apps/backend/src/scheduling/scheduler-preview.service.ts` — class SchedulerPreviewService:98 · preview():109 · checkStaleness():144 · placeHold():170 · releaseHold():277
- `apps/backend/src/scheduling/se-skip.ts` — if():39 · if():46 · if():57
- `apps/backend/src/scheduling/soft-state-conflict.ts` — activeOnSiteTicketIds():8 · activeTroubleshootStartedTicketIds():21 · class NoConflictSoftStatePort:29 · activeOnSiteTicketIds():30 · activeTroubleshootStartedTicketIds():34
- `apps/backend/src/scheduling/ticket-action-status.ts` — if():52 · if():53 · return():60
- `apps/backend/src/scheduling/zm-schedule-query.service.ts` — class ZmScheduleQueryService:142 · listSchedules():159 · getScheduleDetail():236 · listZoneEngineers():299 · if():385
- `apps/backend/src/recommender/candidate-selection.service.ts` — class CandidateSelectionService:20 · orderedCandidatesForPlant():23
- `apps/backend/src/recommender/canonical-sort.ts` — if():85 · if():87 · if():100 · if():107 · if():112 · if():114 · if():140 · if():141 · if():144 · if():145
- `apps/backend/src/recommender/hard-filters.ts` — switch():65 · for():101 · for():112
- `apps/backend/src/recommender/recommender.service.ts` — for():218 · class RecommenderService:265 · runForZone():275
- `apps/backend/src/recommender/scoring-config.ts` — for():35 · for():64
- `apps/backend/src/recommender/scoring.ts` — return():85 · if():91 · if():97 · if():103
- `apps/backend/src/shared-pool/se-coverage.service.ts` — class SeCoverageService:15 · coveredPlantIds():18 · isPlantCovered():29
- `apps/backend/src/shared-pool/shared-pool.service.ts` — class SharedPoolService:26 · getSharedPool():37

## admin UI files
- `apps/admin/src/pages/schedules/IntradayManualAssignModal.tsx` — 118 loc · **no data hook**
- `apps/admin/src/pages/schedules/IntradayQueuePage.tsx` — 346 loc · **no data hook**
- `apps/admin/src/pages/schedules/ScheduleDetailPage.tsx` — 599 loc · **no data hook**
- `apps/admin/src/pages/schedules/SchedulerPreviewPage.tsx` — 494 loc · **no data hook**
- `apps/admin/src/pages/schedules/SchedulesPage.tsx` — 275 loc · **no data hook**
- `apps/admin/src/pages/dispatch/ConfigInEffectPanel.tsx` — 153 loc · **no data hook**
- `apps/admin/src/pages/dispatch/console/ActionsBand.tsx` — 1229 loc · **no data hook**
- `apps/admin/src/pages/dispatch/console/AssignBoard.tsx` — 966 loc · **no data hook**
- `apps/admin/src/pages/dispatch/console/AssignMode.tsx` — 194 loc · **no data hook**
- `apps/admin/src/pages/dispatch/console/AttentionBand.tsx` — 223 loc · **no data hook**
- `apps/admin/src/pages/dispatch/console/BoardGrid.tsx` — 939 loc · **no data hook**
- `apps/admin/src/pages/dispatch/console/dayAxis.ts` — 62 loc · **no data hook**
- `apps/admin/src/pages/dispatch/console/dropTargets.ts` — 104 loc · **no data hook**
- `apps/admin/src/pages/dispatch/console/Inspector.tsx` — 762 loc · **no data hook**
- `apps/admin/src/pages/dispatch/console/NextRunPill.tsx` — 50 loc · **no data hook**
- `apps/admin/src/pages/dispatch/console/RunNowControl.tsx` — 225 loc · **no data hook**
- `apps/admin/src/pages/dispatch/console/ScoreBreakdownPanel.tsx` — 223 loc · **no data hook**
- `apps/admin/src/pages/dispatch/console/selection.ts` — 49 loc · **no data hook**
- `apps/admin/src/pages/dispatch/console/useConsoleData.ts` — 113 loc · **no data hook**
- `apps/admin/src/pages/dispatch/console/useDayContext.ts` — 253 loc · **no data hook**
- `apps/admin/src/pages/dispatch/console/WorkCard.tsx` — 399 loc · **no data hook**
- `apps/admin/src/pages/dispatch/console/WorkChip.tsx` — 318 loc · **no data hook**
- `apps/admin/src/pages/dispatch/console/WorkRail.tsx` — 482 loc · **no data hook**
- `apps/admin/src/pages/dispatch/console/ZonePicker.tsx` — 119 loc · **no data hook**
- `apps/admin/src/pages/dispatch/DecisionTrace.tsx` — 161 loc · **no data hook**
- `apps/admin/src/pages/dispatch/DispatchBatchDetailPage.tsx` — 259 loc · **no data hook**
- `apps/admin/src/pages/dispatch/DispatchRunDetailPage.tsx` — 196 loc · **no data hook**
- `apps/admin/src/pages/dispatch/DispatchRunsPage.tsx` — 90 loc · **no data hook**
- `apps/admin/src/pages/dispatch/DispatchZoneDetailPage.tsx` — 94 loc · **no data hook**
- `apps/admin/src/pages/dispatch/format.ts` — 105 loc · **no data hook**
- `apps/admin/src/pages/dispatch/TodaysDispatchPage.tsx` — 780 loc · **no data hook**
- `apps/admin/src/pages/dispatch/ZoneDispatchTable.tsx` — 421 loc · **no data hook**
- `apps/admin/src/pages/dispatch/ZoneUnassignableTable.tsx` — 120 loc · **no data hook**
- `apps/admin/src/pages/assign/AssignConsolePage.tsx` — 37 loc · **no data hook**
- `apps/admin/src/pages/assign/AssignWorkspace.tsx` — 601 loc · **no data hook**
- `apps/admin/src/pages/assign/CandidateColumn.tsx` — 170 loc · **no data hook**
- `apps/admin/src/pages/assign/DistributePanel.tsx` — 205 loc · **no data hook**
- `apps/admin/src/pages/assign/grammar.tsx` — 96 loc · **no data hook**
- `apps/admin/src/pages/assign/LaneCoverage.tsx` — 120 loc · **no data hook**
- `apps/admin/src/pages/assign/ReviewCommitScreen.tsx` — 353 loc · **no data hook**
- `apps/admin/src/pages/assign/useAssignDraft.ts` — 737 loc · **no data hook**

## admin api client calls (apps/admin/src/api)

## mobile screens
- `apps/mobile/src/home/homeKpi.ts` — 46 loc
- `apps/mobile/src/home/plantSummary.ts` — 53 loc
- `apps/mobile/src/home/PlantWorkloadCard.tsx` — 154 loc
- `apps/mobile/src/home/WorkHistoryChart.tsx` — 191 loc

## tests touching this module
- `apps/backend/test/ist-day-boundary-scheduling.e2e-spec.ts`
- `apps/backend/test/scheduling-schema.e2e-spec.ts`
