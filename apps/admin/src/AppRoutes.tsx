import { Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { RoleRoute } from './auth/RoleRoute';
import { AdminShell } from './components/AdminShell';
import { SnapshotBanner } from './components/SnapshotBanner';
import { TerritoryPage } from './pages/coverage/TerritoryPage';
import { ComponentBlockedPage } from './pages/inventory/ComponentBlockedPage';
import { ComponentRequestsPage } from './pages/inventory/ComponentRequestsPage';
import { ShadowUseQueuePage } from './pages/inventory/ShadowUseQueuePage';
import { RecoveryReceiptQueuePage } from './pages/warehouse/RecoveryReceiptQueuePage';
import { DashboardHome } from './pages/dashboard/DashboardHome';
import { HelpCenterPage } from './pages/help/HelpCenterPage';
import { KitchenSink } from './pages/KitchenSink';
import { LoginPage } from './pages/LoginPage';
import { CrossZonePage } from './pages/cross-zone/CrossZonePage';
import { DispatchRunsPage } from './pages/dispatch/DispatchRunsPage';
import { DispatchRunDetailPage } from './pages/dispatch/DispatchRunDetailPage';
import { DispatchZoneDetailPage } from './pages/dispatch/DispatchZoneDetailPage';
import { DispatchBatchDetailPage } from './pages/dispatch/DispatchBatchDetailPage';
import { InstallCreatePage } from './pages/install/InstallCreatePage';
import { PlannerPage } from './pages/planner/PlannerPage';
import { VehicleUnavailabilityPage } from './pages/readiness/VehicleUnavailabilityPage';
import { NonOperationalQueuePage } from './pages/readiness/NonOperationalQueuePage';
import { RecoveryDecisionQueuePage } from './pages/readiness/RecoveryDecisionQueuePage';
import { SeManagementPage } from './pages/engineers/SeManagementPage';
import { SeManagementDirectoryPage } from './pages/engineers/SeManagementDirectoryPage';
import { LeaveRequestsPage } from './pages/engineers/LeaveRequestsPage';
import { IntradayQueuePage } from './pages/schedules/IntradayQueuePage';
import { ScheduleDetailPage } from './pages/schedules/ScheduleDetailPage';
import { SchedulesPage } from './pages/schedules/SchedulesPage';
import { SettingsPage } from './pages/settings/SettingsPage';
import { CommissioningCohortPage } from './pages/reports/CommissioningCohortPage';
import { CsmApprovalSharePage } from './pages/reports/CsmApprovalSharePage';
import { ExportsPage } from './pages/exports/ExportsPage';
import { OpsExplorerPage } from './pages/ops-explorer/OpsExplorerPage';
import { BulkUnassignPage } from './pages/admin/BulkUnassignPage';
import { PlantDeactivationsPage } from './pages/admin/PlantDeactivationsPage';
import { PlantZonesPage } from './pages/admin/PlantZonesPage';
import { AssignmentThresholdPage } from './pages/admin/AssignmentThresholdPage';
import { TierOverridesPage } from './pages/admin/TierOverridesPage';
import { BuildHealthPage } from './pages/admin/BuildHealthPage';
import { DeviceDetailPage } from './pages/reports/DeviceDetailPage';
import { FleetDirectoryPage } from './pages/reports/FleetDirectoryPage';
import { ReportsPage } from './pages/reports/ReportsPage';
import { RootCauseAnalyticsPage } from './pages/reports/RootCauseAnalyticsPage';
import { SystemEfficiencyPage } from './pages/reports/SystemEfficiencyPage';
import { ZmScorecardPage } from './pages/reports/ZmScorecardPage';
import { TicketDetailDrawer } from './pages/tickets/TicketDetailDrawer';
import { TicketsPage } from './pages/tickets/TicketsPage';
import { VerificationReviewPage } from './pages/verification/VerificationReviewPage';
import { VoucherReviewPage } from './pages/vouchers/VoucherReviewPage';

export function AppRoutes() {
  return (
    <>
      {/* Freshness banner rides the top of every authenticated page (Issue 04 AC#5/#6); it
          renders nothing when logged out, so the login page stays clean. */}
      <SnapshotBanner />
      <Routes>
        <Route path="/login" element={<LoginPage />} />

        {/* Dev-only design-system audit surface (FE-00/FE-01); excluded from production builds. */}
        {import.meta.env.DEV && <Route path="/_kitchensink" element={<KitchenSink />} />}

        {/* Authenticated shell layout — nav + header + an Outlet for the active page. */}
        <Route
          element={
            <ProtectedRoute>
              <AdminShell />
            </ProtectedRoute>
          }
        >
          <Route path="/" element={<DashboardHome />} />
          {/* The Detail Drawer is a nested route so it renders inline over the list. */}
          <Route path="/tickets" element={<TicketsPage />}>
            <Route path=":ticketId" element={<TicketDetailDrawer />} />
          </Route>
          {/* ZM Batch-Schedule monitoring + override (Issue 13b) — manager roles only. */}
          <Route
            path="/schedules"
            element={
              <RoleRoute roles={['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <SchedulesPage />
              </RoleRoute>
            }
          />
          <Route
            path="/schedules/:engineerId"
            element={
              <RoleRoute roles={['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <ScheduleDetailPage />
              </RoleRoute>
            }
          />
          {/* Batch-Assignment transparency drill-down (Issue 123) — manager roles; ZM zone-clamped
              server-side. Detail / zone / batch routes land in the following slices. */}
          <Route
            path="/dispatch-runs"
            element={
              <RoleRoute roles={['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <DispatchRunsPage />
              </RoleRoute>
            }
          />
          <Route
            path="/dispatch-runs/:runId"
            element={
              <RoleRoute roles={['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <DispatchRunDetailPage />
              </RoleRoute>
            }
          />
          <Route
            path="/dispatch-runs/:runId/zones/:zoneId"
            element={
              <RoleRoute roles={['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <DispatchZoneDetailPage />
              </RoleRoute>
            }
          />
          {/* A batch is addressed by its own id, NOT under a run: most live batches have no run_id
              (pre-ledger / ZM_MANUAL), and a run-scoped path left them unreachable. */}
          <Route
            path="/batches/:batchId"
            element={
              <RoleRoute roles={['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <DispatchBatchDetailPage />
              </RoleRoute>
            }
          />
          {/* SE Management — derived Activity Status + Set Availability, manager roles (Issue 25). */}
          <Route
            path="/engineers"
            element={
              <RoleRoute roles={['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <SeManagementPage />
              </RoleRoute>
            }
          />
          {/* SE Management directory — admin-entered SE CRUD + coverage, manager roles (Phase 4). */}
          <Route
            path="/engineers/manage"
            element={
              <RoleRoute roles={['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <SeManagementDirectoryPage />
              </RoleRoute>
            }
          />
          {/* Reports landing — Fleet Uptime (39) + Soft-Inactive trend (40), manager roles (FE-21). */}
          <Route
            path="/reports"
            element={
              <RoleRoute roles={['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <ReportsPage />
              </RoleRoute>
            }
          />
          {/* Device Detail (FE-22 / Issue 44/49) — manager roles; Ops-Head deal-type tag in-page. */}
          <Route
            path="/reports/device"
            element={
              <RoleRoute roles={['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <DeviceDetailPage />
              </RoleRoute>
            }
          />
          {/* Fleet Directory (Issue 122b) — the Companies/Plants KPI cards' click-through. */}
          <Route
            path="/reports/fleet"
            element={
              <RoleRoute roles={['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <FleetDirectoryPage />
              </RoleRoute>
            }
          />
          {/* Root-Cause Analytics (FE-23 / Issue 41) — manager roles, ZM zone-scoped server-side. */}
          <Route
            path="/reports/root-cause"
            element={
              <RoleRoute roles={['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <RootCauseAnalyticsPage />
              </RoleRoute>
            }
          />
          {/* Commissioning Cohort (#232 / #233 / #234) — install quality for recently fitted devices.
              Manager roles; a ZM is clamped to their own zone in the service and told so on the page. */}
          <Route
            path="/reports/commissioning"
            element={
              <RoleRoute roles={['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <CommissioningCohortPage />
              </RoleRoute>
            }
          />
          {/* System Efficiency (FE-24 / Issue 42) — manager roles, ZM zone-scoped server-side. */}
          <Route
            path="/reports/system-efficiency"
            element={
              <RoleRoute roles={['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <SystemEfficiencyPage />
              </RoleRoute>
            }
          />
          {/* ZM Performance Scorecard (FE-25 / Issue 43) — Operations Head only. */}
          <Route
            path="/reports/zm-scorecard"
            element={
              <RoleRoute roles={['OPERATIONS_HEAD']}>
                <ZmScorecardPage />
              </RoleRoute>
            }
          />
          {/* CSM Backup Share report — Operations Head only (Issue 27 AC#5). */}
          <Route
            path="/reports/csm-approval-share"
            element={
              <RoleRoute roles={['OPERATIONS_HEAD']}>
                <CsmApprovalSharePage />
              </RoleRoute>
            }
          />
          {/* Bulk Unassign — Operations Head only (#179, mid-day rebalance). */}
          <Route
            path="/bulk-unassign"
            element={
              <RoleRoute roles={['OPERATIONS_HEAD']}>
                <BulkUnassignPage />
              </RoleRoute>
            }
          />
          {/* Plant Deactivations — Operations Head only (Issue 119). */}
          <Route
            path="/plant-deactivations"
            element={
              <RoleRoute roles={['OPERATIONS_HEAD']}>
                <PlantDeactivationsPage />
              </RoleRoute>
            }
          />
          {/* Plant Zones — Operations Head only (#158, plant_zone_overrides surface). */}
          <Route
            path="/plant-zones"
            element={
              <RoleRoute roles={['OPERATIONS_HEAD']}>
                <PlantZonesPage />
              </RoleRoute>
            }
          />
          {/* Tier Overrides — ZM (own zone) / CSM / OH (#157 S5, scoped expiring company tier overrides).
              No v2-reference surface exists and Settings is OH-only, yet this feature is for CSM/ZM —
              a role-variant page, mirroring the #158 Plant Zones precedent. */}
          <Route
            path="/tier-overrides"
            element={
              <RoleRoute roles={['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <TierOverridesPage />
              </RoleRoute>
            }
          />
          {/* SE Assignment Threshold — CSM / OH (#238). Same reason Tier Overrides above has its own
              route: the setting is co-owned with the CSM and the Settings console is OH-only, so the
              one shared control is routed rather than the whole console widened. */}
          <Route
            path="/assignment-threshold"
            element={
              <RoleRoute roles={['CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <AssignmentThresholdPage />
              </RoleRoute>
            }
          />
          {/* Build Health — Operations Head only (Issue 131, #130 L3/L5 drill-down). */}
          <Route
            path="/build-health"
            element={
              <RoleRoute roles={['OPERATIONS_HEAD']}>
                <BuildHealthPage />
              </RoleRoute>
            }
          />
          {/* Raw-data Exports — Operations Head only (Issue 120). */}
          <Route
            path="/exports"
            element={
              <RoleRoute roles={['OPERATIONS_HEAD']}>
                <ExportsPage />
              </RoleRoute>
            }
          />
          {/* Operations Data Explorer — Operations Head only, AND behind the backend's
              OPS_EXPLORER_ENABLED flag (#217). The RoleRoute is the role half; the flag half cannot
              live here because it is server state, so the page itself resolves it and renders an
              explanation when the feature is off. Both gates are enforced on every endpoint. */}
          <Route
            path="/ops-explorer"
            element={
              <RoleRoute roles={['OPERATIONS_HEAD']}>
                <OpsExplorerPage />
              </RoleRoute>
            }
          />
          {/* Leave Requests — ZM approvals, manager roles (Issue 26). */}
          <Route
            path="/leave-requests"
            element={
              <RoleRoute roles={['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <LeaveRequestsPage />
              </RoleRoute>
            }
          />
          {/* Cross-Zone escalations — Auto (Platinum) vs Manual split + decider actions (Issue 78 over #32). */}
          <Route
            path="/cross-zone"
            element={
              <RoleRoute roles={['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <CrossZonePage />
              </RoleRoute>
            }
          />
          {/* Install Ticket create — single + CSV bulk, creator roles only (Issue 69 over Issue 33). */}
          <Route
            path="/install"
            element={
              <RoleRoute roles={['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <InstallCreatePage />
              </RoleRoute>
            }
          />
          {/* SE Planner grid — plant-visit intent, manager roles only (Issue 14b). */}
          <Route
            path="/engineers/planner"
            element={
              <RoleRoute roles={['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <PlannerPage />
              </RoleRoute>
            }
          />
          {/* Intra-day Queue — ZM manual same-day updates (Issue 31); manager roles only. System
              CRITICAL insertions (Issue 29) land in the same view later. */}
          <Route
            path="/intraday"
            element={
              <RoleRoute roles={['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <IntradayQueuePage />
              </RoleRoute>
            }
          />
          {/* Vehicle Unavailability Review — ZM dual-SLA-clock review, manager roles only (Issue 28).
              The secondary (never-pausing) clock is manager-only by living behind this gate. */}
          <Route
            path="/readiness/vehicle-unavailability"
            element={
              <RoleRoute roles={['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <VehicleUnavailabilityPage />
              </RoleRoute>
            }
          />
          {/* Non-Operational dual-confirmation queue — manager roles (Issue 35). Override-confirm is
              Operations-Head-only, gated in-page; the route is RoleRoute-gated as the second line. */}
          <Route
            path="/readiness/non-operational"
            element={
              <RoleRoute roles={['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <NonOperationalQueuePage />
              </RoleRoute>
            }
          />
          {/* Recovery ZM Decision Queue — unable-to-collect triage (Issue 37); manager roles only. */}
          <Route
            path="/readiness/recovery-decisions"
            element={
              <RoleRoute roles={['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <RecoveryDecisionQueuePage />
              </RoleRoute>
            }
          />
          {/* Component-Blocked Queue — ZM read-only, manager roles only (Issue 21). */}
          <Route
            path="/component-blocked"
            element={
              <RoleRoute roles={['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <ComponentBlockedPage />
              </RoleRoute>
            }
          />
          {/* Component Requests queue — Warehouse Manager owns approval/shipping (Issue 22). */}
          <Route
            path="/warehouse/requests"
            element={
              <RoleRoute roles={['WAREHOUSE_MANAGER']}>
                <ComponentRequestsPage />
              </RoleRoute>
            }
          />
          {/* Component Requests oversight — manager read-only (own-zone ZM / all-zones CSM, OH) (Issue 23). */}
          <Route
            path="/component-requests"
            element={
              <RoleRoute roles={['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <ComponentRequestsPage readOnly />
              </RoleRoute>
            }
          />
          {/* Recovery — Awaiting Warehouse Receipt — Warehouse Manager confirms physical receipt,
              auto-closing the Recovery Ticket (Issue 36). WM-only; RoleRoute is the second line. */}
          <Route
            path="/warehouse/recovery-receipt"
            element={
              <RoleRoute roles={['WAREHOUSE_MANAGER']}>
                <RecoveryReceiptQueuePage />
              </RoleRoute>
            }
          />
          {/* Shadow Use Queue — Warehouse Manager reconciliation of 409-loser consumption (Issue 24). */}
          <Route
            path="/warehouse/shadow-use"
            element={
              <RoleRoute roles={['WAREHOUSE_MANAGER']}>
                <ShadowUseQueuePage />
              </RoleRoute>
            }
          />
          {/* GPS Verification Review — manager roles only (Issue 19). */}
          <Route
            path="/verification"
            element={
              <RoleRoute roles={['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <VerificationReviewPage />
              </RoleRoute>
            }
          />
          {/* Expense Voucher review — ZM Approve/Reject/Needs-Clarification (own zone); Operations Head
              also exports the monthly Finance batch + multi-select Mark PAID (Issue 38). Manager roles. */}
          <Route
            path="/vouchers"
            element={
              <RoleRoute roles={['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <VoucherReviewPage />
              </RoleRoute>
            }
          />
          {/* Help Center — role-scoped static guidance + glossary (FE-26); reachable by all roles. */}
          <Route path="/help" element={<HelpCenterPage />} />
          {/* Floating-SE territory config — Operations-Head-only (Issue 09). */}
          <Route
            path="/coverage"
            element={
              <RoleRoute roles={['OPERATIONS_HEAD']}>
                <TerritoryPage />
              </RoleRoute>
            }
          />
          {/* Settings — Operations-Head-only config console (reference 26 renders it inside the shell). */}
          <Route
            path="/settings"
            element={
              <RoleRoute roles={['OPERATIONS_HEAD']}>
                <SettingsPage />
              </RoleRoute>
            }
          />
        </Route>
      </Routes>
    </>
  );
}
