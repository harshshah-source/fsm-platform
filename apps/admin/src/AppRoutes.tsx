import { Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { RoleRoute } from './auth/RoleRoute';
import { AdminShell } from './components/AdminShell';
import { SnapshotBanner } from './components/SnapshotBanner';
import { TerritoryPage } from './pages/coverage/TerritoryPage';
import { ComponentBlockedPage } from './pages/inventory/ComponentBlockedPage';
import { ComponentRequestsPage } from './pages/inventory/ComponentRequestsPage';
import { ShadowUseQueuePage } from './pages/inventory/ShadowUseQueuePage';
import { DashboardHome } from './pages/dashboard/DashboardHome';
import { LoginPage } from './pages/LoginPage';
import { PlannerPage } from './pages/planner/PlannerPage';
import { SeManagementPage } from './pages/engineers/SeManagementPage';
import { ScheduleDetailPage } from './pages/schedules/ScheduleDetailPage';
import { SchedulesPage } from './pages/schedules/SchedulesPage';
import { SettingsPage } from './pages/settings/SettingsPage';
import { TicketDetailDrawer } from './pages/tickets/TicketDetailDrawer';
import { TicketsPage } from './pages/tickets/TicketsPage';
import { VerificationReviewPage } from './pages/verification/VerificationReviewPage';

export function AppRoutes() {
  return (
    <>
      {/* Freshness banner rides the top of every authenticated page (Issue 04 AC#5/#6); it
          renders nothing when logged out, so the login page stays clean. */}
      <SnapshotBanner />
      <Routes>
        <Route path="/login" element={<LoginPage />} />

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
          {/* SE Management — derived Activity Status + Set Availability, manager roles (Issue 25). */}
          <Route
            path="/engineers"
            element={
              <RoleRoute roles={['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']}>
                <SeManagementPage />
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
          {/* Floating-SE territory config — Operations-Head-only (Issue 09). */}
          <Route
            path="/coverage"
            element={
              <RoleRoute roles={['OPERATIONS_HEAD']}>
                <TerritoryPage />
              </RoleRoute>
            }
          />
        </Route>

        <Route
          path="/settings"
          element={
            <RoleRoute roles={['OPERATIONS_HEAD']}>
              <SettingsPage />
            </RoleRoute>
          }
        />
      </Routes>
    </>
  );
}
