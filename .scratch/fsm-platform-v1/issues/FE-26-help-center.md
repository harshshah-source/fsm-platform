# FE-26 — Help Center

Status: done
Type: AFK · Frontend · Phase F5
Effort: S

> Governed by `DESIGN-SYSTEM.md` §8. Global DoD applies. (Deferred-tier; no backlog item previously owned it.)

## What to build

The Help Center page matching `27`: role-scoped grouped `SectionCard` topic grid (Your module / Components &
Warehouse / Analytics / Admin) with per-topic title + description + "View Docs" link, plus a "Model states &
terminology" glossary card section. Static/role-aware content — no backend dependency.

## Dependencies

- FE-02, FE-03

## Acceptance criteria

- [x] Help Center matches `27` (grouped topic cards + glossary)
- [x] Topic visibility role-scoped via existing role logic
- [x] Reachable from sidebar Help link

## Reusable components introduced

- `HelpTopicGrid`, `GlossaryCard` (composition)

## Affected pages

- new `/help` (**[N]** page)

## Reference

- `docs/ui/desktop/v2-reference/27-help-center.png`

## Verification

- new help-center test; Playwright ≈ `27`

## Outcome

New role-scoped Help Center at `/help` (`apps/admin/src/pages/help/HelpCenterPage.tsx`), built TDD
(RED `help-center.test.tsx` → GREEN, 3 tests):

- `buildHelpSections(role)` mirrors the nav's role logic: every role gets a "Your module — {ROLE_LABEL}"
  group; managers also get "Components & Warehouse" + "Analytics"; only the Operations Head gets "Admin";
  the Warehouse Manager is scoped to their own module (no Analytics/Admin).
- Each topic is a `Card` (title + description + a React-Router "View Docs →" link to the in-app
  destination it documents). `HelpTopicGrid` + `GlossaryCard` are local compositions over the DS `Card`.
- A "Model states & terminology" glossary `SectionCard` (6 domain terms from CONTEXT.md authority:
  ON_TRIP readiness, activity-ping-never-gates, two SLA pauses, derived SE states, global Common Kit,
  summary-table analytics) renders for all roles.
- Reachable from a new sidebar **Support → Help** link added to `buildNav` for **every** role (new
  `IconHelp` added to the icon set); breadcrumb title wired in `TopBar`. Route added under the
  authenticated `AppShell` group (all roles); no `RoleRoute` — content self-scopes.

Static/role-aware only — **no backend dependency** introduced; no existing behaviour changed.

Verified: `pnpm --filter @fsm/admin run typecheck` clean · `help-center.test.tsx` 3/3 · full suite
**103/103** · `vite build` OK.
