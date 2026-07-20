# 03 — Routing

> Part of the [UI Redevelopment Handoff](20-master-index.md). Previous: [02 — Architecture](02-architecture.md) · Next: [04 — Layout](04-layout.md).

All routes are declared statically in **`apps/admin/src/AppRoutes.tsx`** using `react-router-dom` v6 `<Routes>/<Route>`. There is **no lazy loading / code splitting** — every page is imported eagerly. `SnapshotBanner` renders above `<Routes>` on every page (it returns `null` when logged out).

Role legend: **ZM** = ZONAL_MANAGER, **CSM** = CENTRAL_SERVICE_MANAGER, **OH** = OPERATIONS_HEAD, **WM** = WAREHOUSE_MANAGER. "Managers" = ZM + CSM + OH.

## Public / dev routes (no shell)

| Route | Page | File | Layout | Access |
|---|---|---|---|---|
| `/login` | LoginPage | `pages/LoginPage.tsx` | none (own dark full-screen split layout) | public |
| `/_kitchensink` | KitchenSink | `pages/KitchenSink.tsx` | none | **dev builds only** (`import.meta.env.DEV`) |

## Authenticated routes (inside `ProtectedRoute` → `AdminShell` layout route)

Every row below renders in the shell's `<Outlet/>`. "Gate" is the `RoleRoute` allowlist (absence = any authenticated role).

