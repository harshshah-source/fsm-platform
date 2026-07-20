# 01 — Project Overview

> Part of the [UI Redevelopment Handoff](20-master-index.md). Next: [02 — Architecture](02-architecture.md).

## Project

| | |
|---|---|
| **Name** | FSM Admin Web Dashboard (`@fsm/admin`) — part of the FSM GPS Field Service Management platform (greenfield monorepo `fsm-platform-greenfield`) |
| **Purpose** | Admin command console for GPS-device field service operations: ticket dispatch, SLA governance, SE (Service Engineer) scheduling, readiness/recovery workflows, warehouse fulfilment, verification review, expense vouchers, reports/analytics, org configuration |
| **Business domain** | Field service management for GPS tracking devices installed on vehicles at cement plants (AutoPlant integration). Companies → Plants → Vehicles → Devices; Zones partition India geographically |
| **Target users** | Five roles: `ZONAL_MANAGER` (ZM), `CENTRAL_SERVICE_MANAGER` (CSM), `OPERATIONS_HEAD` (OH), `WAREHOUSE_MANAGER` (WM), `SERVICE_ENGINEER` (SE — mobile app only, not this dashboard) |
| **Backend** | NestJS modular monolith, Postgres 16 + PostGIS + Prisma, at `apps/backend` (same repo). API base `http://localhost:3000/api` (override via `VITE_API_URL`) |

## Tech stack

| Concern | Choice | Notes |
|---|---|---|
| React | **18.3.1** (`react`, `react-dom`) | `StrictMode` at root |
| Framework | **None** (plain Vite SPA) — no Next.js/Remix | Client-side rendering only |
| Bundler | **Vite 5.4** (`@vitejs/plugin-react`) | Dev server port 5173 |
| Language | **TypeScript 5.5**, strict, `.tsx` | ESM (`"type": "module"`) |
| Package manager | **pnpm** workspaces (`workspace:*` for `@fsm/shared`) | Monorepo: `apps/admin`, `apps/backend`, `apps/mobile`, `packages/shared` |
| Styling | **Tailwind CSS v4** via `@tailwindcss/vite`; design tokens as `@theme` CSS variables in `src/index.css` | No CSS modules, no styled-components, no Sass |
| Component library | **None (hand-rolled)**. All primitives are in-repo (`src/components/ui`, `overlay`, `data`, `charts`, `domain`) | ⚠️ `@radix-ui/*` and `lucide-react` are listed in `package.json` but **not imported anywhere in `src/`** (a FortiGate install block prevented use; icons are hand-rolled inline SVG) |
| State management | **React Context + local `useState`** only. No Redux/Zustand/MobX | Contexts: Auth, Toast, Sidebar, Tabs (see [09 — State](09-state.md)) |
| Data fetching | **Native `fetch`** with a global 401→refresh→retry interceptor installed over `window.fetch` (`src/api/http.ts`). No React Query / SWR / axios | 36 hand-typed API modules in `src/api/` (see [10 — API](10-api.md)) |
| Forms | **Uncontrolled-none / controlled `useState`** per page. No react-hook-form, no Formik | See [11 — Forms](11-forms.md) |
| Validation | Client: minimal (disabled-until-valid buttons, regex checks). Authoritative validation is **server-side**, surfaced via error-code → message maps | e.g. `ERROR_MESSAGE` maps in InstallCreatePage / SeManagementDirectoryPage |
| Authentication | JWT access + rotating refresh token in `sessionStorage`; login `POST /auth/login`, session `GET /me`; proactive refresh ~1 min before expiry + reactive single-flight 401 refresh | `src/auth/AuthProvider.tsx`, `src/api/http.ts`, `src/api/tokens.ts` |
| Authorization | Role gates: `ProtectedRoute` (any session) + `RoleRoute` (role allowlist) per route; in-page `session.role` checks for finer gating; backend `@Roles()` guards mirror every gate | See [03 — Routing](03-routing.md) |
| Charts | **Recharts 2.15** wrapped by in-repo chart components (`src/components/charts/`) + one pure-CSS `DistributionBar` | Colors from `charts/colors.ts` (hex mirror of tokens) |
| Icons | **Hand-rolled inline SVG set** — 29 icons in `src/components/ui/icons.tsx` (stroke-based, `currentColor`) | Zero-dependency lucide stand-in |
| Tables | In-repo generic **`DataTable<T>`** (`src/components/data/DataTable.tsx`) + 3 bespoke tables (CompanyPlant drill-down, Planner grid, 2 legacy plain tables) | See [12 — Tables](12-tables.md) |
| Date libraries | **None** — native `Date`, `toLocaleString`, ISO-slicing helpers | `lib/inactiveDuration.ts` for durations |
| Maps | **None** (polygon territory editor deferred; a disabled "Draw polygon on map" button reserves it) | |
| Utilities | `clsx` + `tailwind-merge` (via `lib/cn.ts`), in-repo CSV helper (`lib/csv.ts`), SLA-bucket vocabulary (`lib/slaBucket.ts`), plant-name mapping (`lib/plantNames.ts`) | |
| Testing | Vitest 2 + Testing Library (jsdom), Playwright visual capture/compare (`visual/`) | Tests assert `aria-label`s and `data-testid`s — **these are contracts** (see [16 — Business Constraints](16-business-constraints.md)) |

