# 04 — Application Layout

> Part of the [UI Redevelopment Handoff](20-master-index.md). Previous: [03 — Routing](03-routing.md) · Next: [05 — Modules](05-modules.md).

## Root layout — `AppShell` (`src/components/shell/AppShell.tsx`)

Applied as a layout route wrapping every authenticated page. `components/AdminShell.tsx` re-exports it as `AdminShell` (historical import path used by `AppRoutes` and tests — keep the alias).

```
┌──────────────────────────────────────────────────────────────┐
│ SnapshotBanner (full-width, above everything, from AppRoutes)│
├───────────┬──────────────────────────────────────────────────┤
│           │ TopBar (sticky, h-4.25rem, light, backdrop-blur) │
│  Sidebar  ├──────────────────────────────────────────────────┤
│  (dark    │ [Acting-as-ZM amber banner — only when acting]   │
│  navy,    ├──────────────────────────────────────────────────┤
│  w-64 /   │ <main> p-4/6/8                                   │
│  4.75rem  │   <div class="enterprise-page">  (max-w 1480px,  │
│  collapsed│      centered)                                   │
│  sticky   │      <Outlet/>  ← active page                    │
│  full-    │                                                  │
│  height)  ├──────────────────────────────────────────────────┤
│           │ Footer (dark navy, 4 link columns + status row)  │
└───────────┴──────────────────────────────────────────────────┘
```

Flex row: `div.flex.min-h-screen` → `Sidebar` + `div.flex.min-w-0.flex-1.flex-col` (TopBar / banner / main / Footer). Renders `null` when there is no session. Wrapped in `SidebarProvider`.

## Sidebar (`shell/Sidebar.tsx`)

- **Dark navy** (`bg-chrome-900`, `text-chrome-text`), role-grouped nav from `buildNav(role)` (`shell/nav.ts`): group heading (10px caps, `text-chrome-muted`) over links (icon + 13px label, left `border-l-2` accent `luxury-300` + `bg-white/10` when active, `aria-current="page"`).
- **Brand band** at top: white strip (h-4.25rem) with hamburger collapse toggle (desktop), `BrandLogo` (red "autoplant Systems" wordmark + caps "FIELD MANAGEMENT SYSTEM" caption — **color/casing pinned to legacy reference, do not restyle**), and a close button (mobile).
- **Desktop ≥lg**: in-flow sticky rail animating `w-64` ↔ `w-[4.75rem]` (icon-only). Collapse state persists via `SidebarContext` → `localStorage` key `fsm.admin.sidebar.collapsed`. Collapsed items keep accessible names (`sr-only` labels) and show a **body-portal tooltip** (`role="tooltip"`, positioned via `getBoundingClientRect`) on hover/focus.
- **Mobile <lg**: off-canvas drawer (`fixed`, `-translate-x-full` closed) over a tap-to-dismiss scrim (`bg-black/40`); auto-closes on route change. Collapse doesn't apply on mobile.
- Footer strip inside the rail: "Admin Console v2.0 · role-gated nav".
- Nav groups by role: WM → Warehouse (Dashboard, Component Requests, Shadow Use Queue, Recovery Receipt) + Support. Managers → Operations (13 links), Components & Warehouse (2), Analytics (4, +ZM Scorecard for OH), and for OH an Admin group (Coverage, CSM Backup Share, Exports, Settings). Support (Help) for everyone.

## TopBar (`shell/TopBar.tsx`)

Sticky (`top-0 z-20`), light (`bg-surface-card/90 backdrop-blur-xl`, bottom hairline, `shadow-card`), h-4.25rem. Left → right:

1. Mobile hamburger (opens drawer; `lg:hidden`).
2. Real breadcrumb (desktop only, `nav aria-label="Breadcrumb"`): `Dashboard [› ancestor]* › {page}`, resolved
   by `resolveBreadcrumb(pathname, role)` (`shell/breadcrumb.ts`) off `buildNav(role)` (longest-prefix match)
   plus a small `DETAIL_CRUMBS` table for the ~6 detail routes absent from nav (ticket/schedule/dispatch-run/
   batch detail, fleet directory); unmatched paths fall back to `Dashboard › Console`. Ancestors are links,
   the current page carries `aria-current="page"`. **#160 (2026-07-27, operator decision):** this **replaces**
   the former "FSM Command Console" eyebrow + `PAGE_TITLES` prefix table (both deleted) — the sidebar wordmark
   already carries branding, so a second product name in the topbar was retired as clutter.