| Route | Page | File (`src/pages/…`) | Gate | Params | Nav entry (sidebar) |
|---|---|---|---|---|---|
| `/` | DashboardHome (role selector → ZmDashboard / CentralDashboard / OpsHeadDashboard / WarehouseDashboard) | `dashboard/DashboardHome.tsx` | any | — | "Zone Dashboard" (managers) / "Dashboard" (WM) |
| `/tickets` | TicketsPage | `tickets/TicketsPage.tsx` | any | — | "Tickets" |
| `/tickets/:ticketId` | TicketDetailDrawer (**nested route** — renders inline beside the list via TicketsPage's `<Outlet/>`) | `tickets/TicketDetailDrawer.tsx` | any | `ticketId`; query `?tab=Verification|Components|…` deep-links a tab | row-click from Tickets and many queue pages |
| `/schedules` | SchedulesPage | `schedules/SchedulesPage.tsx` | Managers | — | "Schedules" |
| `/schedules/:engineerId` | ScheduleDetailPage | `schedules/ScheduleDetailPage.tsx` | Managers | `engineerId` | row-click from `/schedules` |
| `/intraday` | IntradayQueuePage | `schedules/IntradayQueuePage.tsx` | Managers | — | "Intra-day Queue" |
| `/engineers` | SeManagementPage (SE Activity) | `engineers/SeManagementPage.tsx` | Managers | — | "SE Activity" |
| `/engineers/manage` | SeManagementDirectoryPage | `engineers/SeManagementDirectoryPage.tsx` | Managers | — | "Manage SEs" |
| `/engineers/planner` | PlannerPage | `planner/PlannerPage.tsx` | Managers | — | "SE Planner" |
| `/leave-requests` | LeaveRequestsPage | `engineers/LeaveRequestsPage.tsx` | Managers | — | "Leave Requests" |
| `/verification` | VerificationReviewPage | `verification/VerificationReviewPage.tsx` | Managers | — | "Verification Review" |
| `/readiness/vehicle-unavailability` | VehicleUnavailabilityPage | `readiness/VehicleUnavailabilityPage.tsx` | Managers | — | "Readiness & Vehicle" |
| `/readiness/non-operational` | NonOperationalQueuePage | `readiness/NonOperationalQueuePage.tsx` | Managers (override-confirm in-page OH-only) | — | "Non-Operational" |
| `/readiness/recovery-decisions` | RecoveryDecisionQueuePage | `readiness/RecoveryDecisionQueuePage.tsx` | Managers | — | "Recovery Decisions" |
| `/cross-zone` | CrossZonePage | `cross-zone/CrossZonePage.tsx` | Managers (decider actions in-page CSM/OH) | — | "Cross-Zone" |
| `/install` | InstallCreatePage | `install/InstallCreatePage.tsx` | Managers | — | "Create Install" |
| `/vouchers` | VoucherReviewPage | `vouchers/VoucherReviewPage.tsx` | Managers (Finance view in-page OH-only) | — | "Expense Vouchers" |
| `/component-blocked` | ComponentBlockedPage | `inventory/ComponentBlockedPage.tsx` | Managers (read-only page) | — | "Component Blocked" |
| `/component-requests` | ComponentRequestsPage **with `readOnly` prop** | `inventory/ComponentRequestsPage.tsx` | Managers | — | "Component Requests" (managers group) |
| `/warehouse/requests` | ComponentRequestsPage (actionable) | `inventory/ComponentRequestsPage.tsx` | **WM only** | — | "Component Requests" (WM group) |
| `/warehouse/shadow-use` | ShadowUseQueuePage | `inventory/ShadowUseQueuePage.tsx` | **WM only** | — | "Shadow Use Queue" |
| `/warehouse/recovery-receipt` | RecoveryReceiptQueuePage | `warehouse/RecoveryReceiptQueuePage.tsx` | **WM only** | — | "Recovery Receipt" |
| `/reports` | ReportsPage | `reports/ReportsPage.tsx` | Managers | — | "Reports" |
| `/reports/device` | DeviceDetailPage | `reports/DeviceDetailPage.tsx` | Managers (deal-type tag in-page OH-only) | — | "Device Detail" |
| `/reports/root-cause` | RootCauseAnalyticsPage | `reports/RootCauseAnalyticsPage.tsx` | Managers | — | "Root Cause Analytics" |
| `/reports/system-efficiency` | SystemEfficiencyPage | `reports/SystemEfficiencyPage.tsx` | Managers | — | "System Efficiency" |
| `/reports/zm-scorecard` | ZmScorecardPage | `reports/ZmScorecardPage.tsx` | **OH only** | — | "ZM Scorecard" (OH only) |
| `/reports/csm-approval-share` | CsmApprovalSharePage | `reports/CsmApprovalSharePage.tsx` | **OH only** | — | "CSM Backup Share" (Admin group) |
| `/exports` | ExportsPage | `exports/ExportsPage.tsx` | **OH only** | — | "Exports" (Admin group) |
| `/coverage` | TerritoryPage | `coverage/TerritoryPage.tsx` | **OH only** | — | "Coverage" (Admin group) |
| `/settings` | SettingsPage | `settings/SettingsPage.tsx` | **OH only** | — | "Settings" (Admin group) |
| `/help` | HelpCenterPage | `help/HelpCenterPage.tsx` | any | — | "Help" (Support group, all roles) |

## Gate components

- **`ProtectedRoute`** (`src/auth/ProtectedRoute.tsx`): while a stored token is rehydrating (`loading`) shows a full-screen `role="status"` "Loading…"; no session → `<Navigate to="/login" replace/>`.
- **`RoleRoute`** (`src/auth/RoleRoute.tsx`): no session → `/login`; role not in `roles` → `<Navigate to="/" replace/>`.

## Cross-page navigation patterns (must survive redesign)

- Ticket deep-links: many queues navigate to `/tickets/:id` (optionally `?tab=Components` / `?tab=Verification`) — from IntradayQueue, VehicleUnavailability, ComponentBlocked (row click), ComponentRequests, ShadowUse, VerificationReview (row click), VoucherReview (activity link).
- `/schedules` row click → `/schedules/:seId`; detail page has a "← Schedules" back link.
- TicketDetailDrawer close → `navigate('/tickets')`.
- WarehouseDashboard "Open queue →" links → `/warehouse/requests`, `/warehouse/shadow-use`.
- TopBar "Assign SE" button → `navigate('/')`.
- HelpCenter topic cards `Link` to their in-app routes.
- Sidebar active-state rule: exact match for `/`, `pathname.startsWith(to)` otherwise.
