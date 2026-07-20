# 06 — Pages

> Part of the [UI Redevelopment Handoff](20-master-index.md). Previous: [05 — Modules](05-modules.md) · Next: [07 — Components](07-components.md).

Every page below (except LoginPage/KitchenSink) renders inside [AppShell](04-layout.md). "Selectors" lists the `aria-label` / `data-testid` contracts the test suite asserts — **preserve them verbatim** (see [16 — Constraints](16-business-constraints.md)). Endpoint signatures: [10 — API](10-api.md).

---

## LoginPage — `/login` — `pages/LoginPage.tsx`
- **Purpose**: authenticate; the only public page. Own dark split layout (see [04](04-layout.md)).
- **Form**: controlled email/password; show/hide password toggle (`aria-label` "Show"/"Hide" — deliberately not containing "password"); submit via `useAuth().login` → `navigate('/', {replace:true})`.
- **States**: `sessionExpired` amber `role="status"` notice; error `role="alert"` mapping `LoginError.code` → "Invalid email or password" | "Service unavailable — please try again in a moment"; submitting → Button `loading`.
- **Static chrome**: 4 KPI tiles + feature list + "Remember me"/"Forgot Password?" (non-functional).
- **APIs**: `POST /auth/login`, `GET /me` (via AuthProvider).

## KitchenSink — `/_kitchensink` (dev only) — `pages/KitchenSink.tsx`
Renders every primitive/badge/chart/overlay for visual audit + Playwright parity. Not shipped to production. Useful as a living catalog during redesign.

---

# Dashboard module (`/`)

## DashboardHome — `pages/dashboard/DashboardHome.tsx`
Role selector: `WAREHOUSE_MANAGER` → WarehouseDashboard; everyone else → ManagerDashboard. No UI of its own.

## ManagerDashboard — `pages/dashboard/ManagerDashboard.tsx`
Data loader, no UI. `Promise.all` of `apiActionRequired`, `apiZoneOverview`, `apiCompanyPlantOverview`, `apiCriticalQueue` (+`apiZoneEngineers` best-effort for the assign picker). Selects the body: OH (not acting) → OpsHeadDashboard; CSM (not acting) → CentralDashboard; otherwise (ZM, or anyone acting) → ZmDashboard. Passes `DashboardData` = `{zones, companyPlants, critical, actions, engineers, error, onAssigned (refetch critical), onDataRefetch (full reload)}`.

## ZmDashboard ("Zone Operations Dashboard")
- **Layout**: PageHeader (+"Snapshot Healthy" Badge + DateRangeChips) → 4-KPI MetricStrip (Fleet Uptime "—", Inactive Devices, Critical+ Devices [`kpi-critical-plus`], Action Required) → ActionRequiredPanel → ZoneOverviewTable → CompanyPlantTable → CriticalQueue.
- KPI math uses `sumCriticalPlusDevices` from `lib/slaBucket` — **the** Critical+ definition; do not re-derive.

## CentralDashboard ("Cross-Zone Central Tower") — CSM
PageHeader → 4 KPIs (Fleet Uptime "—", Zones Covered, Inactive Devices, Escalations) → EscalationQueueList → ScorecardTable → CompanyPlantTable.

## OpsHeadDashboard ("Pan-India Fleet Command") — OH
PageHeader → 4 KPIs with **RollingNumber odometers** keyed on manual-ingestion completion (`onIngestionComplete` subscription → `onDataRefetch` → bump `runToken`) → "Auto-Dispatch System Efficiency" MetricStrip (all "—" placeholders, gated on BE-42 — **do not fabricate values**) → "SLA Bucket Distribution" `DistributionBar` (segments from `SLA_BUCKETS`×`BUCKET_HEX`×`BUCKET_LABEL_RANGE`) → ScorecardTable → CompanyPlantTable.