3. Global search input (decorative — **no behavior wired**), placeholder "Search ticket, vehicle, plant, device…", `aria-label="Search"`, hidden below `md`.
4. Right cluster: `RunIngestionButton` (renders null unless OH; pulsing red "cooking words" animation while running; confirm Modal; broadcasts `emitIngestionComplete` on success) · "Assign SE" primary button (`navigate('/')`) · **Act-as-ZM control** (CSM/OH only, when not acting): zone number input + "Go" → `setActingZone` · divider · notifications bell (decorative, no behavior) · profile chip (initials avatar from role label, role name + zone label) · "Log out" secondary button.

## Acting banner (in `AppShell`)

When `actingZone != null`: amber `role="status"` strip under the TopBar — "Acting as Zonal Manager for Zone N (audited as ROLE)" + "Exit acting mode" button.

## SnapshotBanner (`components/SnapshotBanner.tsx`)

Above the shell on every authenticated page (mounted in `AppRoutes`, not the shell). Fetches `GET /snapshots/latest` once per session. Normal: slate `role="status"` strip "Snapshot: data as of <time>". Failure/stuck (>15 min RUNNING): red `role="alert"` strip "Snapshot alert: last run failed / stuck — showing data as of … may be stale". Hidden when logged out or before first fetch resolves. ⚠️ Uses raw slate/red Tailwind palette classes (predates the token system).

## Footer (`shell/Footer.tsx`)

Dark navy (`bg-chrome-900`). Brand block (red wordmark + caption + one-paragraph description) beside 4 static link columns (Command Center / Planning / Warehouse / Governance — **plain text, not links**), then a hairline-topped status row ("Admin Console v2.0 · Role-gated · Live operations · All zones").

## Page container

`<main class="flex-1 p-4 sm:p-6 lg:p-8">` → `<div class="enterprise-page">` (utility: `max-width:1480px; margin-inline:auto`). Pages own everything inside; there is no per-page secondary chrome.

## Breadcrumbs / Tabs / Split layouts

- **Breadcrumbs**: only the TopBar title block (see above). No breadcrumb trail component.
- **Tabs**: two implementations — the shared ARIA `Tabs/TabList/Tab/TabPanel` (`components/overlay/Tabs.tsx`) and two hand-rolled `role="tablist"` bars (TicketDetailDrawer, SettingsPage). All emit proper `role="tab"`/`aria-selected` (test contract).
- **Split (master–detail) layouts**: `flex gap-6` with `min-w-0 flex-1` table + fixed-width right panel:
  - TicketsPage + TicketDetailDrawer (`aside.w-96`, nested route).
  - SeManagementPage detail panel (`section[aria-label="SE detail"].w-80`).
  - SeManagementDirectoryPage edit panel (`section[aria-label="SE edit"].w-80`).
  - DeviceDetailPage stacks detail cards *below* the list instead.

## Dashboard layout

`/` selects a variant by role (see [06 — Pages](06-pages.md)): all variants are single-column stacks of PageHeader → MetricStrip → sections (cards/tables/charts), no widget grid system.

## Authentication layout (`pages/LoginPage.tsx`)

Full-screen dark (`bg-chrome-900`) 2-column grid (`lg:grid-cols-[1.05fr_0.95fr]`) with a blueprint-grid + gold-radial background: left marketing panel (brand mark, headline "Manage Fleet Operations Faster.", 4 static KPI tiles) hidden below `lg`; right sign-in card (`bg-chrome-800/75 backdrop-blur-xl`, max-w-sm) with email/password (show/hide toggle), "Remember me" (decorative), "Forgot Password?" (dead link), session-expired notice, error `role="alert"`, feature checklist, version caption. Dark inputs styled inline (the one dark-surface exception to the shared `Input`).

## Modal / overlay layers (z-index map)

| Layer | z | Source |
|---|---|---|
| Sidebar mobile scrim / drawer | 30 / 40 | Sidebar |
| TopBar | 20 | TopBar |
| Sheet (drawer overlay) | 40 | overlay/Sheet |
| Modal | 50 | overlay/Modal |
| Toasts | 50 (fixed bottom-right) | data/Toast |
| Collapsed-rail tooltip | 60 | Sidebar portal |

Modal: centered, `max-w-md` default (`className` can widen), backdrop `bg-chrome-900/50 backdrop-blur-md`, Escape + backdrop close, gradient header band, footer button row. Sheet: right (or left) slide-over `w-[440px] max-w-[92vw]`, same header/footer treatment. Neither traps focus (known limitation, not a contract).
