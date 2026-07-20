# 10 — API Layer

> Part of the [UI Redevelopment Handoff](20-master-index.md). Previous: [09 — State](09-state.md) · Next: [11 — Forms](11-forms.md).

## Client architecture

- **No axios.** Native `fetch`, patched once at startup: `installAuthFetch()` (`src/api/http.ts`) wraps `window.fetch` with the session policy so all 36 API modules get it for free.
- **Base URL**: every module declares `const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api'`.
- **Headers**: `api/authHeaders.ts` → `Authorization: Bearer <fsm.accessToken from sessionStorage>` + `X-Acting-As-Zone: <fsm.actingZone>` when acting. Each module spreads `authHeaders()` into its requests (plus `Content-Type: application/json` on writes).
- **Response handling**: `res.ok ? res.json() as T : throw` — most modules throw `Error('REQUEST_FAILED_<status>')`; form-heavy modules define typed error classes carrying a backend `code` (`LoginError`, `SeApiError{code,field}`, `InstallApiError{code,errors[]}`, `RunPipelineError`, `OverrideConflictError{conflict}`).

## 401 / refresh policy (`api/http.ts`) — must not change

1. Any response ≠ 401, or a non-API URL, or an auth endpoint (`/auth/login`, `/auth/refresh`) → returned as-is (login 401s are real credential failures).
2. 401 on an API call → **single-flight** `POST /auth/refresh` `{refreshToken}` (concurrent 401s share one refresh; rotation: the new token pair is stored).
3. Refresh success → original request retried **once** with the new bearer; a second 401 → `clearTokens()` + `onExpired()`.
4. Refresh failure/absence → `clearTokens()` + `onExpired()` (AuthProvider clears session and flags `sessionExpired`).
5. Proactive: AuthProvider also schedules a refresh ~60 s before access-token `exp`.

`makeAuthFetch(rawFetch)` is exported for tests; `apiRefresh()` for rehydration.

## Auth endpoints (`api/client.ts`)

| Fn | Endpoint | Notes |
|---|---|---|
| `apiLogin(body)` | `POST /auth/login` | throws `LoginError('INVALID_CREDENTIALS'\|'SERVICE_UNAVAILABLE')` |
| `apiMe(token)` | `GET /me` | returns `SessionView` |

## Domain modules — every function + endpoint

Base path prefix `…/api` omitted. All GETs attach `authHeaders()`.

### dashboard.ts
`apiZoneOverview()` GET `/dashboard/zone-overview` → `ZoneOverviewRow[]` (zoneId, zoneName, totalInactive, totalDevices, byBucket, trendPctVsPrevDay) · `apiCompanyPlantOverview(filters?)` GET `/dashboard/company-plant-overview` → `CompanyPlantRow[]` · `apiCriticalQueue()` GET `/dashboard/critical-queue` → `CriticalQueueGroup[]` (company/plant cluster + tickets) · `apiActionRequired()` GET `/dashboard/action-required` → `ActionRequiredCard[]` (key,label,count,available,urgency).

### tickets.ts
`apiTicketsList(filters)` GET `/tickets?workType&status&bucket&assignmentState&companyId&plantId` → `TicketRow[]` (server-sorted, zone-scoped) · `apiTicketDetail(id)` GET `/tickets/:id` → `TicketDetail` (+lifecycle[]) · `apiTicketForms(id)` GET `/tickets/:id/forms` · `apiTicketsByPlant(plantId)` GET `/tickets?plantId=…`.

### schedules.ts
`apiListSchedules()` GET `/schedules` · `apiScheduleDetail(engineerId)` GET `/schedules/:engineerId` (stops → tickets, reasoning) · `apiZoneEngineers()` GET `/schedules/engineers` · `apiAssignTicket(ticketId, seId)` POST `/schedules/assign` · `apiOverrideBatch(batchId, cmd)` POST `/batches/:batchId/override` — `cmd: {action: REMOVE_TICKET|DEFER_TICKET|REORDER|SWAP_SE|SPLIT_BATCH|REASSIGN, reasonCode, …, confirm?}`; a 409-style ON_SITE conflict throws `OverrideConflictError` with `{message, ticketIds}`.

### intradayUpdates.ts
`apiIntradayUpdates()` GET `/intraday-updates` → rows (auditId, updateType ADD|REMOVE|REORDER, ticketId?, seId?, actorId, createdAt).

### engineers.ts
`apiEngineers()` GET `/engineers` → `EngineerListRow[]` (activityStatus, coverageType, availabilityStatus, activeTicketCount, kitComplete) · `apiEngineerDetail(seId)` GET `/engineers/:seId` (dayPlan, vanStock, kit.missing, availabilityRows) · `apiSetAvailability(seId, body)` POST `/engineers/:seId/availability` `{status, windowStart, windowEnd?, reason?}`.

