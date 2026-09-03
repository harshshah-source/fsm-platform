# 344 — Admin notification bell + tray
Status: ready-for-agent
Type: AFK
Wave: 1 · Severity: P2 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

`components/shell/TopBar.tsx:212-218` renders a bell with no handler and no state;
`apps/admin/src/api/` has no notifications client. Managers hold real unread in-app rows
(cross-zone escalations, `INTRADAY_ESCALATION_REQUIRED`) they can never see. The backend
list / read / read-all endpoints already work (`notifications.controller.ts:22-40`).

## Current code

- `apps/admin/src/components/shell/TopBar.tsx:212-218` — bell rendered, no handler, no state
- `apps/admin/src/api/` — no notifications client
- `notifications.controller.ts:22-40` — list, mark-read, mark-all-read exist (optional `?since=`
  from #165)

## What to build

- New `apps/admin/src/api/notifications.ts`
- `TopBar.tsx` — unread badge; tray opens on click
- New `components/shell/NotificationTray.tsx` — list, mark-read, mark-all; deep link per type →
  `/cross-zone`, `/intraday`, `/tickets/:id`
- Poll every 60 s
- Tests: `apps/admin/test/topbar-notifications.test.tsx`
- Backend unchanged

## Acceptance criteria

- [ ] AC1 — badge shows the unread count
- [ ] AC2 — tray lists the newest 50 with a type label and relative time
- [ ] AC3 — click marks read and navigates
- [ ] AC4 — mark-all works
- [ ] AC5 — works for every admin role

## Verification

Admin component tests with a mocked client.

## UI surfaces

- Admin: top bar — bell badge (modified)
- Admin: notification tray (new)

## Reference

- Top bar as drawn on `docs/ui/desktop/v2-reference/01-dashboard-zonal-manager.png`

## Blocked by

— (none)

## Absorbs / supersedes

- survey ids: NOTIF-08, INTRA-G2
- existing issues: none named
