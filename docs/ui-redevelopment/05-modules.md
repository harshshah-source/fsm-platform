# 05 — Feature Modules

> Part of the [UI Redevelopment Handoff](20-master-index.md). Previous: [04 — Layout](04-layout.md) · Next: [06 — Pages](06-pages.md).

Each module = a `src/pages/<folder>` + the `src/api/` modules it consumes. Shared contexts (Auth, Toast, Sidebar) are used everywhere and not repeated per row. Per-page detail is in [06 — Pages](06-pages.md); API signatures in [10 — API](10-api.md).

| Module | Purpose | Pages folder | Pages | Feature-local components | API modules used | Hooks used |
|---|---|---|---|---|---|---|
| **Auth** | Login, session, role gates | `pages/` + `auth/` | LoginPage | — | `client` (login/me), `http` (refresh), `tokens` | useAuth |
| **Dashboard** | Role-variant landing (`/`) | `pages/dashboard/` | DashboardHome (selector), ManagerDashboard (data loader), ZmDashboard, CentralDashboard, OpsHeadDashboard, WarehouseDashboard | ActionRequiredPanel, ZoneOverviewTable, CompanyPlantTable, ScorecardTable, CriticalQueue (+AssignControl), EscalationQueueList, RunIngestionButton, ingestionEvents (pub/sub) | `dashboard`, `schedules` (zone engineers + assign), `tickets` (by-plant drilldown), `componentRequests`/`inventory`/`shadowUse` (WM variant), `integration` (run pipeline) | useAuth, useToastOptional, useRollingNumber |
| **Tickets** | Ticket list + detail drawer | `pages/tickets/` | TicketsPage, TicketDetailDrawer | ticketBadges (BucketBadge, InlineBadges) | `tickets`, `componentRequests` (by ticket), `verification` (per ticket), `recovery` (manual close) | useAuth |
| **Schedules** | Batch-schedule monitoring + ZM overrides; intra-day updates | `pages/schedules/` | SchedulesPage, ScheduleDetailPage, IntradayQueuePage | Stop, TicketRow, ReasonInput, SePicker, TicketStateBadges, WhySuggested (all in ScheduleDetailPage) | `schedules`, `intradayUpdates` | — |
| **Engineers (SE)** | SE activity status, directory CRUD, leave approvals | `pages/engineers/` | SeManagementPage, SeManagementDirectoryPage, LeaveRequestsPage | — | `engineers`, `engineersAdmin`, `org` (zones/plants), `leaveRequests` | useAuth |
| **Planner** | ZM plant-visit intent grid (drag/drop) | `pages/planner/` | PlannerPage | — | `planner`, `schedules` | — |
| **Readiness** | Vehicle unavailability, non-op dual confirmation, recovery decisions | `pages/readiness/` | VehicleUnavailabilityPage, NonOperationalQueuePage (+MarkNonOperationalModal), RecoveryDecisionQueuePage | MarkNonOperationalModal (in-file) | `vehicleUnavailability`, `nonOp`, `recovery` | useAuth |
| **Inventory / Components** | Component-blocked queue, component requests (WM + oversight), shadow use | `pages/inventory/` | ComponentBlockedPage, ComponentRequestsPage (dual-route), ShadowUseQueuePage | — | `inventory`, `componentRequests`, `shadowUse` | useApiResource |
| **Warehouse** | Recovery receipt confirmation | `pages/warehouse/` | RecoveryReceiptQueuePage | — | `recovery` | — |
| **Cross-Zone** | Escalation queue (auto Platinum + manual flags), decider actions | `pages/cross-zone/` | CrossZonePage | — | `crossZone` | useAuth |
| **Install** | Manual Install-Ticket creation (single + CSV bulk) | `pages/install/` | InstallCreatePage | — | `install`, `org` (plants/companies) | useAuth |
| **Verification** | GPS verification review + escalation | `pages/verification/` | VerificationReviewPage | OutcomeCell (in-file) | `verification` | — |
| **Vouchers** | Expense voucher review + OH Finance export/mark-paid | `pages/vouchers/` | VoucherReviewPage | — | `vouchers` | useAuth |
| **Reports** | Analytics suite | `pages/reports/` | ReportsPage, DeviceDetailPage, RootCauseAnalyticsPage, SystemEfficiencyPage, ZmScorecardPage, CsmApprovalSharePage | — | `reports`, `devices`, `dashboard` (zone-overview), `roleBackup` | useAuth |
| **Exports** | OH raw-data downloads | `pages/exports/` | ExportsPage | — | `exports` | — |
| **Coverage** | Floating-SE territory config | `pages/coverage/` | TerritoryPage | — | `territory` | — |
| **Settings** | OH org configuration console | `pages/settings/` | SettingsPage | `sections.tsx`: ZonesSection, PlantsSection, UsersSection, CompaniesSection, SeCoverageSection, SlaRulesSection (+read-only SlaRulesTable legend), ScoringWeightsSection, CommonKitSection, AccessMatrixGrid; local `useList` hook + local Field | `org` | — |
| **Help** | Role-scoped static docs + glossary | `pages/help/` | HelpCenterPage | HelpTopicGrid, GlossaryCard, `buildHelpSections(role)` | none (static) | useAuth |
| **Dev** | Design-system audit | `pages/` | KitchenSink | — | none | — |

## Cross-module glue

- **Shell/nav** (`components/shell/nav.ts`) — the role → nav-group model; also exports `ROLE_LABEL` (used by TopBar + HelpCenter).
- **SnapshotBanner** — global freshness banner; consumes `api/snapshots`.
- **Domain vocabulary** (`components/domain` + `lib/slaBucket` + `lib/plantNames` + `lib/inactiveDuration`) — every module renders statuses/buckets/plants through these; **single-source rules** (Critical+ definition, bucket labels/ranges/colors, plant-name mapping) live here, not in pages.
- **CSV export** (`lib/csv.ts`) — client-side "Export to Excel" used by ZoneOverviewTable, CompanyPlantTable, VoucherReviewPage; the Entity-Mapping export (`api/exports.ts`) downloads a server-produced CSV instead.
