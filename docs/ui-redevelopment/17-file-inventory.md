# 17 — File Inventory (`apps/admin/src`)

> Part of the [UI Redevelopment Handoff](20-master-index.md). Previous: [16 — Constraints](16-business-constraints.md) · Next: [18 — Dependency Graph](18-dependency-graph.md).

Format: **Path** · Purpose · Key imports → Key exports. (React/router imports omitted where obvious.)

## Root

| Path | Purpose | Imports → Exports |
|---|---|---|
| `main.tsx` | Entry; installs auth-fetch, mounts App | App, api/http, index.css → (render) |
| `App.tsx` | Provider tree + router | AuthProvider, ToastProvider, AppRoutes → `App` |
| `AppRoutes.tsx` | The route table + role gates + SnapshotBanner | all pages, ProtectedRoute, RoleRoute, AdminShell → `AppRoutes` |
| `index.css` | Tailwind v4 tokens (@theme), base styles, utilities, keyframes | — |
| `vite-env.d.ts` | Vite type refs | — |

## `api/` (all: fetch + authHeaders + typed views; BASE_URL from `VITE_API_URL`)

| Path | Purpose → Exports |
|---|---|
| `http.ts` | window.fetch 401→refresh→retry interceptor → `installAuthFetch`, `makeAuthFetch`, `apiRefresh`, `setOnSessionExpired` |
| `tokens.ts` | sessionStorage token pair → `getAccessToken`, `getRefreshToken`, `setTokens`, `clearTokens` |
| `authHeaders.ts` | Bearer + `X-Acting-As-Zone` headers → `authHeaders` |
| `client.ts` | login/me → `apiLogin`, `apiMe`, `LoginError` |
| `dashboard.ts` | dashboard aggregations → `apiZoneOverview`, `apiCompanyPlantOverview`, `apiCriticalQueue`, `apiActionRequired` + row types |
| `tickets.ts` | ticket list/detail/forms → `apiTicketsList`, `apiTicketDetail`, `apiTicketForms`, `apiTicketsByPlant`, `TicketRow`, `TicketDetail`, `TicketFilters` |
| `schedules.ts` | schedules + assign + override → `apiListSchedules`, `apiScheduleDetail`, `apiZoneEngineers`, `apiAssignTicket`, `apiOverrideBatch`, `OverrideCommand`, `OverrideConflictError` |
| `intradayUpdates.ts` | intraday audit rows → `apiIntradayUpdates`, `IntradayUpdateRow/Type` |
| `engineers.ts` | SE activity list/detail/availability → `apiEngineers`, `apiEngineerDetail`, `apiSetAvailability`, `SettableStatus` |
| `engineersAdmin.ts` | SE directory CRUD → `listSeDirectory`, `createSe`, `updateSe`, `setSeActive`, `addSeCoverage`, `removeSeCoverage`, `SeApiError` |
| `leaveRequests.ts` | leave approvals → `apiLeaveRequests`, `apiApproveLeave`, `apiRejectLeave` |
| `planner.ts` | planner CRUD → `apiListPlannerEntries`, `apiListPlannerPlants`, `apiCreatePlannerEntry`, `apiDeletePlannerEntry` |
| `vehicleUnavailability.ts` | VU dual-clock rows + actions → `apiVehicleUnavailability`, `apiConfirmVuDate`, `apiResumeVuSla`, `VehicleUnavailReason` |
| `nonOp.ts` | non-op queue + confirmations → `RECOVERY_REASONS`, `apiNonOpQueue`, `apiRequestNonOp`, `apiConfirmNonOp`, `apiOverrideConfirmNonOp`, `apiGetDeviceDealType` |
| `recovery.ts` | recovery legs → `apiRecoveryAwaitingReceipt`, `apiConfirmRecoveryReceipt`, `apiRecoveryZmQueue`, `apiRescheduleRecovery`, `apiCloseFailedRecovery`, `apiEscalateRecovery`, `apiManualCloseRecovery` |
| `componentRequests.ts` | CR queues + WM legs → `apiComponentRequests`, `apiComponentRequestsOversight`, `apiComponentRequestsByTicket`, `apiApproveRequest`, `apiShipRequest`, `apiRejectRequest` |
| `inventory.ts` | blocked queue + stock → `apiComponentBlocked`, `apiWarehouseStock`, `apiFulfillmentSla`, `apiSetWarehouseStock` |
| `shadowUse.ts` | shadow-use queue → `apiShadowUse`, `apiReconcileShadowUse`, `apiDisputeShadowUse` |
| `crossZone.ts` | cross-zone escalations → `apiCrossZoneList/Sweep/Flag/Approve/Deny/Defer/ReEscalate` |
| `install.ts` | install create + CSV → `createInstall`, `uploadInstallCsv`, `InstallApiError`, `CsvRowError` |
| `verification.ts` | verification review/escalate → `apiVerificationReview`, `apiEscalateVerification`, `apiTicketVerification`, `apiMarkAutoRecovery` |
| `vouchers.ts` | voucher review/finance → `apiVouchers`, `apiReviewVoucher`, `apiMarkVouchersPaid`, `apiExportVouchers` |
| `reports.ts` | reporting suite → `apiFleetUptime`, `apiFleetUptimeTrend`, `recentMonths`, `apiSoftInactiveTrend`, `apiRootCause`, `apiSystemEfficiency`, `apiZmScorecard` |
| `devices.ts` | device list/cycles/trend/deal-type → `apiDeviceList`, `apiDeviceFilterOptions`, `apiDeviceCycles`, `apiDeviceDowntimeTrend`, `apiSetDealType` |
| `roleBackup.ts` | CSM backup share → `apiCsmApprovalShare` |
| `exports.ts` | entity-mapping export → `apiEntityMappingSummary`, `downloadEntityMappingCsv` |
| `territory.ts` | floating-SE territory + geo → `apiFloatingEngineers`, `apiGeoStates/Regions/Districts`, `apiListTerritory`, `apiAddTerritory`, `apiRemoveTerritory` |
| `org.ts` | Settings CRUD → `listZones/createZone`, `listPlants/createPlant`, `listCompanies/createCompany/updateCompany`, `listUsers/createUser`, `listSlaRules/upsertSlaRule`, `listScoringWeights/upsertScoringWeight`, `listCommonKit/upsertCommonKit`, `listEngineers/createEngineer`, `listSeCoverage/addSeCoverage` |
| `integration.ts` | manual pipeline run → `apiRunPipeline`, `RunPipelineError`, `PipelineSummary` |
| `snapshots.ts` | freshness → `apiSnapshotLatest`, `SnapshotLatestView` |

