# 151 — Dashboard/shell polish + `InactiveCountLink` drill-through
Status: accepted
Type: AFK

> Filed 2026-07-22 by [#144](./144-commit-dispatch-correctness-layer.md) Slice 3 to own found
> working-tree code, per the INDEX WIP convention (INDEX:53-55 precedent). The work was **already
> built and tsc-clean** when this stub was filed; the stub exists so the commit has an owner, not to
> schedule new work.

## What to build

*(Already built — recorded here for traceability.)*

An operator-QA polish batch across the admin shell and the dashboard, plus one new reusable domain
component:

**New — `InactiveCountLink`** (`components/domain/`). The `inactive / total` count becomes a
click-through into the Device Detail list, pre-filtered to exactly the inactive devices the count
represents. Design decisions recorded in its docblock and worth preserving:

- `scope` carries the entity params Device Detail already reads (`zoneId`, `companyId`, `plantId`, …);
  `status=INACTIVE` is added here, reusing **the same deep-link contract as the Zone Scorecard's
  Critical count** rather than inventing a second one.
- The whole `N / M` string is **one** link, never split across nodes — so it reads as a single
  affordance and existing text assertions keep matching.
- A **zero** inactive count is not a link (nothing to drill into); it renders as muted plain text.
- `stopPropagation` prevents a row-level expand/navigate handler from also firing.

**Shell**

- Brand logo is now a `Link` to `/` with an accessible label, closing the mobile drawer on click
  (previously inert text).
- `SidebarContext` gains an explicit `collapse()` action alongside `toggleCollapsed()`, with stable
  callback identity preserved — the route-change effect in `<Sidebar>` depends on `closeMobile` not
  changing every render, or it would re-fire and immediately re-close a just-opened drawer.
- `AppShell`, `Footer` layout/behaviour adjustments; supporting keyframes/utilities in `index.css`.

**Dashboard / dispatch**

- `DashboardHero` gains a `centerBelow` slot.
- `ZmDashboard` KPI label `Devices` → **`Active Fleet`** (aligning the ZM view with the Operations-Head
  wording introduced by `ad03769`).
- `ZoneOverviewTable`, `ZoneDispatchTable`, `ActivityTrendSection`, `FleetActivityTrendChart` adopt
  `InactiveCountLink` and related tidy-ups.

## Acceptance criteria

- [x] `InactiveCountLink` exists, is exported from `components/domain`, and reuses the existing
      Device-Detail deep-link contract rather than adding a second one.
- [x] Zero inactive counts render as non-interactive muted text.
- [x] The brand logo navigates to `/` and is keyboard-reachable with an accessible label.
- [x] `SidebarContext.collapse()` is available with stable callback identity.
- [x] Adopting surfaces (zone overview, zone dispatch, activity trend) render the linked count.
- [x] `tsc --noEmit` clean; the three touched specs updated alongside.

## Not in scope / known state at filing

This batch does **not** touch `kpi-critical` on any dashboard — verified. The Critical Devices KPI
regression is a separate, committed defect owned by
[#143](./143-critical-devices-kpi-regression.md), introduced by `ad03769`, not by this work.

## UI surfaces

Admin: app shell (sidebar brand link, sidebar collapse action, footer), **ZM dashboard** (KPI label),
**Zone Overview table**, **Zone Dispatch table**, **Activity Trend section**. No new page or route.

## Reference

- `docs/ui/desktop/v2-reference/01-dashboard-zonal-manager.png`
- `docs/ui/desktop/v2-reference/04-dashboard-operations-head.png`
- `docs/ui/hero-ref.jpg` (hero composition)

## Blocked by
None (already built).