## WarehouseDashboard ("Zone Warehouse Fulfillment") — WM
- **Selectors**: root `data-testid="warehouse-dashboard"`; tables `aria-label` "Component Request Queue", "Warehouse Stock", "Shadow-Use Reconciliation"; `stock-row-<componentId>`, `stock-adjust-<componentId>`, `stock-save`.
- PageHeader → 4 KPIs (Open Requests, Tickets Blocked, Low-Stock SKUs, Fulfillment SLA %) → SectionCard "Component Request Queue" (DataTable: Component/Company/Requested by/StatusPill/AgeChip; "Open queue →" link) → SectionCard "Warehouse Stock" (DataTable: Component/Zone/On hand/Reserved/Available+Low badge/Threshold/Adjust) → **Adjust-stock Modal** (On hand / Reserved / Low-stock threshold number Fields; Save → `apiSetWarehouseStock`) → SectionCard "Shadow-Use Reconciliation" (read-only 4-col table + link).
- **APIs**: `apiComponentRequests`, `apiComponentBlocked`, `apiShadowUse`, `apiWarehouseStock`, `apiFulfillmentSla`, `apiSetWarehouseStock`. Adjust visible to WM/OH (`canAdjust`).

### Dashboard sub-components
- **ActionRequiredPanel**: urgency-ordered card grid (`data-testid="action-card"`); unavailable sources render "coming soon" stubs at 70% opacity — never fake counts.
- **ZoneOverviewTable** (`aria-label="Zone Overview"`): DataTable, one row/zone: zone, `zone-inactive-total` "inactive / total", 8 per-bucket count pills (`bucket-<B>`, header shows label **and** derived range `BUCKET_RANGE_LABEL`), `trend` cell ("—" until history lands). FilterBar: zone select (`aria-label="Filter by zone"`), bucket select ("Filter by bucket"), "Export Zone Overview" CSV button (client `toCsv`/`downloadCsv`).
- **CompanyPlantTable** (`aria-label="Company/Plant Overview"`): **bespoke table** (not DataTable — grouped rows): company header rows (name + TierBadge) → plant rows (PlantName, `plant-inactive-total`, bucket pills, "View devices"/"Hide devices" toggle `aria-expanded`) → expanded device sub-panel (lazy `apiTicketsByPlant(plantId)`: skeletons → EmptyState or device list with DurationBadge + StatusPill). Company filter (`aria-label="Filter by company"`) + "Export Company/Plant Overview" CSV.
- **ScorecardTable** (`aria-label="Zone Performance Scorecard"`): sortable DataTable — Zone, `scorecard-inactive-total`, `scorecard-critical-plus` (via `criticalPlusCount`), Worst Bucket SLABadge.
- **EscalationQueueList**: flattens critical groups into severity-sorted `escalation-item` rows (Device + TierBadge, company · PlantName, DurationBadge).
- **CriticalQueue** (`critical-group` cards, 2-up grid): per company/plant cluster — name + TierBadge + PlantName + "Cluster: n" Badge, ticket list (Device + DurationBadge), **AssignControl**: "Assign to" FilterSelect of zone SEs + Assign button (disabled until picked) → `apiAssignTicket` per ticket → `onAssigned`.
- **RunIngestionButton** (lives in TopBar): OH-only; confirm Modal ("Run ingestion now?" → `run-ingestion-confirm`); while running: red pulsing `ingest-live` style, cycling verbs ("Ingesting…Sautéing…"), sr-only "Running ingestion…", `aria-live="polite"`, `run-ingestion-btn`; success toast with `PipelineSummary` numbers; `RUN_IN_PROGRESS` skip → info toast.

---

# Tickets