## Folder structure (`apps/admin`)

```
apps/admin/
├─ package.json               # scripts: dev / build / test / typecheck / visual
├─ vite.config.ts             # react + tailwindcss plugins, vitest config
├─ visual/                    # Playwright screenshot capture + pixelmatch compare
├─ test/                      # vitest specs (aria-label / data-testid driven)
└─ src/
   ├─ main.tsx                # entry: installAuthFetch() → render <App/>
   ├─ App.tsx                 # AuthProvider > BrowserRouter > ToastProvider > AppRoutes
   ├─ AppRoutes.tsx           # the single route table (all routes + role gates)
   ├─ index.css               # Tailwind v4 @theme design tokens + base + utilities
   ├─ api/                    # 36 typed fetch modules (one per backend domain)
   ├─ auth/                   # AuthProvider, ProtectedRoute, RoleRoute
   ├─ components/
   │  ├─ shell/               # AppShell, Sidebar, TopBar, Footer, BrandLogo, nav.ts, SidebarContext
   │  ├─ ui/                  # Button, Card/SectionCard, Input/Field, Badge, icons
   │  ├─ data/                # DataTable, FilterBar, MetricStrip, PageHeader, Toast, feedback, DateRangeChips, RollingNumber
   │  ├─ overlay/             # Modal, Sheet, Select, Tabs, DropdownMenu (all hand-rolled)
   │  ├─ charts/              # ChartCard, BarChartCard, TrendChart, DonutChart, RadialGauge, DistributionBar, ReportGrid, colors
   │  ├─ domain/              # SLABadge, DurationBadge, StatusPill, TierBadge, AgeChip, EntityBadge, TicketCard, Timeline, PlantName
   │  ├─ AdminShell.tsx       # re-export alias → shell/AppShell (kept for import stability)
   │  └─ SnapshotBanner.tsx   # data-freshness banner above every authenticated page
   ├─ hooks/index.ts          # useApiResource, useAsyncAction, useFilters
   ├─ lib/                    # cn, csv, slaBucket, inactiveDuration, plantNames
   └─ pages/                  # one folder per feature module (see 05-modules.md)
```

## Build system

- `pnpm dev` → Vite dev server (port 5173).
- `pnpm build` → `tsc -b && vite build`.
- `pnpm test` → Vitest (jsdom, `test/setup.ts`).
- `pnpm visual` → Playwright screenshot capture + pixelmatch diff against `docs/ui/desktop/v2-reference/` images.
- Env: `VITE_API_URL` (API base; defaults to `http://localhost:3000/api`). `import.meta.env.DEV` gates the `/_kitchensink` route.

## Authoritative UI references

Reference images (the layouts this UI was built to match) live at `docs/ui/desktop/v2-reference/` (e.g. `00-login`, `01/02` zone dashboard, `03` central tower, `04` pan-India, `05` warehouse, `07` tickets, `11–27` feature pages). Any redesign should still satisfy the **information hierarchy** those references encode.