### engineersAdmin.ts (throws `SeApiError{code, field?}`)
`listSeDirectory()` GET `/engineers/directory` · `createSe(body)` POST `/engineers` · `updateSe(seId, body)` PATCH `/engineers/:seId` · `setSeActive(seId, active)` POST `/engineers/:seId/status` · `addSeCoverage(seId, {plantId, coverageType})` POST `/engineers/:seId/coverage` · `removeSeCoverage(seId, coverageId)` DELETE `/engineers/:seId/coverage/:coverageId`.

### leaveRequests.ts
`apiLeaveRequests()` GET `/leave-requests` · `apiApproveLeave(id)` POST `/leave-requests/:id/approve` · `apiRejectLeave(id, reason)` POST `/leave-requests/:id/reject`.

### planner.ts
`apiListPlannerEntries(dateFrom, dateTo)` GET `/planner?…` · `apiListPlannerPlants()` GET `/planner/plants` · `apiCreatePlannerEntry({seId, plantId, plannedDate})` POST `/planner` · `apiDeletePlannerEntry(id)` DELETE `/planner/:id`.

### vehicleUnavailability.ts
`apiVehicleUnavailability()` GET `/vehicle-unavailability` (dual-clock rows: primarySlaSeconds, secondarySlaSeconds, slaPaused, reasonCode, transporterContacted…) · `apiConfirmVuDate(id, iso)` POST `/vehicle-unavailability/:id/confirm-date` · `apiResumeVuSla(id)` POST `/vehicle-unavailability/:id/resume-sla`.

### nonOp.ts
`RECOVERY_REASONS` const (reason codes that qualify for auto Recovery Ticket) · `apiNonOpQueue()` GET `/non-op/queue` · `apiRequestNonOp({deviceId, reasonCode, reasonText})` POST `/non-op` · `apiConfirmNonOp(markingId)` POST `/non-op/:id/confirm` · `apiOverrideConfirmNonOp(markingId, reason)` POST `/non-op/:id/override-confirm` (OH) · `apiGetDeviceDealType(deviceId)` GET `/devices/:id`.

### recovery.ts
`apiRecoveryAwaitingReceipt()` GET `/recovery/awaiting-receipt` · `apiConfirmRecoveryReceipt(ticketId)` POST `/recovery/:id/receipt` · `apiRecoveryZmQueue()` GET `/recovery/zm-queue` · `apiRescheduleRecovery(ticketId, seId)` POST `/recovery/:id/reschedule` · `apiCloseFailedRecovery(ticketId, reason)` POST `/recovery/:id/close-failed` · `apiEscalateRecovery(ticketId)` POST `/recovery/:id/escalate` · `apiManualCloseRecovery(ticketId, reason)` POST `/recovery/:id/manual-close`.

### componentRequests.ts
`apiComponentRequests()` GET `/warehouse/requests` (WM) · `apiComponentRequestsOversight()` GET `/component-requests` (managers, read-only) · `apiComponentRequestsByTicket(ticketId)` GET `/component-requests/by-ticket/:ticketId` · `apiApproveRequest(id)` / `apiShipRequest(id, {trackingRef, deliveryDestination})` / `apiRejectRequest(id, reason)` POST `/warehouse/requests/:id/(approve|ship|reject)`.

### inventory.ts
`apiComponentBlocked()` GET `/component-blocked` · `apiWarehouseStock()` GET `/inventory/warehouse-stock` · `apiFulfillmentSla()` GET `/inventory/warehouse-stock/fulfillment-sla` · `apiSetWarehouseStock(body)` PUT/POST `/inventory/warehouse-stock`.

### shadowUse.ts
`apiShadowUse()` GET `/warehouse/shadow-use` · `apiReconcileShadowUse(id)` / `apiDisputeShadowUse(id, reason)` POST `/warehouse/shadow-use/:id/(reconcile|dispute)`.

### crossZone.ts
`apiCrossZoneList()` GET `/cross-zone` · `apiCrossZoneSweep()` POST `/cross-zone/sweep` · `apiCrossZoneFlag(...)` POST `/cross-zone/flag` · `apiCrossZoneApprove(id, targetZone, seId)` POST `/cross-zone/:id/approve` · `apiCrossZoneDeny(id, reason)` POST `/cross-zone/:id/deny` · `apiCrossZoneDefer(id, reviewDate, reason)` POST `/cross-zone/:id/defer` · `apiCrossZoneReEscalate(id)` POST `/cross-zone/:id/re-escalate`.

### install.ts (throws `InstallApiError{code, errors?: CsvRowError[]}`)
`createInstall(body)` POST `/install` · `uploadInstallCsv(csv)` POST `/install/upload`.