## TicketsPage — `/tickets` — `pages/tickets/TicketsPage.tsx`
- **Selectors**: table `aria-label="Tickets"`; filters `aria-label` "Work type" / "Status" / "SLA bucket" / "Assignment state" / "Company ID" / "Plant ID"; badges `bucket-<B>`, `badge-REPEAT|ESCALATED|WAITING_COMPONENT|AUTO_RECOVERY`.
- PageHeader ("Ticket Operations", Clear-filters ghost button when filtered) → FilterBar (4 selects + 2 search inputs; values map to `TicketFilters` query params) → DataTable (stickyHeader): Ticket (#id8 + Device), Work Type, Plant/Company ids, TierBadge, StatusPill, Inactive (BucketBadge = elapsed duration), AgeChip, Flags (InlineBadges). Row click → `/tickets/:id`. Loading skeletons, error+Retry, EmptyState (icon + clear-filters action).
- Server returns rows pre-sorted (SLA-bucket desc) and zone-scoped — **client does not re-sort**.
- `<Outlet/>` renders the drawer beside the list.

## TicketDetailDrawer — `/tickets/:ticketId` — `pages/tickets/TicketDetailDrawer.tsx`
- **Inline `aside` panel** (`aria-label="Ticket detail"`, w-96, NOT the shared Sheet; still uses legacy slate styling), close → `/tickets`.
- Hand-rolled `role="tablist"` (`aria-label="Ticket detail tabs"`): Overview / Lifecycle / Forms / Verification / Components / Assignment History; `?tab=` deep-link support.
- **Overview**: dl of device/work type/status/plant/tier/BucketBadge/InlineBadges. Managers + RECOVERY work type + non-terminal → "Manually close Recovery Ticket" (`recovery-manual-close`) opening a **Modal** with mandatory reason textarea (`recovery-close-reason`, confirm `recovery-close-confirm`) → `apiManualCloseRecovery` → navigate to `/tickets`.
- **Lifecycle**: transition list (toState, fromState, actorRole|'system', timestamp).
- **Forms** (lazy on tab open, `apiTicketForms`): per submission `form-<id>` card — root cause, subcategory, action, notes, component-unavailable flag, SE, time.
- **Verification** (lazy, `apiTicketVerification`; panel `verification-panel`): badge/phase/pings; fraud flag + distance.
- **Components** (lazy, `apiComponentRequestsByTicket`): `waiting-component-badge` when `failureCycleState === 'WAITING_COMPONENT'` (with since-date); `cr-<requestId>` cards with status chip, shipped destination/tracking, rejection reason, age.
- **Assignment History** (`assignment-history-panel`): lifecycle events with non-null `actorRole` (+`actedAsRole`).

---

# Schedules

## SchedulesPage — `/schedules`
- **Selectors**: `aria-label="Batch Schedules"`, `schedule-status-<STATUS>`.
- PageHeader ("Batch Schedule" — *monitoring only, no Approve gate: a removed business decision, don't reintroduce*) → 4 KPIs (Schedules / Auto-Assigned / Overridden / Tickets) → DataTable (stickyHeader): Engineer, Dates, Batches, Tickets, Status Badge (AUTO_ASSIGNED neutral / OVERRIDDEN warning). Row click → `/schedules/:seId`.

## ScheduleDetailPage — `/schedules/:engineerId`
- **Selectors**: `schedule-stop`, `ticket-row-<id>`, `schedule-status-<S>`, `onsite-conflict-banner`, `ticket-sla-<id>`, `ticket-tier-<id>`, `ticket-partial-<id>`.
- Back link → header (seId + date range + status Badge) → optional **ON_SITE conflict banner** (`role="alert"`: message + affected tickets + Confirm override / Cancel — a held `OverrideCommand` retried with `confirm:true`) → ordered Stop cards.
- **Stop card**: "Stop n" + PlantName + AUTO/OVERRIDDEN Badge + device count + per-stop actions **Swap SE / Split batch / Reorder**, each expanding an inline form (SePicker from zone engineers excluding self; mandatory ReasonInput; Reorder takes a position number; Split adds per-ticket checkboxes). Ticket rows: "Ticket <id>" + TicketStateBadges (SLA/Tier/PARTIAL) + collapsed "Why suggested?" reasoning chip + per-ticket **Remove / Defer (date) / Reassign** inline forms — all mandatory-reason, all → `apiOverrideBatch(batchId, cmd)` then refetch.
- Override command vocabulary (**API contract**): `REMOVE_TICKET`, `DEFER_TICKET`, `REORDER`, `SWAP_SE`, `SPLIT_BATCH`, `REASSIGN` — with `reasonCode` free text, optional `confirm`.

## IntradayQueuePage — `/intraday`
- **Selectors**: `aria-label="Intra-day Queue"`, `iq-metric-strip`, `iq-metric-<TYPE>`, `iq-row-<auditId>`.
- PageHeader → 3 MetricCards (ADD success / REMOVE critical / REORDER info) → DataTable with row accents by type: Event Badge, Ticket link (→ drawer), SE, "SE Acceptance" placeholder column ("No acceptance required"), By, At. Read-only.

---

# Engineers

## SeManagementPage ("SE Activity") — `/engineers`
- **Selectors**: `aria-label="SE Management"` (table), `se-metric-<STATUS>`, `se-row-<seId>`, section `aria-label="SE detail"`.
- PageHeader (+DateRangeChips) → 5 MetricCards (BUSY/ON_SITE/AVAILABLE/OFFLINE/SHIFT_ENDING via `ACTIVITY_TONE`) → split layout: DataTable (SE name button → detail, Activity Badge, Coverage, Availability, Active Tickets, Kit OK/Kit short Badge) + right detail panel (Day Plan status/count, Van Stock list + red shortages, Availability windows, and — **ZM/CSM only, never OH** — Set Availability form: status select of `ON_LEAVE|OFF_SHIFT|WEEKLY_OFF|SOFT_UNAVAILABLE`, window start (required)/end datetime-locals, reason → `apiSetAvailability`).

## SeManagementDirectoryPage ("Manage SEs") — `/engineers/manage`
- **Selectors**: `aria-label="SE Directory"`, `se-dir-<seId>`, section `aria-label="SE edit"`.
- PageHeader (zone filter select for CSM/OH; a ZM gets no filter and a locked pre-filled Zone field) → SectionCard "Add Service Engineer" create form (Name/Phone/Email/Address/Zone/Coverage Type DEDICATED|MULTI_PLANT/Daily Capacity; submit disabled until required set; success `role="status"`, backend error-code → message map incl. `SE_IDENTITY_TAKEN`, `ZONE_CHANGE_WITH_COVERAGE`, `CROSS_ZONE_COVERAGE_FORBIDDEN`, `FLOATING_USES_TERRITORY`…) → split: directory DataTable (Name button, Phone, Email, Address, Zone, Mapped Plants, Mapped Companies "—", Active/Inactive Badge) + right edit panel (edit details form + Save; Coverage list with per-plant Remove + add-coverage plant/type selects; Deactivate/Reactivate toggle; `role="alert"` panel errors).
- **APIs**: `engineersAdmin` CRUD + `org.listZones`/`listPlants`.

## LeaveRequestsPage — `/leave-requests`
- **Selectors**: `aria-label="Leave Requests"` (plain `<table>` — legacy slate styling, not DataTable), `lr-row-<id>`.
- Columns: Engineer, Type, Window, Reason, Status chip (+ rejection reason). ZM/CSM (`canDecide`, OH read-only): Approve (direct) / Reject → inline "Reject reason" input + Confirm/Cancel → `apiRejectLeave(id, reason)`.

---

# Planner

## PlannerPage — `/engineers/planner`
- **Selectors**: `aria-label="SE Planner grid"` (bespoke table), `plant-drag-source`, `cell-<seId>-<date>`, `intent-<id>`, `batch-<seId>`, `batch-status-<seId>`; drag payload `dataTransfer` type **`text/plant-id`** (contract).
- PageHeader (7-day window dates, DateRangeChips) → 4 KPIs (Engineers/Plant Intents/Planned SEs/Window) → plant picker (select + draggable chip) → grid: rows = zone SEs (id, Coverage Badge, Batch Schedule Badge or "No batch"), columns = 7 days; cells accept drop or "+ add" click → `apiCreatePlannerEntry`; intent chips with × → `apiDeletePlannerEntry`; refetch after every write.

---

# Readiness

## VehicleUnavailabilityPage — `/readiness/vehicle-unavailability`
- **Selectors**: `aria-label="Vehicle Unavailability Reports"`, `vu-metric-strip`, `vu-metric-open|paused|contacted`, `vu-row-<id>`, `vu-primary-<id>`, `vu-secondary-<id>`.
- PageHeader (+DateRangeChips) → 3 MetricCards (Open / SLA paused / Transporter contacted) → DataTable (row accent warning when paused): Report id8, Ticket link, PlantName, Reason label (+"transporter contacted"), Filed by, Expected date, **Primary SLA** ("Hh Mm", "(paused)") in warning color, **Secondary SLA** (never pauses) in critical color, StatusPill, Actions: **Confirm date** (inline datetime-local + Save/Cancel → `apiConfirmVuDate`) / **Resume SLA** (→ `apiResumeVuSla`). The secondary clock is manager-only *by virtue of this gated page* — keep it here.

## NonOperationalQueuePage — `/readiness/non-operational`
- **Selectors**: `aria-label="Non-Operational dual confirmation"`, `nonop-row-<id>`, `nonop-confirm-<id>`, `nonop-override-<id>`; modal `role="dialog" aria-label="Mark Non-Operational"`.
- PageHeader + "Mark Non-Operational" CTA → 1 MetricCard (Awaiting Confirmation) → DataTable: Device, Reason, Deal Type, State Badge (Awaiting Manager warning / Awaiting Customer info / Confirmed success; ↻ recovery-ticket id when auto-created), Awaiting days Badge (≥7 critical, ≥3 warning), Actions: **Confirm** (state AWAITING_ZM_CONFIRMATION) / **Override-confirm** (OH only, `window.prompt` reason — Modal upgrade filed as #72).
- **MarkNonOperationalModal** (hand-rolled dialog, not shared Modal): Device ID input, Reason select (7 codes), free-text when OTHER; fetches deal type (`apiGetDeviceDealType`) when device numeric + reason ∈ `RECOVERY_REASONS`; **RECURRING device ⇒ amber warning + mandatory acknowledge checkbox** ("A Recovery Ticket will be auto-created…"); submit `apiRequestNonOp`.

## RecoveryDecisionQueuePage — `/readiness/recovery-decisions`
- **Selectors**: `aria-label="Recovery decision queue"`, `rdq-row-<id>`, `rdq-reschedule-<id>`, `rdq-close-failed-<id>`, `rdq-escalate-<id>`.
- PageHeader → 1 MetricCard (Awaiting Decision, critical) → DataTable: Ticket id8, Device, Unable reason Badge, Actions: **Reschedule** (`window.prompt` SE id), **Close FAILED_RECOVERY** (`window.prompt` mandatory reason), **Escalate to OH** (direct). Prompts scheduled for Modal (#72).

---

# Inventory / Warehouse

## ComponentBlockedPage — `/component-blocked` (managers, read-only)
- **Selectors**: `aria-label="Component-Blocked Queue"`, search `aria-label="Search blocked tickets"`, `cbq-row-<ticketId>`.
- PageHeader → 4 KPIs (Blocked / Warehouse Overdue >7d / Engineers Affected / Oldest) → FilterBar (client-side substring search over company/zone/SE) → DataTable (sortable Age): Company, Zone, Engineer, Missing parts ("name (×n)"), Warehouse ("Warehouse Overdue" warning Badge or wmActionStatus), Age. Row click → ticket `?tab=Components`. Uses `useApiResource`.

## ComponentRequestsPage — `/warehouse/requests` (WM, actionable) and `/component-requests` (managers, `readOnly` prop)
- **Selectors**: `aria-label="Component Requests"`, `cr-metric-strip`, `cr-metric-<STATUS>`, `cr-row-<id>`.
- PageHeader → 3 MetricCards (REQUESTED/APPROVED/SHIPPED) → DataTable: Request id8, Company, Zone, Component, Requested by, Ticket link (`?tab=Components`), StatusPill, AgeChip, Actions — readOnly ⇒ "read-only" text; else REQUESTED ⇒ **Approve** / **Reject** (inline "Rejection reason" Field + Confirm/Cancel); APPROVED ⇒ **Mark Shipped** (inline Tracking ref Input + Delivery destination select SE_LOCATION|PLANT_WAREHOUSE + Confirm ship/Cancel).

## ShadowUseQueuePage — `/warehouse/shadow-use` (WM)
- **Selectors**: `aria-label="Shadow Use Queue"`, `su-metric-UNRECONCILED`, `su-row-<id>`.
- 1 MetricCard (Unreconciled) → DataTable: Ticket link, Component, Qty, Engineer, Company, AgeChip, Actions: **Reconcile** (direct) / **Dispute** (inline mandatory "Dispute reason" + Confirm/Cancel).

## RecoveryReceiptQueuePage — `/warehouse/recovery-receipt` (WM)
- **Selectors**: `aria-label="Awaiting Warehouse Receipt"`, `rcv-row-<id>`, `rcv-receipt-<id>`.
- 1 MetricCard → DataTable: Ticket id8, Device, Confirmed serial, Condition notes, StatusPill, **Confirm Receipt** (single click → `apiConfirmRecoveryReceipt` → auto-closes the Recovery Ticket).

---

# Cross-Zone / Install / Verification / Vouchers

## CrossZonePage — `/cross-zone`
- **Selectors**: tables `aria-label` "Cross-Zone Auto-Escalations" / "Cross-Zone Manual Flags"; `cz-row-<id>`, `cz-approve-<id>`, `cz-deny-<id>`, `cz-defer-<id>`, `cz-sweep`.
- PageHeader → (deciders CSM/OH) "Run auto-escalation sweep" button → 2 MetricCards (Auto-Escalations / Manual Flags) → two DataTables split by `escalationType` (AUTO_PLATINUM / MANUAL_FLAG): Ticket id8, Company id + TierBadge, SLABadge, StatusPill, Age, and for deciders Approve (`window.prompt` target zone + SE) / Deny (prompt reason) / Defer (prompt date + reason). ZM sees read-only.

## InstallCreatePage — `/install`
- PageHeader → 2-up SectionCards: **Single Install** form (Vehicle No, Plant select [zone-scoped for ZM], Company select, Device Type, Device ID, optional SIM/Target Date/Notes; disabled-until-valid; success `role="status"` "Created install ticket <id>"; error-code map incl. `VEHICLE_ALREADY_MAPPED`, `ZONE_FORBIDDEN`…) and **CSV bulk upload** (mono textarea, header documented in label; success batch summary; `CSV_VALIDATION_FAILED` ⇒ row-error DataTable `aria-label="CSV errors"` Line/Error/Field).
- **APIs**: `createInstall`, `uploadInstallCsv`, `org.listPlants(zoneScope)`, `org.listCompanies`.

## VerificationReviewPage — `/verification`
- **Selectors**: table `aria-label="Verification review"` (legacy plain table), `vr-row-<ticketId>`, filters `aria-label` "Outcome filter"/"Company filter"; escalation `role="dialog" aria-label="Escalate verification"`.
- PageHeader → 4-KPI MetricStrip (In Review/Partial/Failed/Closed+Auto) → ChartCard "Verification outcomes" (DonutChart + center total + ChartLegend) → outcome/company filters → table: Company, Zone, Device, OutcomeCell (PARTIAL "n/3 pings · Xh left", FAILED_FRAUD "m off", FAILED_NO_PINGS, CLOSED, AUTO), Actions: **Escalate** (fraud rows → inline reason dialog block) / **Mark auto-recovery** (partial/no-pings). Row click → ticket `?tab=Verification`.

## VoucherReviewPage — `/vouchers`
- **Selectors**: `aria-label="Expense Vouchers"`, `voucher-metric-strip|count|overlimit|selected`, `voucher-row-<id>`, `voucher-overlimit-<itemId>`, `voucher-activity-<id>`.
- PageHeader → (OH only) view toggle **To review / Approved (Finance)** + Finance controls (month `YYYY-MM` Input + **Export Finance** CSV download + Batch ref Input + **Mark PAID** disabled until selection) → 2–3 MetricCards → DataTable: (approved view: selection checkboxes) Voucher id8, SE, Zone, Items (per line: category ₹amount, red+testid when overLimit with limit tooltip, 📎 photo button → **lightbox Modal** "Expense proof"), (review view) Activity cell (linked ticket button or "⚠ No activity link" / "ticket missing"), Total ₹, Submitted, StatusPill, Actions: **Approve** (direct) / **Reject** / **Needs clarification** (inline reason/comment Field + confirm) — all via `apiReviewVoucher`.

---

# Reports

## ReportsPage — `/reports`
- PageHeader (+disabled "Export" button — endpoint pending) → 6-KPI MetricStrip (Fleet Uptime %, Total Inactive, Critical+, Eligible Devices, Auto-Recovered, SE-Repaired) → ReportGrid pairs: "Inactivity by SLA bucket" BarChartCard (BUCKET_HEX colors) | "Fleet Uptime % — last 6 months" TrendChart; "Soft-Inactive count trend" (OH-only endpoint — other roles see gated EmptyState "Available to Operations Head") | "Fleet Uptime % by zone" bars; "Work type mix" | "Verification outcomes" — **gated placeholders (→ #90), never fabricate** → ChartCard "Zone breakdown" DataTable (`report-zone-<id>`): Zone, Inactive w/ work, Critical+, Fleet Uptime %.
- **APIs**: `apiFleetUptime({groupBy:'zone'})`, `apiFleetUptimeTrend(6)`, `apiZoneOverview`, `apiSoftInactiveTrend({days:14})`.

## DeviceDetailPage — `/reports/device`
- **Selectors**: `aria-label="Device list"`, `dev-row-<deviceId>`, `device-list-count`, `device-page-prev|next|status` (`aria-label="Device list pages"`), `device-stats`, `deal-type-control|recurring|onetime`, `trend-summary-toggle`, "Downtime summary" table.
- PageHeader → "Search devices" Field → FilterBar: Sort (5 whitelisted `DeviceSort` values), Status ALL|INACTIVE|ACTIVE, SLA bucket, Zone (incl. UNZONED when present), Company — options from `apiDeviceFilterOptions` → ChartCard "Devices" with **server-paged** DataTable (PAGE_SIZE 100, offset pager, "Showing x–y of z"; filter change resets to page 1); columns Device ID / Vehicle Number / Company Name / PlantName / Zone / Inactive Duration / SLABadge `showRange`; row click selects → detail cards below: SectionCard header (device · vehicle · type · company · "Deal: …") + 6 lifetime stat tiles + (OH) **deal-type tag buttons Recurring/One-time** (`apiSetDealType`); SectionCard "Current failure cycle" (dl: bucket badge, root cause, repeat, component-related, verification); ChartCard "Lifetime downtime trend" with Chart ↔ Summary-table toggle.
- **APIs**: `apiDeviceList`, `apiDeviceFilterOptions`, `apiDeviceCycles`, `apiDeviceDowntimeTrend`, `apiSetDealType`.

## RootCauseAnalyticsPage — `/reports/root-cause`
3-KPI strip (Total Submissions / Distinct Causes / Top Cause) → "Distribution by root cause" BarChartCard (%) → "Breakdown" DataTable (`rc-row-<category>`): cause/tickets/share. `apiRootCause`.

## SystemEfficiencyPage — `/reports/system-efficiency`
6-KPI strip (Auto-Dispatch/Override/First-Time Fix/Auto-Recovery/Failed Verification/Auto-Escalations) → "Auto-dispatch % by zone" bars | "SE active load vs capacity" gated placeholder → "Efficiency by zone" DataTable (`eff-row-<zoneId>`). `apiSystemEfficiency`.

## ZmScorecardPage — `/reports/zm-scorecard` (OH only)
"Top performer" SectionCard (`zm-leader`: highest zoneSlaCompliancePct) → "Scorecard" DataTable (`zm-row-<zmId>`): ZM, Zone, Overrides, Override rate, Manual assigns, Zone SLA %. `apiZmScorecard`.

## CsmApprovalSharePage — `/reports/csm-approval-share` (OH only)
4-KPI strip (CSM-acted / Total acted / Overall share % / Zones tracked) → "CSM share by zone (%)" bars → DataTable (`csm-row-<zoneId>`, `aria-label="CSM Backup Share"`). `apiCsmApprovalShare`.

---

# Exports / Coverage / Settings / Help

## ExportsPage — `/exports` (OH only)
PageHeader → card grid (currently one): SectionCard "Entity mapping (CSV)" — description, `entity-mapping-hint` (row count + data-as-of from `apiEntityMappingSummary`), **Download CSV** button (`download-entity-mapping`, `loading` while downloading, error alert, "Last downloaded …"). `downloadEntityMappingCsv` fetches `GET /exports/entity-mapping` and triggers a blob download.

## TerritoryPage — `/coverage` (OH only)
PageHeader → "Engineer" FilterSelect of FLOATING SEs → (once picked) 2-up SectionCards: "Current territory" DataTable (`aria-label="Current territory"`: describe row as District/Region/State + Remove) and "Add coverage" cascading selects State → Region ("Whole state…") → District ("Whole region…") + "Add to territory" (adds at most-specific level) + disabled "Draw polygon on map (coming soon)" (**reserved affordance — keep visible**). APIs: `territory` module (`/org/geo/*`, `/org/se-territory`).

## SettingsPage — `/settings` (OH only)
PageHeader (+DateRangeChips + role Badge) → hand-rolled `role="tablist" aria-label="Settings sections"` tabs: **Zones / Plants / Users / Companies / SE Coverage / SLA Rules / Scoring Weights / Common Kit / Access** → `role="tabpanel"` rendering the section from `pages/settings/sections.tsx`. Each CRUD section = list table + inline create form over `api/org` (list+create; companies also PATCH edit; SLA rules PUT upsert; weights/kit POST upsert). `SlaRulesTable` renders the read-only color-coded bucket legend derived from shared `SLA_BANDS`; `AccessMatrixGrid` (`aria-label="Role access matrix"`) is a static feature×role check table mirroring the nav. Sections use a local `useList` hook and local styling constants (`inputClass`, `btnClass`), plus form `aria-label`s asserted by tests.

## HelpCenterPage — `/help` (all roles)
PageHeader → role-scoped SectionCards of topic Cards (title, description, "View Docs →" Link to the in-app route) built by `buildHelpSections(role)` (mirrors nav logic: WM → own module only; managers add Components & Analytics; OH adds Admin) → "Model states & terminology" glossary card grid (6 static entries). No backend.

---

## Cross-page state/UX conventions

- **Loading**: DataTable skeleton rows (5×), or `<p class="text-ink-muted">Loading…</p>` on non-DataTable pages.
- **Error**: `role="alert"` paragraph/box in `text-critical` (+ per-table `ErrorState` with Retry where wired).
- **Empty**: `EmptyState` (message, optional icon + action) or an `empty` string prop on DataTable.
- **Success**: `role="status"` paragraphs or toasts (`useToast`).
- **Timestamps**: `toLocaleString()` or ISO slicing (`iso.slice(0,10)` / `(0,16)`); durations via `formatInactiveDuration`; money via `₹` + `toLocaleString('en-IN')`.
