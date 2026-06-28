# FE-02 — AppShell (Sidebar + TopBar + Footer)

Status: done
Type: AFK · Frontend · Phase F0
Effort: M

> Governed by `DESIGN-SYSTEM.md` §4. Global DoD applies. **Transition milestone** — after this lands,
> all new backend issues build on the design system.

## What to build

Replace the plain `AdminShell` chrome with the production `AppShell` frame every screen shares: dark
grouped icon sidebar, light topbar (breadcrumb + search + actions + user chip), dark footer, restyled
acting banner + `SnapshotBanner`. Keep `components/AdminShell.tsx` as a re-export of `AppShell` so
`AppRoutes.tsx` and `routing.test.tsx` need zero import changes. **Reuse the existing `NAV_ITEMS` + role
conditionals** — no RBAC change.

## Dependencies

- FE-01

## Acceptance criteria

- [x] Dark grouped icon sidebar (OPERATIONS / COMPONENTS & WAREHOUSE / ANALYTICS / ADMIN); active = red left-accent + tint; role-scoped via existing logic (Warehouse-scoped per `05`)
- [x] TopBar: breadcrumb "FSM Command Console › {page}", search, red `+ Assign SE`, Support/Settings, bell, role+zone user chip from `session`
- [x] Footer matches reference (link columns + status row)
- [x] Acting banner + `SnapshotBanner` restyled with logic/selectors preserved
- [x] `AdminShell` import path still resolves (re-export)

## Reusable components introduced

- `AppShell`, `Sidebar`, `TopBar`, `Footer`, `RoleNav`

## Affected pages

- all (frame; **[RP]+[N]**)

## Reference

- chrome across all `v2-reference/*`; warehouse-scoped nav `05`; acting banner `02`

## Verification

- `routing.test.tsx`, `acting-banner.test.tsx`, `snapshot-banner.test.tsx` green; Playwright on 2 routes shows correct chrome