### verification.ts
`apiVerificationReview(filters)` GET `/verification/review?outcome&companyId&…` · `apiEscalateVerification(ticketId, reason)` POST `/verification/:ticketId/escalate` · `apiTicketVerification(ticketId)` GET `/tickets/:ticketId/verification` · `apiMarkAutoRecovery(ticketId)` POST `/verification/:ticketId/mark-auto-recovery`.

### vouchers.ts
`apiVouchers(status)` GET `/vouchers?status=ZONAL_MANAGER_REVIEW|APPROVED` · `apiReviewVoucher(id, action, notes?)` POST `/vouchers/:id/review` (`APPROVE|REJECT|NEEDS_CLARIFICATION`) · `apiMarkVouchersPaid(ids, batchRef?)` POST `/vouchers/mark-paid` · `apiExportVouchers(month)` GET `/vouchers/export?month=YYYY-MM` → `{filename, csv}`.

### reports.ts
`apiFleetUptime({groupBy})` GET `/reports/fleet-uptime` · `recentMonths(n)` helper · `apiFleetUptimeTrend(n)` (n monthly fleet-uptime calls mapped to TrendDatum) · `apiSoftInactiveTrend({days})` GET `/reports/soft-inactive-trend` (**OH-only endpoint** — others reject; UI shows a gated panel) · `apiRootCause()` GET `/reports/root-cause` · `apiSystemEfficiency()` GET `/reports/efficiency` · `apiZmScorecard()` GET `/reports/zm-scorecard` (OH).

### devices.ts
`apiDeviceList(q)` GET `/devices?search&limit&offset&sort&status&bucket&zoneId&companyId` → `{rows, total}` (server-paged, hard cap 200/page; sort whitelist `LONGEST_INACTIVE|NEWEST_ACTIVITY|SLA_SEVERITY|PRIORITY|DEVICE_ID`) · `apiDeviceFilterOptions()` GET `/devices/filter-options` · `apiDeviceCycles(id)` GET `/devices/:id/cycles` · `apiDeviceDowntimeTrend(id)` GET `/devices/:id/downtime-trend` · `apiSetDealType(id, dealType)` POST `/devices/:id/deal-type` (OH).

### roleBackup.ts
`apiCsmApprovalShare()` GET `/reports/csm-approval-share` → per-zone `{zoneId, csmActions, totalActedActions, sharePct}`.

### exports.ts
`apiEntityMappingSummary()` GET `/exports/entity-mapping/summary` → `{rowCount, dataAsOf}` · `downloadEntityMappingCsv()` GET `/exports/entity-mapping` → blob → browser download.

### territory.ts
`apiFloatingEngineers()` GET `/org/engineers` (filtered FLOATING) · `apiGeoStates()` GET `/org/geo/states` · `apiGeoRegions(state)` GET `/org/geo/regions?state=` · `apiGeoDistricts(state, regionId?)` GET `/org/geo/districts?…` · `apiListTerritory(seId)` GET `/org/se-territory?seId=` · `apiAddTerritory({seId, districtId|regionId|state})` POST `/org/se-territory` · `apiRemoveTerritory(id)` DELETE `/org/se-territory/:id`.

### org.ts (Settings console)
`listZones` GET `/org/zones` · `createZone(name)` POST · `listPlants(zoneId?)` GET `/org/plants` · `createPlant` POST · `listCompanies` GET `/org/companies` · `createCompany` POST · `updateCompany(id, {companyTier?, companyPriorityRank?, opsOverride?})` PATCH `/org/companies/:id` · `listUsers`/`createUser` `/org/users` · `listSlaRules` GET / `upsertSlaRule` PUT `/org/sla-rules` · `listScoringWeights`/`upsertScoringWeight` `/org/scoring-weights` · `listCommonKit`/`upsertCommonKit` `/org/common-kit` · `listEngineers`/`createEngineer` `/org/engineers` · `listSeCoverage`/`addSeCoverage` `/org/se-coverage`.

### integration.ts
`apiRunPipeline()` POST `/integration/run-pipeline` (OH) → `{skipped:true}` (RUN_IN_PROGRESS) or `{summary: PipelineSummary}`; throws `RunPipelineError`.

### snapshots.ts
`apiSnapshotLatest()` GET `/snapshots/latest` → `{latest: {status, startedAt}|null, dataAsOf}`.

## Caching & error-handling summary

- **No client cache** — every mount refetches; mutations reload the page's list.
- Errors surface as page-level `role="alert"` strings (fixed friendly messages), never raw server text — except code-mapped forms ([11 — Forms](11-forms.md)).
- Best-effort side fetches (`apiZoneEngineers` for pickers, filter options, snapshot banner) swallow errors and degrade to empty.
