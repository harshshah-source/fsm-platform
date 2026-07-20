# 08 — Custom Hooks

> Part of the [UI Redevelopment Handoff](20-master-index.md). Previous: [07 — Components](07-components.md) · Next: [09 — State](09-state.md).

## Shared hooks — `src/hooks/index.ts`

### `useApiResource<T>(fetcher, deps = [], errorMsg = 'Failed to load'): ApiResource<T>`
Standardized fetch-on-mount hook (formalizes the per-page `useEffect` + `alive`-guard pattern).
- **Params**: `fetcher: () => Promise<T>` (fresh closure each render — its identity is intentionally NOT a dependency; pass variability via `deps`), `deps: unknown[]`, `errorMsg` string used on any rejection.
- **Returns**: `{ data: T | null, loading: boolean, error: string | null, refetch: () => void }` (`refetch` bumps an internal nonce).
- **Used by**: ComponentBlockedPage (most pages still use the raw pattern — either is acceptable; do not change fetch timing).

### `useAsyncAction<A>(fn, onError = 'Action failed'): AsyncAction<A>`
Wraps a mutation so a Button can bind `loading={pending}` and surface `error`.
- **Returns**: `{ run: (...args) => Promise<void>, pending: boolean, error: string | null }`.
- **Used by**: available utility; pages mostly hand-roll `busy`/`submitting` state today.

### `useFilters<T extends Record<string, unknown>>(initial)`
Typed filter-state helper for FilterBar pages.
- **Returns**: `{ filters, set(key, value), setFilters, reset }`.
- **Used by**: available utility; pages mostly hand-roll filter state today.

## Context hooks

### `useAuth(): AuthContextValue` — `src/auth/AuthProvider.tsx`
Throws outside `AuthProvider`. Returns `{ session: SessionView | null, loading, sessionExpired, clearSessionExpired(), login(email, password), logout(), actingZone: number | null, setActingZone(zone | null) }`.
- `session` shape (from `@fsm/shared` `SessionView`): includes `role: Role` and `zone_id: number | null`.
- **Used by**: shell (AppShell, TopBar, Sidebar via prop), gates (ProtectedRoute, RoleRoute), SnapshotBanner, LoginPage, and every page with role-conditional UI (DashboardHome, ManagerDashboard, WarehouseDashboard, TicketDetailDrawer, SeManagementPage, SeManagementDirectoryPage, LeaveRequestsPage, CrossZonePage, InstallCreatePage, NonOperationalQueuePage, VoucherReviewPage, DeviceDetailPage, RunIngestionButton, HelpCenterPage, SettingsPage).

### `useToast(): ToastApi` / `useToastOptional(): ToastApi | null` — `components/data/Toast.tsx`
`{ push(message, tone?), success(message), error(message) }`. `useToastOptional` returns null when no provider (used by RunIngestionButton so it never crashes in isolation tests).

### `useSidebar(): SidebarState` — `components/shell/SidebarContext.tsx`
`{ collapsed, toggleCollapsed, mobileOpen, openMobile, closeMobile }`. Collapse persists to `localStorage['fsm.admin.sidebar.collapsed']`. Used by Sidebar + TopBar. Action identities are memoized (`useCallback`) — the Sidebar's route-change effect depends on `closeMobile` stability.

### `useRollingNumber(target, { runToken?, durationMs = 700, instant? }): number` — `components/data/RollingNumber.tsx`
Odometer count-up for one integer KPI. **The roll triggers on `runToken` change, not value change**; value changes without a token change snap instantly. Honors `prefers-reduced-motion`. Used by OpsHeadDashboard KPIs (via the `RollingNumber` component).

## Page-local hooks

### `useList<T>(fetcher)` — `pages/settings/sections.tsx`
Loads a list once on mount; returns `{ items, setItems, error }` (setItems used for optimistic appends after create). Local to Settings sections only.

## Deliberate non-hooks (module-level utilities used like shared state)

- `onIngestionComplete(fn): unsubscribe` / `emitIngestionComplete()` — `pages/dashboard/ingestionEvents.ts` pub/sub (TopBar button → OH dashboard).
- `authHeaders()` — `api/authHeaders.ts` reads token + acting zone from `sessionStorage` per request.
- `getAccessToken/getRefreshToken/setTokens/clearTokens` — `api/tokens.ts`.