## `auth/`

| Path | Purpose → Exports |
|---|---|
| `AuthProvider.tsx` | session context (login/logout/rehydrate/proactive refresh/actingZone) → `AuthProvider`, `useAuth` |
| `ProtectedRoute.tsx` | session gate + loading hold → `ProtectedRoute` |
| `RoleRoute.tsx` | role allowlist gate → `RoleRoute` |

## `components/`

| Path | Purpose → Exports |
|---|---|
| `AdminShell.tsx` | stable alias → re-exports `AppShell as AdminShell` |
| `SnapshotBanner.tsx` | freshness banner → `SnapshotBanner` |
| `shell/AppShell.tsx` | authenticated frame (Sidebar+TopBar+acting banner+main+Footer) → `AppShell` |
| `shell/Sidebar.tsx` | dark role-grouped nav (collapse/drawer/tooltip) → `Sidebar` |
| `shell/TopBar.tsx` | breadcrumb title, search, ingestion btn, acting control, profile, logout → `TopBar` |
| `shell/Footer.tsx` | dark footer columns → `Footer` |
| `shell/BrandLogo.tsx` | pinned AutoPlant wordmark → `BrandLogo` |
| `shell/nav.ts` | role→nav model → `buildNav`, `NavGroup`, `NavLink`, `ROLE_LABEL` |
| `shell/SidebarContext.tsx` | collapse+drawer state (localStorage) → `SidebarProvider`, `useSidebar`, `SIDEBAR_STORAGE_KEY` |
| `ui/Button.tsx` | canonical button → `Button`, `ButtonVariant`, `ButtonSize` |
| `ui/Card.tsx` | surfaces → `Card`, `SectionCard` |
| `ui/Input.tsx` | input + label wrapper → `Input`, `Field` |
| `ui/Badge.tsx` | tinted pill → `Badge`, `BadgeTone` |
| `ui/icons.tsx` | 29 inline SVG icons → `Icon*` |
| `ui/index.ts` | barrel |
| `data/DataTable.tsx` | canonical table → `DataTable`, `Column` |
| `data/FilterBar.tsx` | filter strip → `FilterBar`, `SearchInput`, `FilterSelect` |
| `data/MetricStrip.tsx` | KPI cards → `MetricCard`, `MetricStrip`, `Metric`, `MetricTone` |
| `data/PageHeader.tsx` | page title block → `PageHeader` |
| `data/feedback.tsx` | states → `Skeleton`, `EmptyState`, `ErrorState` |
| `data/Toast.tsx` | toast host → `ToastProvider`, `useToast`, `useToastOptional` |
| `data/DateRangeChips.tsx` | range pill toolbar → `DateRangeChips`, `DateRange` |
| `data/RollingNumber.tsx` | KPI odometer → `RollingNumber`, `useRollingNumber` |
| `data/index.ts` | barrel |
| `overlay/Modal.tsx` / `Sheet.tsx` / `Select.tsx` / `Tabs.tsx` / `DropdownMenu.tsx` / `index.ts` | hand-rolled overlays → `Modal`, `Sheet`, `Select`, `Tabs/TabList/Tab/TabPanel`, `DropdownMenu` |
| `charts/ChartCard.tsx` / `BarChartCard.tsx` / `TrendChart.tsx` / `DonutChart.tsx` / `RadialGauge.tsx` / `DistributionBar.tsx` / `ReportGrid.tsx` / `colors.ts` / `index.ts` | recharts wrappers → `ChartCard`, `BarChartCard`+`BarDatum`, `TrendChart`+`TrendDatum`, `DonutChart`+`ChartLegend`, `RadialGauge`, `DistributionBar`+`DistSegment`, `ReportGrid`, `CHART`+`CHART_PALETTE` |
| `domain/badges.tsx` | domain pills → `SLABadge`, `DurationBadge`, `StatusPill`, `TierBadge`, `AgeChip`, `EntityBadge` |
| `domain/TicketCard.tsx` / `Timeline.tsx` / `PlantName.tsx` / `index.ts` | → `TicketCard`, `Timeline`, `PlantName` |

