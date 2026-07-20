# 02 — Application Architecture

> Part of the [UI Redevelopment Handoff](20-master-index.md). Previous: [01 — Overview](01-project-overview.md) · Next: [03 — Routing](03-routing.md).

## Overall architecture

A single-page React app with **no framework layer**: one `BrowserRouter`, one flat route table (`src/AppRoutes.tsx`), one authenticated shell layout, and one page component per route. There is **no global data store** — every page fetches its own data from typed API modules on mount and holds it in local state. Cross-cutting state is limited to three small contexts (auth session, toasts, sidebar) plus a tiny pub/sub for one event.

```
main.tsx
  installAuthFetch()                 ← patches window.fetch with the 401-refresh policy
  <StrictMode>
    <App>
      <AuthProvider>                 ← session, login/logout, actingZone
        <BrowserRouter>
          <ToastProvider>            ← toast host (bottom-right)
            <AppRoutes>
              <SnapshotBanner/>      ← freshness banner (renders null when logged out)
              <Routes>
                /login               ← LoginPage (own dark full-screen layout, NO shell)
                /_kitchensink        ← dev-only design-system audit page
                <ProtectedRoute><AppShell/></ProtectedRoute>   ← layout route
                   └─ <Outlet/>      ← every authenticated page renders here
```

## Feature modules / code organization

Pages are grouped by feature folder under `src/pages/` (dashboard, tickets, schedules, engineers, readiness, inventory, warehouse, cross-zone, install, planner, verification, vouchers, reports, exports, coverage, settings, help). Each page folder pairs with one or more API modules under `src/api/`. Full inventory in [05 — Modules](05-modules.md).

Components are organized by **kind, not feature**:

- `components/ui` — atomic primitives (Button, Card, Input, Badge, icons).
- `components/data` — data-display patterns (DataTable, FilterBar, MetricStrip, PageHeader, feedback states, Toast, DateRangeChips, RollingNumber).
- `components/overlay` — Modal, Sheet (drawer), Select, Tabs, DropdownMenu.
- `components/charts` — Recharts wrappers + ReportGrid + colors.
- `components/domain` — FSM-vocabulary components (SLABadge, StatusPill, TierBadge, AgeChip, DurationBadge, EntityBadge, TicketCard, Timeline, PlantName).
- `components/shell` — the app frame (Sidebar, TopBar, Footer, nav model, SidebarContext).

Feature-specific sub-components live **inside the page folder** (e.g. `pages/dashboard/CriticalQueue.tsx`, `pages/tickets/ticketBadges.tsx`, `pages/settings/sections.tsx`).

## How pages are built (the canonical "queue recipe")

Most pages follow one recipe, in this exact vertical order:

1. `PageHeader` — title + subtitle + optional right-aligned actions (often `DateRangeChips`, a Badge, or a primary CTA).
2. Optional inline error `<p role="alert" class="text-critical">`.
3. `MetricStrip` / `MetricCard` grid — KPI cards derived from the loaded rows.
4. Optional `FilterBar` with `FilterSelect` / `SearchInput` controls.
5. `DataTable` — the row list, with loading skeletons, error+retry, and `EmptyState` built in.
6. Optional side panel (`<section aria-label=…>` fixed-width column) or `Modal` for detail/actions.

Dashboards and reports substitute chart cards (`ChartCard` + `BarChartCard`/`TrendChart`/`DonutChart` inside `ReportGrid` 2-up grids) between the KPI strip and tables.

## How data flows

```
Page component
  └─ useEffect on mount / filter change
       └─ api module fn (typed fetch)  ──►  window.fetch (patched)
                                              └─ 401? → single-flight POST /auth/refresh → retry once
       └─ setState(rows) | setError(msg)
  └─ user action (button) ──► api mutation fn ──► reload()/refetch()
```

- Fetch-on-mount uses either raw `useEffect` + `alive` flag (older pages) or the `useApiResource` hook (`src/hooks/index.ts`) which formalizes loading/error/refetch.
- Mutations call the API module directly, then re-run the page's `load()` to refresh (no cache, no optimistic updates except Settings sections' list appends).
- There is **no client-side cache**; navigating back re-fetches.

## Where layouts live

Single layout: `components/shell/AppShell.tsx` (aliased as `AdminShell`), applied as a parent layout route in `AppRoutes.tsx`. The login page and kitchen sink render outside it. Details in [04 — Layout](04-layout.md).

## How routing works

`react-router-dom` v6, all routes declared statically in `src/AppRoutes.tsx` (no lazy loading, no code splitting). One nested route exists: `/tickets/:ticketId` renders `TicketDetailDrawer` in the `TicketsPage`'s `<Outlet/>` so the drawer appears beside the still-mounted list. Full table in [03 — Routing](03-routing.md).

## How permissions work (three layers — all must be preserved)

1. **Route layer** — `RoleRoute roles={[…]}` wraps each gated page; wrong role → redirect to `/`, no session → `/login`.
2. **Nav layer** — `buildNav(role)` in `components/shell/nav.ts` only emits links the role may see (WM gets a Warehouse group; managers get Operations/Components/Analytics; only OH gets Admin).
3. **In-page layer** — components check `session.role` for finer affordances (e.g. Set Availability is ZM/CSM but never OH; Override-confirm and deal-type tagging are OH-only; ComponentRequestsPage takes a `readOnly` prop on the manager oversight route; RunIngestionButton renders `null` unless OH).

The backend enforces the same rules with `@Roles()` guards — the UI gates are affordance mirrors, **not** the security boundary.

An additional scoping mechanism is **acting mode**: a CSM/OH can "Act as ZM" for a zone (TopBar input). This sets `actingZone` in AuthContext + `sessionStorage`; API calls attach an `X-Acting-As-Zone` header (`api/authHeaders.ts`); the shell shows an amber acting banner; the dashboard collapses to the Zone (ZM) variant.

## How state is shared

- `AuthContext` (`useAuth`) — session, loading, sessionExpired, login/logout, actingZone. Global.
- `ToastContext` (`useToast` / non-throwing `useToastOptional`) — push/success/error toasts, 4 s auto-dismiss.
- `SidebarContext` (`useSidebar`) — desktop collapse (persisted to `localStorage` `fsm.admin.sidebar.collapsed`) + mobile drawer open.
- `ingestionEvents.ts` — module-level pub/sub connecting the TopBar "Run Ingestion Now" button to the OH dashboard KPI refresh.
- Everything else: page-local `useState`/`useMemo`.

Details in [09 — State](09-state.md).

## How themes work

Light theme only, defined once as Tailwind v4 `@theme` variables in `src/index.css` (colors, radius, shadows, font). Every component consumes tokens through Tailwind utility classes (`bg-surface-card`, `text-ink-strong`, `border-line`, `shadow-card`, …). **Rule stated in the token file: no component may introduce a raw hex or off-scale value.** Charts get concrete hex mirrors from `components/charts/colors.ts` and `lib/slaBucket.ts` `BUCKET_HEX` because Recharts needs color strings. No dark mode, no theme provider, no runtime theme switching (the login page is a deliberately dark one-off surface styled inline). Details in [14 — Design System](14-design-system.md).

## How forms work

No form library. Each form is controlled `useState` per field (sometimes one object), a `canSubmit`/`valid` boolean gating the submit button, an async submit handler that maps backend error codes to friendly messages (`ERROR_MESSAGE` records), and `role="status"` / `role="alert"` paragraphs for success/failure. Mandatory-reason capture appears in three shapes: inline expanding row forms, `Modal` dialogs, and (legacy, slated for replacement) `window.prompt`. Details in [11 — Forms](11-forms.md).
