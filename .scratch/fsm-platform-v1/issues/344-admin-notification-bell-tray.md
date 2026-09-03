# 344 — Admin notification bell + tray
Status: done 2026-09-03 — report docs/progress/344-admin-notification-bell-tray.md
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
  - **Corrected 2026-09-03:** `?since=` does **not** exist. #165 is still `ready-for-agent`; the
    controller takes no `since`, `limit` or cursor. The default page is 50
    (`notification.service.ts:91`) and `unreadCount` counts the whole mailbox, so AC1/AC2 hold with
    no parameter. Everything else in this issue matched the tree.

## What to build

- New `apps/admin/src/api/notifications.ts`
- `TopBar.tsx` — unread badge; tray opens on click
- New `components/shell/NotificationTray.tsx` — list, mark-read, mark-all; deep link per type →
  `/cross-zone`, `/intraday`, `/tickets/:id`
- Poll every 60 s
- Tests: `apps/admin/test/topbar-notifications.test.tsx`
- Backend unchanged

## Acceptance criteria

- [x] AC1 — badge shows the unread count (mailbox-wide, not `items.length`; hidden at zero, capped `99+`)
- [x] AC2 — tray lists the newest 50 with a type label and relative time
- [x] AC3 — click marks read and navigates (`/intraday`, `/cross-zone`, `/tickets/:id`)
- [x] AC4 — mark-all works
- [x] AC5 — works for every admin role (a role that cannot open a queue is linked to the ticket instead)

## Verification

Admin component tests with a mocked client.

Done: `apps/admin/test/topbar-notifications.test.tsx` (27) + `apps/admin/test/notifications-client.test.ts`
(6) — 33 tests, red first. `npx tsc -b` (admin) exit 0. Backend unchanged.

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
