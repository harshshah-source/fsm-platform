# 21 — AI UI Redevelopment Context (Definitive Handoff)

> **Purpose.** The single, self-contained reference for an AI (or engineer) redesigning the FSM
> Admin Web Dashboard UI **without re-reading the codebase and without breaking functionality**.
> Generated 2026-07-14 from source on branch `feat/autoplant-integration`. Where this document
> and any other document disagree, **source code wins**; where docs 01–20 in this folder give more
> per-page detail, they remain valid deep-dives — this file is the consolidated contract.
>
> **Scope**: `apps/admin` (React SPA). The Expo mobile app is an auth shell only and is out of
> scope for UI redevelopment. **Do not redesign here — this file only analyzes.**

---

## SECTION 1 — GLOBAL UI ARCHITECTURE

### Stack (verified from `apps/admin/package.json` + source)

- React 18 + TypeScript, Vite 5, `react-router-dom` v6 (static route table, no lazy loading).
- **Tailwind CSS v4** via `@tailwindcss/vite`; ALL design tokens declared in `src/index.css`
  `@theme` block. No CSS modules, no styled-components, no SCSS.
- **Hand-rolled component kit.** `@radix-ui/*` (dialog, dropdown-menu, select, tabs, tooltip)
  and `lucide-react` are installed **but never imported** — overlays and the 29 SVG icons are
  hand-rolled (`components/ui/icons.tsx` calls itself a "zero-dependency stand-in for
  lucide-react"). Recharts IS used, wrapped by `components/charts/*`.
- **No global state library, no client cache** (no Redux/Zustand/react-query). Two contexts only:
  `AuthContext` and `ToastContext` (+ `SidebarContext` inside the shell).
- Utilities: `clsx` + `tailwind-merge` via `lib/cn.ts`.
- Tests: vitest + @testing-library (jsdom), 67 test files in `apps/admin/test/`; Playwright
  visual capture/compare in `apps/admin/visual/`.

### Provider hierarchy (`src/App.tsx`, `src/main.tsx`) — MUST NOT CHANGE

```
installAuthFetch()  (window.fetch patched BEFORE render — 401→refresh→retry)
<StrictMode>
  <AuthProvider>            src/auth/AuthProvider.tsx   (session, login/logout, actingZone)
    <BrowserRouter>
      <ToastProvider>       src/components/data/Toast.tsx
        <AppRoutes/>        src/AppRoutes.tsx
          <SnapshotBanner/>              (above ALL routes; renders null when logged out)
          <Routes>
            /login                        LoginPage
            /_kitchensink                 DEV builds only
            <ProtectedRoute><AdminShell/></ProtectedRoute>
              <SidebarProvider> Sidebar + TopBar + acting-banner + <main><Outlet/></main> + Footer
              ... ~34 child routes, many wrapped in <RoleRoute roles={[...]}>
```

### Rendering / data-flow recipe (uniform across ~all pages)

Every page follows one shape: local `useState` for data/loading/error → `useEffect` fetch on
mount (with `alive` guard) → manual refetch after mutations → inline error `<p role="alert">` or
`EmptyState` → `Toast` (rarely) or inline feedback. Formalized hooks exist in `src/hooks/index.ts`
(`useApiResource`, `useAsyncAction`, `useFilters`) but are **barely adopted** (1 usage) — the
manual pattern dominates. There is no cache: freshness = refetch.

### Design hierarchy

```
tokens (index.css @theme)  →  ui/ primitives (Button, Card, Badge, Input, icons)
  →  data/ patterns (DataTable, MetricStrip, PageHeader, FilterBar, Toast, feedback)
  →  overlay/ (Modal, Sheet, Select, Tabs, DropdownMenu)   →  charts/ (Recharts wrappers)
  →  domain/ (SLABadge, StatusPill, TierBadge, AgeChip, DurationBadge, PlantName, TicketCard, Timeline)
  →  shell/ (AppShell, Sidebar, TopBar, Footer, nav.ts)
  →  pages/* (composition only — pages own layout, kit owns look)
```

### Authoritative visual references

`docs/ui/desktop/v2-reference/` (screens 00–26; the repo's CLAUDE.md **requires** reading the
relevant image before touching any page) and `.scratch/fsm-platform-v1/DESIGN-SYSTEM.md`
(token derivation + documented "—" placeholder omissions).

---

## SECTION 2 — COMPLETE COMPONENT INVENTORY

Styling approach for every component below: Tailwind utility classes composed with `cn()`,
consuming ONLY the `@theme` tokens (rule in index.css: "No component may introduce a raw hex or
off-scale value"). None accept style-objects; most accept `className` passthrough.

### 2.1 `components/ui/` — primitives

| Component | File | Props (exact) | Purpose / notes |
|---|---|---|---|
| **Button** | ui/Button.tsx | `variant: 'primary'\|'secondary'\|'danger'\|'ghost'`, `size: 'sm'\|'md'\|'lg'`, `loading`, + all ButtonHTMLAttributes; forwardRef | Canonical CTA. primary = brand-red gradient; `loading` renders IconSpinner + disables. Uses `.focus-ring`, `active:translate-y-px` |
| **Card** | ui/Card.tsx | HTMLAttributes<div> | `.premium-panel rounded-card border-line` + hover shadow lift. Base of every block |
| **SectionCard** | ui/Card.tsx | `title?: ReactNode`, `action?: ReactNode`, `children`, `className?`, `bodyClassName?` | Card + caps header row with gradient (`from-surface-raised via-surface-card to-luxury-100/45`) + right action slot |
| **Badge** | ui/Badge.tsx | `tone: 'info'\|'success'\|'verified'\|'warning'\|'critical'\|'neutral'\|'brand'`, `dot?: boolean` | Tinted uppercase pill, ring-inset. Base of all domain badges |
| **Input / Field** | ui/Input.tsx | Input: InputHTMLAttributes; Field: `label`, `htmlFor`, `hint?`, children | Tokened text input + labeled wrapper. All forms use these |
| **icons** (29) | ui/icons.tsx | SVGProps each | Hand-rolled inline SVGs: IconGrid, IconTicket, IconCalendar, IconClock, IconActivity, IconShield, IconRoute, IconTruck, IconAlert, IconPackage, IconShuffle, IconRotate, IconHelp, IconSettings, IconMapPin, IconSpinner, IconBoxAlert, IconClipboard, IconShare, … Swapping the set = touch this ONE file |

### 2.2 `components/data/` — data patterns

| Component | File | Props (exact) | Purpose / notes |
|---|---|---|---|
| **DataTable<T>** | data/DataTable.tsx | `columns: Column<T>[]` (`key, header, render?, align?, className?, sortable?, sortValue?`), `rows`, `rowKey`, **`ariaLabel` (required)**, `onRowClick?`, **`rowTestId?`**, `rowAccent?` (left severity border class), `loading?`, `error?`, `onRetry?`, `empty?`, `stickyHeader?` (default false, 70vh scroll), `maxBodyHeight?` | THE table. Built-in Skeleton/ErrorState/EmptyState, client-side sort toggle. Caps th styling comes from base CSS |
| **MetricCard / MetricStrip** | data/MetricStrip.tsx | Metric: `label, value, hint?, tone (7 tones), testId?`; Strip: `metrics: Metric[]`, `cols?: 3\|4\|5\|6`, `className?` | KPI card w/ left tone accent bar; Strip = responsive grid. `cols` classes are CSS-safelisted in index.css — keep the `@source inline` lines if grid classes change |
| **PageHeader** | data/PageHeader.tsx | `title`, `subtitle?`, `actions?` | Card-boxed h2 title row on every page |
| **FilterBar / SearchInput / FilterSelect** | data/FilterBar.tsx | FilterBar: `children`, `className?`; SearchInput: InputHTMLAttributes passthrough; FilterSelect: SelectHTMLAttributes passthrough (styled native `<select>` — options come as children) | Toolbar row for list pages |
| **Toast / ToastProvider / useToast / useToastOptional** | data/Toast.tsx | api: `toast.success/error(msg)` | Context host mounted in App. NOTE: only RunIngestionButton consumes it today (via useToastOptional); pages mostly use inline alerts |
| **Skeleton / EmptyState / ErrorState** | data/feedback.tsx | Skeleton: `className`; EmptyState: `message?, icon?, action?`; ErrorState: `message?, onRetry?` (role="alert") | Uniform loading/empty/error blocks; DataTable embeds them |
| **DateRangeChips** | data/DateRangeChips.tsx | (self-contained) | ⚠ **Static chrome** — dashboard date chips are not wired to data. Visual-only |
| **RollingNumber** | data/RollingNumber.tsx | `value: number`, `runToken` | Odometer roll animation keyed on `runToken` change (OH KPIs after ingestion run). Contract tested |

### 2.3 `components/overlay/` — hand-rolled overlays (NOT Radix)

| Component | Props | Notes |
|---|---|---|
| **Modal** | `open`, `onClose`, `title?`, `children`, `footer?`, `className?` | role="dialog" aria-modal, Escape + backdrop close, `z-50`, backdrop `bg-chrome-900/50 backdrop-blur-md`. **No focus trap, no portal** — renders in place. aria-label = string title |
| **Sheet** | similar, side panel | **LATENT — used only by KitchenSink.** TicketDetailDrawer hand-rolls its own drawer markup (imports only Modal + Button + ticketBadges) |
| **Select** | `SelectOption {value,label}`, value/onChange | styled native select |
| **Tabs / TabList / Tab / TabPanel** | `value`-controlled | 1 usage |
| **DropdownMenu** | `MenuItem[]` | 1 usage (TopBar user menu) |

### 2.4 `components/charts/` — Recharts wrappers + custom

| Component | Recharts? | Used by |
|---|---|---|
| **ChartCard** | no (chrome: SectionCard-like frame for a chart) | 8 files |
| **TrendChart** | yes (line/area) | Reports, DeviceDetail |
| **BarChartCard** | yes | RootCause, SystemEfficiency, Reports… |
| **DonutChart** | yes | RootCause, Reports |
| **RadialGauge** | yes | Reports (uptime gauge) |
| **DistributionBar** | no (custom flex heat-ramp; `DistSegment {label,value,color}`) | OpsHeadDashboard SLA distribution, Reports |
| **ReportGrid** | no (layout grid for report cards) | report pages (3) |
| `colors.ts` | palette helpers for charts | charts internally |

### 2.5 `components/domain/` — domain semantics (LOGIC-BEARING; treat as read-only logic)

| Component | Purpose | Notes |
|---|---|---|
| **SLABadge** | bucket → Badge tone + label | derives from `lib/slaBucket` maps |
| **StatusPill** | ticket/request status → tone/label | single source of status→color mapping |
| **TierBadge** | PLATINUM/GOLD/SILVER pill | |
| **AgeChip** | `days` → aged-tone chip (7d+ overdue cues) | |
| **DurationBadge** | bucket + `latestGpsDatetime` → elapsed-inactive text | uses `lib/inactiveDuration`; tested (duration-badge.test) |
| **PlantName** | `code` → display name via `lib/plantNames` | tested |
| **TicketCard** | ticket summary card | **LATENT — used only by KitchenSink** |
| **Timeline** | event timeline | **UNUSED (dead/latent)** — exported, zero page usage |

### 2.6 `components/shell/` — application chrome

| Component | Notes |
|---|---|
| **AppShell** (`AdminShell` is a re-export alias — keep both export names) | dark sidebar + light TopBar + amber acting-banner (`role="status"`, copy "Acting as Zonal Manager for Zone N (audited as ROLE)") + `<main class="p-4 sm:p-6 lg:p-8"><div class="enterprise-page">` + dark Footer |
| **Sidebar** + **SidebarContext** | chrome-navy (`chrome-900/800/700` tokens), role-grouped links from `nav.ts buildNav(role)`, collapse state in context |
| **TopBar** | search chrome, **RunIngestionButton** (OH pipeline trigger with `.ingest-live` glow + cycling status verbs), notifications entry, user DropdownMenu, acting-zone entry |
| **Footer**, **BrandLogo** (AutoPlant wordmark, `--color-brand-logo` #b91c1c kept distinct from brand scale) | |
| **nav.ts** | `buildNav(role): NavGroup[]` — THE role-nav matrix (WM: Warehouse group; managers: Operations/Components/Reports; OH-only: Admin group; Help for all) |

### 2.7 Top-level components

**SnapshotBanner** (`components/SnapshotBanner.tsx`) — freshness "data as of" strip above every
authenticated page; red alert when latest run FAILED or RUNNING >15 min. Calls
`GET /snapshots/latest`. Renders null logged-out.

### 2.8 `lib/` — pure logic consumed by components (NEVER restyle-refactor these)

| File | Exports | Why untouchable |
|---|---|---|
| `slaBucket.ts` | `SLA_BUCKETS` (severity desc), `CRITICAL_PLUS_BUCKETS`, `criticalPlusCount`, `sumCriticalPlusDevices`, `BUCKET_LABEL`, `BUCKET_RANGE_LABEL` (derived from shared `SLA_BANDS`), `BUCKET_LABEL_RANGE`, `BUCKET_HEX`, `BUCKET_CLASS` | Single source of the SLA taxonomy + the "Critical+" definition; KPI = scorecard sum **by construction** (Issue 1). Range labels derive from `@fsm/shared` so UI can never drift from the backend classifier |
| `inactiveDuration.ts` | `formatInactiveOfTotal` etc. | tested display math |
| `plantNames.ts` | plant code→name mapping | tested |
| `csv.ts` | `toCsv`, `downloadCsv` | export feature on tables |
| `cn.ts` | `cn()` clsx+tailwind-merge | class merge — everything uses it |

### 2.9 Hooks & contexts

- `useAuth()` (AuthProvider): `{session, loading, sessionExpired, clearSessionExpired, login, logout, actingZone, setActingZone}` — 19 consumer files.
- `useApiResource / useAsyncAction / useFilters` (`hooks/index.ts`) — available, ~unused.
- `useToast / useToastOptional`, `SidebarContext`, `pages/dashboard/ingestionEvents.ts`
  (`emitIngestionComplete` / `onIngestionComplete` tiny pub/sub between TopBar button and OH dashboard).

### 2.10 API layer (31 files in `src/api/`)

`http.ts` (401→single-flight-refresh→retry interceptor over window.fetch, `VITE_API_URL` base),
`tokens.ts` (sessionStorage keys `fsm.accessToken`/`fsm.refreshToken`), `authHeaders.ts`
(Authorization + `X-Acting-As-Zone`), `client.ts` (login/refresh/me), + 27 domain modules
(tickets, dashboard, schedules, reports, org, engineers, engineersAdmin, inventory,
componentRequests, shadowUse, recovery, install, intradayUpdates, crossZone, nonOp,
vehicleUnavailability, verification, vouchers, leaveRequests, roleBackup, planner, territory,
devices, snapshots, integration, exports, plantDeactivations). ⚠ ~18 modules read
`sessionStorage['fsm.accessToken']` directly rather than through authHeaders — inconsistent but
functional; **do not "clean up" during a visual redesign**.

---

## SECTION 3 — COMPONENT USAGE MATRIX

Measured by `grep -l` across `pages/ + shell + AdminShell + SnapshotBanner` (file counts, not
call-sites; total surface ≈ 47 page/shell files). Impact = how much of the app changes when this
component changes. Risk = chance of breaking behavior/tests if its interface or selectors shift.

| Component | Files using | Reach | Impact | Risk |
|---|---|---|---|---|
| Design tokens (index.css) | ALL | 100% | ★★★★★ | Low (values only) |
| PageHeader | 32 | every page | ★★★★★ | Low |
| Button | 28 | every interactive page | ★★★★★ | Med (loading/disabled contract) |
| DataTable | 28 | every queue/list page | ★★★★★ | **High** (ariaLabel/rowTestId/sort/row-click contracts, tested) |
| AppShell/Sidebar/TopBar/Footer/nav.ts | all authed pages | 100% | ★★★★★ | Med (nav roles, acting banner copy, RunIngestion states — tested) |
| Field + Input | 16 / 12 | all forms | ★★★★☆ | Low-Med |
| Badge | 16 | pervasive (also via domain badges) | ★★★★☆ | Low |
| MetricStrip/MetricCard | 15 / 10 | all dashboards + report/queue KPIs | ★★★★☆ | Med (testId passthrough, cols safelist) |
| EmptyState (+ via DataTable everywhere) | 13 | ★★★★☆ | Low |
| FilterSelect / FilterBar | 12 / 5 | list pages | ★★★☆☆ | Low |
| Select (overlay) | 11 | forms | ★★★☆☆ | Low |
| StatusPill | 10 | queue pages | ★★★☆☆ | Med (status→tone map is domain truth) |
| DateRangeChips | 9 | dashboards/reports | ★★★☆☆ | Low (static chrome) |
| SectionCard | 9 | dashboards, detail pages | ★★★☆☆ | Low |
| Modal | 8 | mutation dialogs | ★★★★☆ | **High** (only dialog primitive; Esc/backdrop/aria contract) |
| ChartCard | 8 | reports | ★★★☆☆ | Low |
| TierBadge / AgeChip / PlantName | 6 each | queues | ★★★☆☆ | Med (domain semantics) |
| BarChartCard | 6 | reports | ★★★☆☆ | Low |
| SLABadge / DurationBadge | 4 each | tickets/queues | ★★★☆☆ | Med |
| Card (direct) | 4 (+base of SectionCard/action cards) | ★★★★☆ | Low |
| ReportGrid | 3 | reports | ★★☆☆☆ | Low |
| TrendChart / DonutChart / DistributionBar | 2 each | ★★☆☆☆ | Low |
| Sheet / Tabs / DropdownMenu / RadialGauge / RollingNumber / Skeleton(direct) | 1 each | ★★☆☆☆ | Med (RollingNumber runToken tested) |
| TicketCard | 1 (KitchenSink) | latent | ★☆☆☆☆ | none |
| Timeline | 0 | dead/latent | ★☆☆☆☆ | none |
| useAuth | 19 | ★★★★★ | **Never touch** |

---

## SECTION 4 — PAGE DEPENDENCY MATRIX

Roles: mgr = ZM+CSM+OH gate via `RoleRoute`. All pages additionally sit behind `ProtectedRoute`.
"APIs" names the `src/api/*` module(s). Complexity: L/M/H. (Full per-page field/action detail:
docs 06/11/12/13.)

| # | Route | Page file (pages/…) | Gate | Purpose | Key shared comps | Forms/Dialogs | Tables/Charts | APIs | Cx |
|---|---|---|---|---|---|---|---|---|---|
| 1 | /login | LoginPage.tsx | public | login + session-expired notice | Field/Input/Button, BrandLogo | login form | — | client | L |
| 2 | / | dashboard/DashboardHome→ManagerDashboard→{ZmDashboard,CentralDashboard,OpsHeadDashboard} \| WarehouseDashboard | any | 4 role-variant dashboards | MetricStrip, PageHeader, DateRangeChips, Badge, SectionCard, DataTable(WM), DistributionBar(OH), RollingNumber(OH) | WM stock-adjust Modal; CriticalQueue assign control | ZoneOverviewTable, CompanyPlantTable, ScorecardTable, CriticalQueue, EscalationQueueList, ActionRequiredPanel | dashboard, schedules, componentRequests, inventory, shadowUse | **H** |
| 3 | /tickets (+ :ticketId nested) | tickets/TicketsPage + TicketDetailDrawer (+ ticketBadges) | any | ticket list + detail drawer (timeline, forms read, actions) | DataTable, FilterBar/Select, PageHeader, domain badges, Sheet | drawer actions (auto-recovery close…) | main table | tickets, verification | **H** |
| 4 | /schedules | schedules/SchedulesPage | mgr | day-plan list + dispatch-run trigger | DataTable, PageHeader, Button | dispatch confirm | table | schedules | M |
| 5 | /schedules/:engineerId | schedules/ScheduleDetailPage | mgr | one SE's plan + override actions (remove/defer/reorder/swap/split/onsite) | DataTable, Modal, Select | override dialogs | table | schedules | **H** |
| 6 | /intraday | schedules/IntradayQueuePage | mgr | ZM same-day updates + CRITICAL insertion queue (accept/decline/manual-assign) | DataTable, Modal, StatusPill | assign/decline dialogs | table | intradayUpdates, schedules | **H** |
| 7 | /engineers | engineers/SeManagementPage | mgr | SE activity status + set availability | DataTable, Modal, Badge | availability form | table | engineers | M |
| 8 | /engineers/manage | engineers/SeManagementDirectoryPage | mgr | SE CRUD + coverage mgmt | DataTable, Modal, Field/Input/Select | SE create/edit, coverage | table | engineersAdmin, org | **H** |
| 9 | /engineers/planner | planner/PlannerPage | mgr | SE×plant×date planner grid | custom grid, Select, Button | cell add/delete | grid | planner | M |
| 10 | /leave-requests | engineers/LeaveRequestsPage | mgr | approve/reject SE leave | DataTable, Modal | decision dialog | table | leaveRequests | M |
| 11 | /install | install/InstallCreatePage | mgr | single + CSV bulk install create | Field/Input/Select, Button, file input | 2 forms + CSV result panel | preview table | install | **H** |
| 12 | /cross-zone | cross-zone/CrossZonePage | mgr | escalation queue: approve/deny/defer/re-escalate | DataTable, Modal, TierBadge | decision dialogs (target zone+SE) | table | crossZone | **H** |
| 13 | /readiness/vehicle-unavailability | readiness/VehicleUnavailabilityPage | mgr | dual-SLA-clock review, confirm-date/resume | DataTable, Modal | date confirm | table | vehicleUnavailability | M |
| 14 | /readiness/non-operational | readiness/NonOperationalQueuePage | mgr | dual-confirmation queue; OH override-confirm | DataTable, Modal, AgeChip | confirm/override dialogs | table | nonOp | **H** |
| 15 | /readiness/recovery-decisions | readiness/RecoveryDecisionQueuePage | mgr | unable-to-collect triage (reschedule/close-failed/escalate) | DataTable, Modal | decision dialogs | table | recovery | M |
| 16 | /component-blocked | inventory/ComponentBlockedPage | mgr | read-only blocked queue | DataTable, AgeChip | — | table | inventory | L |
| 17 | /warehouse/requests | inventory/ComponentRequestsPage | **WM** | approve/ship/reject component requests | DataTable, Modal, StatusPill | ship (trackingRef, destination), reject-reason | table | componentRequests | **H** |
| 18 | /component-requests | same page `readOnly` prop | mgr | oversight read-only variant | same minus actions | — | table | componentRequests | M |
| 19 | /warehouse/recovery-receipt | warehouse/RecoveryReceiptQueuePage | **WM** | confirm physical receipt (auto-closes ticket) | DataTable, Modal | receipt confirm | table | recovery | M |
| 20 | /warehouse/shadow-use | inventory/ShadowUseQueuePage | **WM** | reconcile/dispute 409-loser consumption | DataTable, Modal | reconcile/dispute | table | shadowUse | M |
| 21 | /verification | verification/VerificationReviewPage | mgr | GPS verification review, escalate / mark-auto-recovery, fraud flags | DataTable, Modal, Badge | action dialogs | table | verification | **H** |
| 22 | /vouchers | vouchers/VoucherReviewPage | mgr | ZM review (approve/reject/clarify) + OH export + multi-select mark-PAID | DataTable, Modal, checkbox multiselect | review dialogs, paid-batch | table | vouchers | **H** |
| 23 | /reports | reports/ReportsPage | mgr | fleet-uptime + soft-inactive trend landing | ChartCard, TrendChart, RadialGauge, ReportGrid, MetricStrip | recompute triggers | charts | reports | M |
| 24 | /reports/device | reports/DeviceDetailPage | mgr | device search → cycles, downtime trend, deal-type tag (OH) | DataTable, TrendChart, Modal | deal-type form | table+chart | devices | M |
| 25 | /reports/root-cause | reports/RootCauseAnalyticsPage | mgr | root-cause cube: filters + bar/donut | BarChartCard, DonutChart, FilterBar | — | charts+table | reports | M |
| 26 | /reports/system-efficiency | reports/SystemEfficiencyPage | mgr | efficiency cube: stage times, rates | MetricStrip, BarChartCard, ReportGrid | — | charts | reports | M |
| 27 | /reports/zm-scorecard | reports/ZmScorecardPage | **OH** | ZM decision-activity league table | DataTable, MetricStrip | recompute | table | reports | M |
| 28 | /reports/csm-approval-share | reports/CsmApprovalSharePage | **OH** | CSM backup-share report | DataTable/ChartCard | — | table | roleBackup | L |
| 29 | /plant-deactivations | admin/PlantDeactivationsPage | **OH** | deactivate/reactivate plants (reason req.) | DataTable, Modal, Field | deactivate/reactivate dialogs | table | plantDeactivations | M |
| 30 | /exports | exports/ExportsPage | **OH** | entity-mapping CSV export + summary | SectionCard, Button, DataTable | download action | summary table | exports | L |
| 31 | /coverage | coverage/TerritoryPage | **OH** | floating-SE territory dims (state/region/district) | Select cascade, DataTable | add/delete territory | table | territory, org | M |
| 32 | /settings | settings/SettingsPage (+sections.tsx) | **OH** | system settings console + SLA legend (legend DERIVED from shared SLA_BANDS) | SectionCard, Field/Input, Tabs? | per-key edit forms | — | org/settings api | M |
| 33 | /help | help/HelpCenterPage | any | role-scoped static guidance + glossary | SectionCard | — | — | — | L |
| 34 | /_kitchensink | KitchenSink.tsx | DEV | design-system audit page (renders whole kit incl. latent TicketCard) | everything | — | — | — | L |

Contexts used by pages: `useAuth` (19 files — role checks like `canAdjust`, OH-only buttons,
acting zone); `useToastOptional` (RunIngestionButton only); ingestionEvents (TopBar↔OH dashboard).

---

## SECTION 5 — COMPONENT IMPORT GRAPH (major chains)

```
tokens(index.css) → EVERYTHING

cn.ts → every component

Button → Modal.footer / DataTable.ErrorState(retry) / every form + action
  Button → RunIngestionButton → TopBar → AppShell → all authed pages

Card → SectionCard → WarehouseDashboard / ExportsPage / SettingsPage / HelpCenter
Card → ActionRequiredPanel → ZmDashboard → ManagerDashboard → DashboardHome → route "/"

Badge → SLABadge/StatusPill/TierBadge (domain) → DataTable columns → 20+ queue pages
Badge → "Snapshot Healthy" chrome on all 4 dashboard headers

Skeleton/EmptyState/ErrorState → DataTable → 28 files (every list/queue page)
DataTable → ZoneOverviewTable + CompanyPlantTable + ScorecardTable → 3 manager dashboards

Metric/MetricCard → MetricStrip → all dashboards + SchedulesPage/Reports/ZmScorecard KPI rows
RollingNumber → OpsHeadDashboard KPI values (runToken = ingestion completion)

Modal → 8 mutation surfaces (WarehouseDashboard stock, ScheduleDetail overrides, CrossZone,
        NonOp, Vouchers, Verification, SE mgmt, PlantDeactivations)

lib/slaBucket → SLABadge, DurationBadge, ZoneOverviewTable, ScorecardTable, OpsHead
        DistributionBar segments, KPI Critical+ (kpi-critical-plus-consistency.test pins this)

AuthProvider → ProtectedRoute + RoleRoute + AppShell + TopBar + nav + 19 pages
api/http installAuthFetch → window.fetch → ALL api modules
```

---

## SECTION 6 — HIGH IMPACT COMPONENTS (ranked)

| Rank | Component | Reach | Impact | Why |
|---|---|---|---|---|
| 1 | **index.css tokens** | entire app | ★★★★★ | Every color/radius/shadow/font routes through `@theme`; restyling the app is mostly editing this one file |
| 2 | **AppShell + Sidebar + TopBar + Footer** | every authed screen | ★★★★★ | The first thing seen everywhere; dark-chrome identity lives here |
| 3 | **DataTable** | 28 files | ★★★★★ | Every queue page IS this table; density/hover/sticky-header changes transform the app |
| 4 | **PageHeader** | 32 files | ★★★★★ | Top of literally every page |
| 5 | **Button** | 28 files | ★★★★★ | Every CTA; variants set the interaction voice |
| 6 | **MetricCard/MetricStrip** | 15 files | ★★★★☆ | The KPI language of all dashboards + reports |
| 7 | **Badge + domain badges** | ~25 effective | ★★★★☆ | Status color language of the whole domain |
| 8 | **Card/SectionCard** | base of everything | ★★★★☆ | Surface/elevation identity |
| 9 | **Modal** | 8 mutation flows | ★★★★☆ | Every dialog; also the app's biggest a11y gap (no focus trap) |
| 10 | **feedback trio (Skeleton/Empty/Error)** | via DataTable ≈ everywhere | ★★★★☆ | Perceived quality in all loading/empty moments |
| 11 | **Field/Input/Select** | all forms | ★★★☆☆ | Form texture |
| 12 | **charts/**** | 8 report surfaces | ★★★☆☆ | Reports' visual payoff |
| 13 | **icons.tsx** | shell + nav + buttons | ★★★☆☆ | One-file icon-set swap |
| 14 | **SnapshotBanner** | all pages (top strip) | ★★★☆☆ | Global trust signal |
| 15 | **FilterBar/FilterSelect** | 12 files | ★★★☆☆ | List-page toolbars |

---

## SECTION 7 — PAGE ANALYSIS (importance × risk)

Business importance tiers (from domain: this app runs field operations):

- **Mission-critical daily**: `/` dashboards, /tickets, /schedules + detail, /intraday,
  /verification, /warehouse/requests. Risk: HIGH — dense action wiring + tested selectors.
- **Operational weekly**: /cross-zone, /readiness/*, /component-*, /warehouse/*, /vouchers,
  /leave-requests, /engineers*. Risk: MEDIUM-HIGH (Modal-driven mutations).
- **Analytical**: /reports/* — read-only, chart-heavy. Risk: LOW-MEDIUM (recompute buttons only).
- **Admin/config**: /settings, /coverage, /plant-deactivations, /exports, /install. Risk: MEDIUM
  (forms w/ validation, OH gates). Settings' SLA legend derives from shared SLA_BANDS — display
  logic must survive.
- **Support**: /help, /login, /_kitchensink. Risk: LOW (login's auth flow is off-limits, its look is not).

Per-page complexity/dependency detail is in the Section 4 matrix; forms/dialogs/tables per page in
docs 11/12/13.

---

## SECTION 8 — AI REDESIGN GUIDE (per-page permissions)

Legend: ✔ = YES, may change; ✖ = NO. Columns: Layout / Colors / Typography / Icons / Cards /
Tables / Buttons / Forms(visual) / Dialogs(visual) / Animations / Responsive.

| Page | Lay | Col | Typ | Ico | Card | Tbl | Btn | Form | Dlg | Anim | Resp |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Login | ✔ | ✔ | ✔ | ✔ | ✔ | – | ✔ | ✔ | – | ✔ | ✔ |
| Dashboards (all 4 variants) | ✔* | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Tickets + Drawer | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Schedules / ScheduleDetail / Intraday | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Engineers (3 pages) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Queues (cross-zone, readiness ×3, component ×2, warehouse ×3, verification, vouchers, leave) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Install create | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Reports (6 pages) | ✔ | ✔** | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Settings / Coverage / PlantDeact / Exports | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Help / KitchenSink | ✔ | ✔ | ✔ | ✔ | ✔ | – | ✔ | – | – | ✔ | ✔ |

Universal caveats (the asterisks):

- ✔* **Dashboard layout**: section ORDER and grouping may change, but every variant must keep ALL
  its sections and role selection logic; gated "—" placeholder cards (Fleet Uptime, Auto-Dispatch
  efficiency strip, 7 stub action cards) must remain visibly present and honest — restyle them,
  never fill them with fabricated numbers, never delete them.
- ✔** **Report/SLA colors**: chart series colors may be re-themed EXCEPT the SLA bucket ramp —
  bucket→color must stay one consistent mapping app-wide; change it only by editing
  `BUCKET_HEX`/`BUCKET_CLASS` in `lib/slaBucket.ts` (single source), never per-page.
- **Icons**: swap freely but keep them inline-SVG via `ui/icons.tsx` (or introduce lucide — it IS
  in package.json) — do it in one place; nav icon MEANINGS stay.
- **Tables**: visual restyle yes; but sorting behavior, column CONTENT, `ariaLabel`, `rowTestId`,
  row-click targets, CSV export buttons stay.
- **Forms**: fields, names, validation, submit payloads stay; only presentation changes.
- **Dialogs**: keep open/close triggers, Esc+backdrop close, role="dialog"/aria-modal, footer
  action semantics.
- **Animations**: all may change but MUST keep the `prefers-reduced-motion` global kill-switch and
  the two tested behaviors: RollingNumber roll-on-runToken and RunIngestionButton live/idle states.
- **Responsive**: breakpoints/stacking may change; nothing may become unreachable on small screens.

---

## SECTION 9 — ABSOLUTELY DO NOT CHANGE (global + per-area)

**Global — applies to every page:**

1. **Routing**: every path in `AppRoutes.tsx`, nested `/tickets/:ticketId`, `ProtectedRoute`/`RoleRoute`
   wrappers and their exact `roles` arrays. (routing.test.tsx pins this.)
2. **Auth machinery**: `AuthProvider` internals (rehydrate via /me, proactive refresh at exp−60s,
   sessionExpired flow), `installAuthFetch` + `makeAuthFetch`, `tokens.ts` storage keys
   (`fsm.accessToken`, `fsm.refreshToken`), `fsm.actingZone` sessionStorage key.
3. **API modules**: every exported function name, parameter shape, endpoint path, payload,
   query-string construction, error contract (`RUN_IN_PROGRESS` handling in integration.ts, 409
   `{code}` handling). Includes `authHeaders.ts` and the `X-Acting-As-Zone` header.
4. **Contexts/providers & order**: AuthProvider > BrowserRouter > ToastProvider; SidebarProvider
   inside AppShell. Exported hook names (`useAuth`, `useToast`, `useToastOptional`).
5. **Selectors**: all **54 unique `data-testid`s** and **54 unique `aria-label`s** (67 test files
   assert them). Known load-bearing ids: `action-card`, `critical-group`, `kpi-critical-plus`,
   `scorecard-inactive-total`, `scorecard-critical-plus`, `bucket-<BUCKET>`, `trend`,
   `warehouse-dashboard`, `stock-row-*`, `stock-adjust-*`, `stock-save`, plus every DataTable
   `ariaLabel` string and `rowTestId` pattern. Grep before renaming ANY string in JSX.
6. **Domain logic single-sources**: everything in `lib/` (Section 2.8) and `components/domain/`
   mappings; `SLA_BANDS` import from `@fsm/shared`; `CRITICAL_PLUS_BUCKETS`; `buildNav(role)`
   role→links matrix; ActionRequiredPanel's urgency sort; EscalationQueueList severity sort;
   ZoneOverview/CompanyPlant filter + CSV logic; formatInactiveOfTotal.
7. **Component export names & prop names** of every shared component (incl. the `AdminShell`
   re-export alias) — pages and tests import them by name.
8. **Event flows**: ingestionEvents pub/sub (TopBar → OH dashboard refetch → RollingNumber
   runToken bump); CriticalQueue assign → `POST /schedules/assign` → `onAssigned` refetch;
   Modal-confirm → api call → list refetch patterns.
9. **Gated-placeholder policy**: "—" values + "coming soon" stubs render honest chrome, never
   invented data (DESIGN-SYSTEM §9.2).
10. **State management approach**: local useState/useEffect per page. Do NOT introduce
    react-query/Redux/context stores as part of a visual redesign.
11. **`@fsm/shared` imports** (`SessionView`, `LoginRequest/Response`, `ROLES`, `SLA_BANDS`).
12. **CSS safelist**: the `@source inline("grid-cols-{1,2,3,4,5,6}")` lines in index.css (or the
    equivalent for any new dynamic class lookup) — dynamic `cols` classes break silently without them.

**Per-page**: the APIs/Forms/Dialogs columns in Section 4 enumerate exactly which api modules and
mutation flows each page owns — for any page you touch, that column is its DO-NOT-CHANGE list.

---

## SECTION 10 — SAFE TO MODIFY (the visual layer)

- **All token VALUES** in `index.css @theme`: brand scale, chrome navy, luxury gold accents,
  surfaces, ink scale, semantic fg/bg pairs, `--radius-card`, all three shadows, `--font-sans`,
  the body background gradients, selection color, scrollbar styling. (Keep token NAMES — 30+
  files reference them as Tailwind utilities.)
- All Tailwind classNames inside components/pages: spacing, grids, flex, gaps, borders, radii,
  shadows, hover/focus styles, gradients, density, column widths, sticky behavior styling.
- Typography: sizes, weights, tracking, the caps-label treatment, table th styling.
- Icon artwork (via `ui/icons.tsx`, one file — or adopt the already-installed lucide-react).
- Card/section visual identity (`.premium-panel`, SectionCard header gradient, MetricCard accent
  bars, DistributionBar heat-ramp styling — colors via slaBucket single source).
- Loading skeletons, empty states, error blocks (content of `feedback.tsx`), illustrations.
- Animations/transitions (base 180ms curve, hover lifts, `.ingest-live` glow, `ingest-word-in`),
  provided reduced-motion stays and tested behaviors keep firing.
- Responsive breakpoints and stacking; sidebar collapse visuals; `.enterprise-page` max-width.
- Login page look; Help page presentation; KitchenSink layout (it's the audit surface — extend it
  with any new kit variants).
- DateRangeChips appearance (it's static chrome anyway — do NOT wire it to data during redesign).
- Adding `className` props or purely-visual optional props to kit components (additive only).

---

## SECTION 11 — HIGH-RISK AREAS (why)

| Area | Why risky |
|---|---|
| `api/http.ts` + `tokens.ts` + AuthProvider | Session survival: single-flight refresh, retry-once, proactive timer, expired-session UX. Any edit can log every user out or loop refreshes. Tested (session-lifecycle, login). |
| ProtectedRoute / RoleRoute / AppRoutes | Security UX + routing.test.tsx. A changed `roles` array silently exposes/hides pages. |
| `nav.ts buildNav` | Role information architecture; dashboard-role-variants + acting-banner tests assert it indirectly. |
| DashboardHome→ManagerDashboard selection + actingZone collapse | 4-variant logic + acting-as behavior (tested). KPI derivations (`sumCriticalPlusDevices`) must equal scorecard sums — kpi-critical-plus-consistency.test enforces. |
| DataTable | 28 consumers; its props are load-bearing contracts (ariaLabel, rowTestId, sort, onRowClick, built-in states). Restyle markup INSIDE it; don't alter its interface or state logic. |
| Modal | Only dialog primitive; 8 mutation flows ride open/close/footer semantics. Adding a portal/focus-trap is an allowed IMPROVEMENT but must keep Esc/backdrop/aria and in-place render assumptions of tests. |
| Complex form pages (Install CSV, SE directory, CrossZone decisions, Vouchers multi-select PAID, ScheduleDetail overrides) | Multi-step payload construction + optimistic refetches; visual edits must not touch handlers. |
| `lib/slaBucket.ts` & domain badges | Single-source domain truth; several tests + backend parity depend on it. |
| RunIngestionButton + ingestionEvents + RollingNumber | Cross-component event chain with dedicated tests (run-ingestion-button/dashboard, rolling-number). |
| SnapshotBanner | Global trust strip with FAILED/stuck logic; keep the states and copy semantics. |
| `api/dashboard.ts` non-standard fetch | It bypasses authHeaders and reads sessionStorage directly; "harmonizing" it is a functional change — out of scope. |

---

## SECTION 12 — SHARED COMPONENT STRATEGY

| Component | Pages affected | Risk | Visual impact | Priority | Safe? | Recommended changes | Expected improvement |
|---|---|---|---|---|---|---|---|
| index.css tokens | all | Low | ★★★★★ | **P1** | ✔ | New palette/elevation/type scale in place (names intact) | Whole-app rebrand in one file |
| AppShell/Sidebar/TopBar/Footer | all | Med | ★★★★★ | **P2** | ✔ (keep nav data, acting banner semantics, RunIngestion states) | Modern chrome: refined nav grouping visuals, collapse polish, topbar hierarchy | Instant perceived redesign |
| PageHeader | 32 | Low | ★★★★☆ | **P3** | ✔ | Breadcrumb slot, tighter hierarchy, action alignment | Consistent page identity |
| Button | 28 | Med | ★★★★☆ | **P3** | ✔ (keep props incl. `loading`) | Refined variants/sizes, focus states | Interaction voice |
| Card/SectionCard/Badge/Field/Input/Select | ~20 | Low | ★★★★☆ | **P3** | ✔ | Elevation & density system, badge shape language | Surface quality |
| MetricCard/MetricStrip | 15 | Med | ★★★★☆ | **P3** | ✔ (testId passthrough, cols safelist) | Sparkline slot (visual-only), better numerals | Dashboard payoff |
| feedback trio | everywhere via DataTable | Low | ★★★★☆ | **P3** | ✔ | Branded skeletons/illustrated empties | Perceived speed |
| DataTable | 28 | **High** | ★★★★★ | **P4** | ✔ inside only | Density modes, sticky-header polish, better sort affordance, zebra option — interface frozen | Transforms every queue |
| Modal (+Sheet) | 8 | **High** | ★★★★☆ | **P4** | ✔ carefully | Portal + focus trap + motion (a11y upgrade), keep contracts | Dialog quality + a11y |
| charts/* + FilterBar | reports | Low | ★★★☆☆ | **P4** | ✔ (SLA ramp via slaBucket only) | Unified chart theme, axis/tooltip polish | Report credibility |
| icons.tsx | shell-wide | Low | ★★★☆☆ | P2–3 | ✔ | Swap to lucide (installed) or redraw — one file | Crispness |
| SnapshotBanner | all | Med | ★★★☆☆ | P2 | ✔ visuals only | Integrate into TopBar visually; keep states | Cohesion |
| domain badges | queues | Med | ★★★☆☆ | P3 | ✔ visuals via Badge | Don't touch mappings | Status legibility |
| Timeline / TicketCard | 0–1 | none | ☆ | last | ✔ | Optional: redesign & actually adopt in TicketDetailDrawer (additive) | Drawer upgrade |

---

## SECTION 13 — SAFE REDEVELOPMENT ORDER

- **Phase 1 — Tokens**: palette, type scale, spacing rhythm, radius, shadows in `index.css`.
  Keep every token NAME + the `@source` safelist. Verify on `/_kitchensink`.
- **Phase 2 — Shell**: Sidebar, TopBar, Footer, SnapshotBanner, acting banner, login page chrome.
- **Phase 3 — Primitives**: Button, Input/Field, Card/SectionCard, Badge(+domain skins),
  PageHeader, MetricCard/MetricStrip, feedback trio, icons.
- **Phase 4 — Patterns**: DataTable (internal restyle), Modal/Sheet (add portal+focus trap),
  Select/Tabs/Dropdown, FilterBar, charts theme.
- **Phase 5 — Dashboards**: 4 role variants (highest scrutiny: KPI consistency test, action-card
  stubs, RollingNumber, WM tables/links).
- **Phase 6 — Feature pages**: tickets+drawer → schedules/intraday → queues (readiness,
  warehouse, verification, vouchers, engineers, cross-zone) → install/planner.
- **Phase 7 — Reports** (6 pages; chart polish).
- **Phase 8 — Settings/admin** (settings, coverage, plant-deactivations, exports, help).
- **Phase 9 — Polish**: motion pass, responsive audit, a11y sweep (focus traps, focus-visible,
  contrast ≥ WCAG AA on new palette, keyboard paths through dialogs/tables).

Gate every phase with: `pnpm typecheck && pnpm test` in `apps/admin`, then the visual harness
(`pnpm visual`) and a manual `/_kitchensink` review.

---

## SECTION 14 — RULES THE AI MUST FOLLOW

1. Never modify anything under `src/api/` (functions, endpoints, payloads, headers, error handling).
2. Never modify backend contracts or expect new endpoints; gated "—" placeholders stay honest.
3. Never modify hooks (`hooks/index.ts`), contexts, providers, or their nesting order.
4. Never modify `AppRoutes.tsx` paths, `ProtectedRoute`/`RoleRoute`, or any `roles` array.
5. Never modify `buildNav` role→destination data (visual markup of Sidebar is fair game).
6. Never modify validation, submit handlers, payload assembly, or business calculations
   (`lib/*`, domain badge mappings, KPI derivations, sort orders).
7. Never modify authentication/session logic or storage keys.
8. Never rename exported components/functions/props; never delete the `AdminShell` alias.
9. Never remove or rename any `data-testid` or `aria-label`; never change `ariaLabel` strings
   passed to DataTable.
10. Never change event flow (ingestionEvents, onAssigned/refetch chains, Modal open/close wiring).
11. Never change state management (no new data libraries, no context extraction).
12. Never remove the `prefers-reduced-motion` kill-switch or the `@source` safelist lines.
13. Never fabricate data for placeholder cards; never delete "coming soon" stubs.
14. Never introduce raw hex values in components — extend `@theme` instead.
15. Keep the SLA bucket color ramp single-sourced in `lib/slaBucket.ts`.
16. Only the visual layer changes: classNames, markup structure within a component, token values,
    icon artwork, animations, responsive classes. When in doubt whether something is visual —
    grep the test folder first; if a test references it, it is a contract.

---

## SECTION 15 — AI IMPLEMENTATION CHECKLIST (before merging any page)

- ✓ `git diff` touches only classNames/markup/tokens — no api/, auth/, hooks/, lib/ logic diffs
- ✓ APIs unchanged (no api/ files in the diff)
- ✓ Hooks/contexts/providers unchanged
- ✓ Routing + role gates unchanged (`routing.test.tsx` green)
- ✓ Permissions UX intact (role-variant dashboards, OH-only buttons, WM nav)
- ✓ Validation + form submission verified by exercising each form on the page
- ✓ Tables: sort, row-click, CSV export, empty/loading/error states still function
- ✓ Dialogs: open, Esc, backdrop, confirm, cancel still work
- ✓ All data-testid / aria-label preserved (`grep -c` before vs after)
- ✓ Reduced-motion respected; RollingNumber + ingest-glow behaviors intact where applicable
- ✓ Responsive: 360px / 768px / 1280px / 1480px+ sanity pass
- ✓ `pnpm typecheck` passes; `pnpm test` passes (67 files); `pnpm visual` diffs reviewed
- ✓ `/_kitchensink` renders every kit variant without console errors

---

## SECTION 16 — FINAL RECOMMENDATIONS

**Top highest-impact (redesign these and the app is redesigned):** index.css tokens; AppShell;
Sidebar; TopBar; DataTable; PageHeader; Button; MetricCard/Strip; Badge(+domain skins);
Card/SectionCard; Modal; feedback trio; icons.tsx; Field/Input; Select; SnapshotBanner; Footer;
FilterBar/FilterSelect; ChartCard+chart theme; login page.

**Top highest-risk (touch last, with tests open):** api/http.ts; tokens.ts; AuthProvider;
ProtectedRoute/RoleRoute; AppRoutes; dashboard variant selection + actingZone collapse;
lib/slaBucket.ts; DataTable interface; Modal contract; RunIngestionButton chain; RollingNumber;
SnapshotBanner states; nav.ts data; CriticalQueue assign flow; voucher mark-PAID multi-select;
install CSV flow; ScheduleDetail overrides; cross-zone decision dialogs; domain badge mappings;
api/dashboard.ts non-standard fetch.

**Top easiest visual wins:** ① retheme `@theme` tokens (one file, whole app); ② swap icons.tsx
artwork; ③ feedback trio (skeletons/empties); ④ PageHeader hierarchy; ⑤ MetricCard numerals +
accents; ⑥ Sidebar/TopBar chrome; ⑦ Badge shape language; ⑧ table density/sticky polish inside
DataTable; ⑨ SectionCard header treatment; ⑩ login page; ⑪ Modal motion; ⑫ chart theme; ⑬ body
background; ⑭ Footer; ⑮ EmptyState illustrations; ⑯ focus-visible states; ⑰ acting-banner
styling; ⑱ SnapshotBanner integration; ⑲ hover states on rows/cards; ⑳ report grid rhythm.

**Best order**: exactly Section 13 (tokens → shell → primitives → patterns → dashboards →
features → reports → admin → polish). Expected improvement per phase: P1 ~40% of perceived
change; P2 +25%; P3 +15%; P4 +10%; P5–P9 the remaining fit-and-finish and page-level coherence.

**Three latent opportunities (optional, additive, non-breaking):** adopt the unused `Timeline`
in TicketDetailDrawer, `TicketCard` in queue/drawer views, and `Sheet` as the drawer chrome for
TicketDetailDrawer (which currently hand-rolls its panel) — all three exist and are exported, but
only KitchenSink renders them today.

---

*Cross-references: docs 01–20 in this folder for per-page/form/table/dialog detail;
`docs/ui/desktop/v2-reference/` for the authoritative screen imagery;
`docs/reverse-engineering/04_FRONTEND_ARCHITECTURE.md` for how this SPA sits in the platform.*
