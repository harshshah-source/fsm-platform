# 18 — Dependency Graph

> Part of the [UI Redevelopment Handoff](20-master-index.md). Previous: [17 — File Inventory](17-file-inventory.md) · Next: [19 — Roadmap](19-ui-redevelopment-roadmap.md).

## Layered app graph (imports flow downward)

```
main.tsx ── installAuthFetch() ── api/http ── api/tokens
   │
   ▼
App.tsx
   ├─ auth/AuthProvider ──── api/client, api/http, api/tokens
   ├─ react-router BrowserRouter
   ├─ components/data/Toast (ToastProvider)
   ▼
AppRoutes.tsx
   ├─ components/SnapshotBanner ── api/snapshots ── useAuth
   ├─ auth/ProtectedRoute ── useAuth
   ├─ auth/RoleRoute ────── useAuth
   ▼
components/AdminShell (alias) → shell/AppShell
   ├─ shell/SidebarContext (SidebarProvider)
   ├─ shell/Sidebar ── shell/nav (buildNav) ── ui/icons ── shell/BrandLogo ── lib/cn
   ├─ shell/TopBar ─── shell/nav (ROLE_LABEL), useSidebar, useAuth,
   │                    pages/dashboard/RunIngestionButton ── api/integration, Toast, overlay/Modal
   │                    pages/dashboard/ingestionEvents (emit)
   ├─ shell/Footer
   ▼  <Outlet/>
PAGES (pages/**)
   ├─ compose: components/data (PageHeader, MetricStrip, DataTable, FilterBar, feedback, DateRangeChips, RollingNumber)
   │           components/ui   (Button, Card/SectionCard, Input/Field, Badge, icons)
   │           components/overlay (Modal, Tabs, …)
   │           components/charts  (ChartCard, Bar/Trend/Donut, DistributionBar, ReportGrid ← recharts)
   │           components/domain  (SLABadge, DurationBadge, StatusPill, TierBadge, AgeChip, PlantName, …)
   ├─ hooks/  (useApiResource, …)     ├─ useAuth (role gating)   ├─ useToast
   ├─ lib/    (cn, csv, slaBucket, inactiveDuration, plantNames)
   ▼
api/<domain>.ts (36 modules)
   ├─ api/authHeaders ── sessionStorage (fsm.accessToken, fsm.actingZone)
   ▼
window.fetch (patched by api/http: 401 → single-flight /auth/refresh → retry once → onExpired)
   ▼
NestJS backend  /api/*
```

## Cross-cutting flows

```
AuthProvider ──setOnSessionExpired──► api/http ──onExpired──► session cleared → LoginPage notice
TopBar RunIngestionButton ──emitIngestionComplete──► ingestionEvents ──► OpsHeadDashboard
    └─► onDataRefetch (ManagerDashboard reload) ──► RollingNumber runToken bump
AuthProvider.actingZone ──sessionStorage──► api/authHeaders ──► X-Acting-As-Zone header
lib/slaBucket ◄── @fsm/shared SLA_BANDS   (ranges derived, shared with backend classifier)
components/charts/colors + lib/slaBucket.BUCKET_HEX  ◄─ mirror ─►  index.css @theme tokens
```

## Page → API module matrix (who calls what)

| Page | api modules |
|---|---|
| LoginPage / AuthProvider | client, http, tokens |
| SnapshotBanner | snapshots |
| ManagerDashboard (+variants) | dashboard, schedules |
| CompanyPlantTable | tickets (by plant) |
| CriticalQueue | schedules (assign) |
| RunIngestionButton | integration |
| WarehouseDashboard | componentRequests, inventory, shadowUse |
| TicketsPage | tickets |
| TicketDetailDrawer | tickets, componentRequests, verification, recovery |
| SchedulesPage / ScheduleDetailPage | schedules |
| IntradayQueuePage | intradayUpdates |
| SeManagementPage | engineers |
| SeManagementDirectoryPage | engineersAdmin, org |
| LeaveRequestsPage | leaveRequests |
| PlannerPage | planner, schedules |
| VehicleUnavailabilityPage | vehicleUnavailability |
| NonOperationalQueuePage | nonOp |
| RecoveryDecisionQueuePage / RecoveryReceiptQueuePage | recovery |
| ComponentBlockedPage | inventory |
| ComponentRequestsPage | componentRequests |
| ShadowUseQueuePage | shadowUse |
| CrossZonePage | crossZone |
| InstallCreatePage | install, org |
| VerificationReviewPage | verification |
| VoucherReviewPage | vouchers |
| ReportsPage | reports, dashboard |
| DeviceDetailPage | devices |
| RootCause / SystemEfficiency / ZmScorecard | reports |
| CsmApprovalSharePage | roleBackup |
| ExportsPage | exports |
| TerritoryPage | territory |
| SettingsPage sections | org |
| HelpCenterPage | (none) |

## Shared-component fan-in (highest-impact files if changed)

`lib/cn` → everything · `ui/Button` → ~30 files · `data/DataTable` → ~22 tables · `data/PageHeader`/`MetricStrip` → ~20 pages · `domain/badges` → dashboards + queues + drawer · `lib/slaBucket` → dashboards, tickets, reports, settings, device detail · `useAuth` → shell + gates + 14 pages · `overlay/Modal` → 5 dialogs. Treat these as the redesign's leverage points ([19 — Roadmap](19-ui-redevelopment-roadmap.md)).
