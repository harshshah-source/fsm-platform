# 09 — State Management

> Part of the [UI Redevelopment Handoff](20-master-index.md). Previous: [08 — Hooks](08-hooks.md) · Next: [10 — API](10-api.md).

**There is no Redux, Zustand, MobX, React Query, or TanStack anything.** State is: three React Contexts + one module-level pub/sub + browser storage + page-local `useState`. A redesign must not introduce a new global store for existing behavior — pages are intentionally self-contained.

## Global state (Contexts)

| Store | Provider location | What it holds | Persistence |
|---|---|---|---|
| **AuthContext** (`src/auth/AuthProvider.tsx`) | Root of `App` (outside the Router) | `session: SessionView\|null` (user role, zone_id, …), `loading` (token rehydration gate), `sessionExpired` flag, `actingZone: number\|null` + setters, `login()/logout()` | Tokens in `sessionStorage` (`fsm.accessToken`, `fsm.refreshToken`); actingZone in `sessionStorage` (`fsm.actingZone`); session object itself rebuilt from `GET /me` on reload |
| **ToastContext** (`components/data/Toast.tsx`) | Inside Router, wraps `AppRoutes` | Array of `{id, tone, message}`; auto-remove after 4 s | none |
| **SidebarContext** (`components/shell/SidebarContext.tsx`) | Inside `AppShell` (authenticated pages only) | `collapsed` (desktop icon-rail), `mobileOpen` (drawer) | `collapsed` → `localStorage` `fsm.admin.sidebar.collapsed` ('1'/'0'); `mobileOpen` transient |

## AuthProvider mechanics (do not change during redesign)

- **Login**: `apiLogin` → `setTokens` → `apiMe` → set session → schedule proactive refresh (timer fires ~60 s before JWT `exp`, decoded without verification).
- **Reload rehydration**: stored access token → `apiMe`; on failure try one rotating refresh (`apiRefresh`) then `apiMe`; else `clearTokens()`. While pending, `loading=true` — `ProtectedRoute` shows "Loading…" instead of bouncing to login.
- **Session expiry**: `setOnSessionExpired` callback (registered with `api/http.ts`) clears tokens + actingZone + session and sets `sessionExpired=true`; LoginPage shows "Your session expired."
- **Acting mode**: `setActingZone(n)` writes sessionStorage; `api/authHeaders.ts` reads the same key to attach `X-Acting-As-Zone` on ZM-scoped API calls; logout/expiry clears it.

## Event bus

`pages/dashboard/ingestionEvents.ts` — module-level `Set<Listener>` with `onIngestionComplete(fn)` / `emitIngestionComplete()`. Connects the TopBar `RunIngestionButton` (chrome) to `OpsHeadDashboard` (page) without threading callbacks. The dashboard subscribes in `useEffect` and on fire: refetches all KPI sources, then bumps `lastRunAt` which is the `runToken` for the `RollingNumber` odometers.

## Module-level singletons

- `api/http.ts`: `refreshInFlight` promise (single-flight refresh), `onExpired` callback. Installed once over `window.fetch` at app start.
- `lib/plantNames.ts` `PLANT_FULL_NAME`, `lib/slaBucket.ts` bucket vocabulary — static domain constants acting as single sources of truth.

## Local (per-page) state — the dominant pattern

Every page holds its own: `rows` (fetched data), `loading`, `error`, filter values, selection (`Set<string>` for multi-select), inline-form state (`rejectingId` + `reason`, `shippingId` + `trackingRef`, `editingId` + `dateInput`, …), modal open flags, and detail-panel selection (`selectedId` + lazily fetched `detail`). Lazy tab loading in TicketDetailDrawer keeps per-tab `null`-until-fetched state.

## Derived state conventions

- KPI numbers are `useMemo` reductions over already-fetched rows (never separate endpoints when the data is on hand).
- Critical+ counts must come from `lib/slaBucket` (`criticalPlusCount`, `sumCriticalPlusDevices`, `CRITICAL_PLUS_BUCKETS`) — Issue 1 requires the KPI to equal the scorecard column sum by construction.
- SE "Activity Status" is derived at render time server-side — the UI just displays it (never stored/edited client-side).

## Browser storage key inventory

| Key | Store | Written by |
|---|---|---|
| `fsm.accessToken` | sessionStorage | `api/tokens.ts` |
| `fsm.refreshToken` | sessionStorage | `api/tokens.ts` |
| `fsm.actingZone` | sessionStorage | AuthProvider `setActingZone` |
| `fsm.admin.sidebar.collapsed` | localStorage | SidebarContext |

Keep these literals stable — `api/authHeaders.ts` re-declares `fsm.accessToken`/`fsm.actingZone` and must stay in sync.