## `hooks/` & `lib/`

| Path | Purpose → Exports |
|---|---|
| `hooks/index.ts` | fetch/mutation/filter hooks → `useApiResource`, `useAsyncAction`, `useFilters` |
| `lib/cn.ts` | clsx+twMerge → `cn` |
| `lib/csv.ts` | CSV build+download → `toCsv`, `downloadCsv` |
| `lib/slaBucket.ts` | bucket vocabulary (single source) → `SLA_BUCKETS`, `SlaBucket`, `CRITICAL_PLUS_BUCKETS`, `criticalPlusCount`, `sumCriticalPlusDevices`, `BUCKET_LABEL`, `BUCKET_RANGE_LABEL`, `BUCKET_LABEL_RANGE`, `BUCKET_HEX`, `BUCKET_CLASS` |
| `lib/inactiveDuration.ts` | duration/count formatting → `formatInactiveOfTotal`, `formatInactiveDuration` |
| `lib/plantNames.ts` | plant code→name → `PLANT_FULL_NAME`, `plantCodePrefix`, `resolvePlantName`, `formatPlantDisplayName` |

## `pages/`

| Path | Purpose (route) |
|---|---|
| `LoginPage.tsx` | login (`/login`) |
| `KitchenSink.tsx` | dev design-system audit (`/_kitchensink`) |
| `dashboard/DashboardHome.tsx` | role selector (`/`) |
| `dashboard/ManagerDashboard.tsx` | data loader + variant selector |
| `dashboard/ZmDashboard.tsx` | Zone Operations body; exports `DashboardData` |
| `dashboard/CentralDashboard.tsx` | CSM Central Tower body |
| `dashboard/OpsHeadDashboard.tsx` | OH Pan-India body (RollingNumber KPIs, SLA DistributionBar) |
| `dashboard/WarehouseDashboard.tsx` | WM dashboard (+stock adjust Modal) |
| `dashboard/ActionRequiredPanel.tsx` / `ZoneOverviewTable.tsx` / `CompanyPlantTable.tsx` / `ScorecardTable.tsx` / `EscalationQueueList.tsx` / `CriticalQueue.tsx` | dashboard sections |
| `dashboard/RunIngestionButton.tsx` / `ingestionEvents.ts` | OH manual ingestion trigger + pub/sub |
| `tickets/TicketsPage.tsx` / `TicketDetailDrawer.tsx` / `ticketBadges.tsx` | tickets (`/tickets`, `/tickets/:ticketId`) |
| `schedules/SchedulesPage.tsx` / `ScheduleDetailPage.tsx` / `IntradayQueuePage.tsx` | schedules (`/schedules`, `/schedules/:engineerId`, `/intraday`) |
| `engineers/SeManagementPage.tsx` / `SeManagementDirectoryPage.tsx` / `LeaveRequestsPage.tsx` | SEs (`/engineers`, `/engineers/manage`, `/leave-requests`) |
| `planner/PlannerPage.tsx` | planner grid (`/engineers/planner`) |
| `readiness/VehicleUnavailabilityPage.tsx` / `NonOperationalQueuePage.tsx` / `RecoveryDecisionQueuePage.tsx` | readiness queues |
| `inventory/ComponentBlockedPage.tsx` / `ComponentRequestsPage.tsx` / `ShadowUseQueuePage.tsx` | component queues |
| `warehouse/RecoveryReceiptQueuePage.tsx` | WM receipt queue |
| `cross-zone/CrossZonePage.tsx` | cross-zone escalations |
| `install/InstallCreatePage.tsx` | install create (single + CSV) |
| `verification/VerificationReviewPage.tsx` | GPS verification review |
| `vouchers/VoucherReviewPage.tsx` | expense vouchers (+OH finance) |
| `reports/ReportsPage.tsx` / `DeviceDetailPage.tsx` / `RootCauseAnalyticsPage.tsx` / `SystemEfficiencyPage.tsx` / `ZmScorecardPage.tsx` / `CsmApprovalSharePage.tsx` | reports suite |
| `exports/ExportsPage.tsx` | OH exports hub |
| `coverage/TerritoryPage.tsx` | floating-SE territory |
| `settings/SettingsPage.tsx` / `sections.tsx` | OH settings console (9 tabs; sections exports `SlaRulesTable`, `AccessMatrixGrid`, 8 CRUD sections, local `useList`) |
| `help/HelpCenterPage.tsx` | help center (exports `buildHelpSections`) |

## Outside `src` (context)

`apps/admin/test/*` — vitest specs (selector contracts) · `apps/admin/visual/*` — Playwright capture/compare · `packages/shared/src/index.ts` — `ROLES`, `Role`, `SessionView`, `LoginRequest/Response`, `SlaBucket`, `SLA_BANDS`.
