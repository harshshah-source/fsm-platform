# 362 — User administration completion + reference-read hardening
Status: ready-for-agent
Type: AFK
Wave: 4 · Severity: P2 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

- `PATCH org/users/:userId {status}` exists (`org/users.controller.ts:29-35`) but the admin client
  and the Settings Users section expose no disable control (`api/org.ts:105-112`,
  `sections.tsx:513-545`).
- No route changes a user's role or zone — `users.service.ts` has `list` / `create` / `setStatus`
  only.
- `org/geography.controller.ts:9-12` is readable by every authenticated role.

Account creation and passwords are out of scope (#91).

## Current code

- `apps/backend/src/org/users.controller.ts:29-35` — status PATCH only.
- `apps/backend/src/org/users.service.ts` — `list` / `create` / `setStatus`; no `update`.
- `apps/backend/src/org/geography.controller.ts:9-12` — no role guard.
- `apps/admin/src/api/org.ts:105-112` — no status / update client.
- `apps/admin/src/pages/settings/sections.tsx:513-545` — Users rows, read-only.

## What to build

- `users.controller.ts`, `users.service.ts` — `update({role?, zoneId?})`, audited; on role or
  zone change revoke the user's refresh tokens via `auth/prisma-refresh-token-store.ts`; refuse to
  demote (or disable) the last active OH.
- `api/org.ts` — `setUserStatus`, `updateUser`.
- `pages/settings/sections.tsx` Users rows — Disable/Enable control; Edit role/zone modal.
- `geography.controller.ts` — `RoleGuard` limited to manager roles.
- Tests: `org-users`, `org-geography` e2e; `settings.test.tsx`.

## Acceptance criteria
- [ ] AC1 — OH can disable/enable a user and change their role/zone from Settings.
- [ ] AC2 — a changed user's sessions are revoked.
- [ ] AC3 — the last active OH cannot be disabled or demoted.
- [ ] AC4 — geography reads refuse SE and WM.

## Verification

`org-users` e2e (update, revocation, last-OH refusal), `org-geography` e2e (SE/WM → 403),
`settings.test.tsx` for the Users controls.

## UI surfaces

Admin: Settings → Users section (modified).

## Reference

`docs/ui/desktop/v2-reference/26-settings.png`

## Blocked by
— (none)

## Absorbs / supersedes
- survey ids: AC-06, AC-07, AC-09.
- existing issues: none (account creation / passwords remain on #91).
