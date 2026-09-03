# 339 — Acting-scope gate, manager-unavailability windows, audited enter/exit
Status: ready-for-agent
Type: AFK
Wave: 1 · Severity: P1 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

`auth/acting-context.ts:24-39` grants acting to any CSM/OH whose header parses. `role_unavailability`
is never consulted (`roles/role-backup.service.ts:64-80` has no callers), the zone is not validated
(`99` is accepted; `abc` → NaN → pan-India), no admin page writes `POST /role-unavailability`,
entering/leaving acting leaves no trace, the banner shows a zone number (`AppShell.tsx:69`) and the
sidebar keeps the real role's menu (`Sidebar.tsx:28-29`).

## Current code

- `auth/acting-context.ts:24-39` — acting granted to any CSM/OH whose header parses; no
  unavailability check; no zone-existence check
- `roles/role-backup.service.ts:64-80` — `currentActingRoleForZone` exists and has no callers
- `common/manager-scope.ts:27-36` and `common/request-actor.ts:19-30` — each re-parses the header
  synchronously
- `roles/role-backup.controller.ts` — no `GET` list, no `DELETE :id`, no enter/exit audit
- No admin client for `POST /role-unavailability`
- `AppShell.tsx:69` — banner prints the zone number
- `Sidebar.tsx:28-29` — sidebar keeps the real role's menu while acting
- `auth/AuthProvider.tsx:135-138`, `TopBar.tsx:63-67` — acting state in the shell

## What to build

- New `common/acting-context.guard.ts` — resolves the header once per request into
  `request.acting`: zone existence via `org/zones`, unavailability via
  `RoleBackupService.currentActingRoleForZone`
- `common/manager-scope.ts:27-36` and `common/request-actor.ts:19-30` — read `request.acting`
  instead of re-parsing
- `roles/role-backup.controller.ts` — add `GET` list, `DELETE :id` (end window), and
  `POST /acting/enter|exit` audit endpoints
- `audit.service.ts` — actions `ACTING_STARTED` / `ACTING_ENDED`
- Admin: new `api/roleUnavailability.ts`; `pages/settings/sections.tsx` "Manager availability"
  section (OH/CSM); `auth/AuthProvider.tsx:135-138`; `AppShell.tsx:69` (zone name);
  `Sidebar.tsx:28` (ZM menu while acting); `TopBar.tsx:63-67`
- Tests: `test/acting-context.e2e-spec.ts`, `role-backup-*.e2e-spec.ts`,
  `dashboard-acting-scope.e2e-spec.ts`; admin `acting-banner`, `sidebar-shell`, `settings` tests
- Expected behaviour: a CSM can act in a zone only while that zone's ZM has an open unavailability
  window; an OH may act anywhere (pan-India authority) but every acting request is attributed and
  enter/exit is audited

## Acceptance criteria

- [ ] AC1 — CSM + header for a zone with no open window → 403 `ACTING_NOT_PERMITTED`; with a window
      → scoped as today
- [ ] AC2 — OH + header → allowed, attributed
- [ ] AC3 — unknown or non-numeric zone → 400 `ACTING_ZONE_INVALID` (never silent pan-India)
- [ ] AC4 — OH/CSM can open and end an unavailability window for a ZM from Settings; the list is
      visible
- [ ] AC5 — enter/exit writes `ACTING_STARTED` / `ACTING_ENDED` audit rows with zone
- [ ] AC6 — banner shows the zone **name**; sidebar shows the ZM menu while acting
- [ ] AC7 — ZM and WM sending the header remain clamped/refused as today

## Verification

e2e for AC1-3, AC5, AC7; admin tests for AC4, AC6.

## UI surfaces

- Admin: Settings → "Manager availability" section (new, OH/CSM)
- Admin: app shell — acting banner and sidebar (modified)

## Reference

- `docs/ui/desktop/v2-reference/02-dashboard-csm-acting-as-zone.png`
- `docs/ui/desktop/v2-reference/26-settings.png`

## Blocked by

— (none)

## Absorbs / supersedes

- survey ids: AA-01, AA-05, AA-07, AA-08, AA-09
- existing issues: none named

## Decisions recorded

- **339 architecture (Strategic HITL, recorded here rather than blocking).** The gate needs an async
  lookup and the two decorators (`@CurrentScope`, `@CurrentActor`) are synchronous. A request-scoped
  guard that resolves the header once into `request.acting` is the smallest change that keeps both
  decorators. Default assumed: recommended; no new framework.
- **AA-06** — auto-open a ZM's unavailability window from a >24 h login gap? Default assumed: not
  built; windows are opened by OH/CSM from Settings in this slice.

## Downstream

341 (acting scope on write doors) depends on this and 340 (plan §3).
