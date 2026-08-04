# 85 — M8a: SE Notifications (in-app list)

Status: done
Type: AFK · Mobile

## What to build

The SE in-app Notifications list (PRD Screen Inventory) over the already-built notification spine
(Issue 03). Lists all SE-relevant events with read state; tapping a notification routes to its entity
(ticket / day plan / component request). Read surface — delivery channels are Issue 03/#76/#89.

## Business rules (authority)

- PRD §499 (Notifications — in-app list for all SE-relevant events), §211 (All Roles — Notifications &
  Audit), §725 (Notification Delivery: in-app always fires).

## Acceptance criteria

- [x] Notification list rendered from `/api/notifications` with read/unread state
- [x] Tapping a notification marks it read and routes to its entity
- [x] "Mark all read" action wired
- [x] Unread filter supported

## API contract (authority: backend on `main`)

- `GET /api/notifications?unread=true|false` → `NotificationList { items: [{ id, type, title, body?,
  entityType?, entityId?, read, createdAt }] }` (`notifications/notification.service.ts`, `NotificationListItem`).
- `POST /api/notifications/:id/read` → `{ ok: true }`. `POST /api/notifications/read-all` → `{ updated }`.

## Validation & error codes

- `INVALID_NOTIFICATION_ID` (400, non-numeric id), `NOTIFICATION_NOT_FOUND` (404).

## Permissions

- Any authenticated user reads their own notifications; server-scoped to the caller.

## Navigation

- Tap → route to `entityType`/`entityId` (Ticket Detail, Day Plan, Component request, etc.).

## Offline behaviour

- List renders from cache when offline; read-state writes queue via #17.

## Edge cases & failures

- Empty list → empty state. Notification with no entity → tap only marks read (no navigation).

## UI surfaces

- **Mobile:** Notifications list. Owned by this issue.
- **Admin:** n/a (admin has its own notification surfaces).

## Reference

- PRD §499 (no dedicated mobile screenshot — list composed from the kit).

## Tests (TDD targets — red first)

- List renders items with read/unread; unread filter narrows the set.
- Tap marks read (`/:id/read`) and routes by entity; mark-all posts `/read-all`.
- Non-numeric id → `INVALID_NOTIFICATION_ID` handled.

## Blocked by

- #54, #03

## Comments

### 2026-08-04 — done

No stale contract found this time — `GET /api/notifications`, `POST /:id/read`, `POST /read-all`,
and both error codes (`INVALID_NOTIFICATION_ID` 400, `NOTIFICATION_NOT_FOUND` 404) all matched the
issue's own text exactly against current source (`notifications.controller.ts`).

**Entry point (not specified anywhere — PRD's own Reference line says "no dedicated mobile
screenshot"):** `SeTabShell` has exactly 5 tabs (Home/Tickets/Stock/Vouchers/Profile, #54's own scope)
and Notifications isn't one of them. Added a plain-text "Notifications" header button + unread-count
badge on `HomeScreen` (the PRD's own "primary entry point" framing), local-swap to
`NotificationsScreen` — the same navigation pattern used everywhere else in this codebase (no stack
navigator exists). A placement choice with zero data/business-rule risk (trivially movable later),
not treated as a stop-and-ask.

**Tap-routing scope:** the issue's text says "routes to its entity (ticket / day plan / component
request)". Grepped every live `notify()` call site in the backend
(`intraday-insertion.service.ts`, `cross-zone-escalation.service.ts`, `bulk-unassign.service.ts`) —
`entityType` is only ever `'ticket'`, `'zone'`, or `'zones'` today; the zone(s) notifications go to
managers, never an SE recipient. So `'ticket'` is the only entity type this screen will ever actually
see from a real notification — routes to `TicketDetailScreen` (local-swap, same pattern as
`TicketsScreen`'s row tap). "Day plan" and "component request" have no live producer to route from;
anything without a `'ticket'` entityType just marks read, per the issue's own documented edge case
("Notification with no entity → tap only marks read").

**Found and fixed in the same slice:** `apiMarkNotificationRead`/`apiMarkAllNotificationsRead` (added
during #77, before this issue's own explicit test target existed) always threw a generic
`UNAUTHORIZED` regardless of the real failure reason — fixed to parse and surface
`INVALID_NOTIFICATION_ID`/`NOTIFICATION_NOT_FOUND` verbatim, per this issue's own "Tests" section.

### 2026-08-04 — correction: "admin has its own notification surfaces" was an assumption, and it is false

This issue's UI-surfaces line reads *"**Admin:** n/a (admin has its own notification surfaces)"*. The
cross-surface contract audit (`audit/mobile-contract-sync-audit-2026-08-04.md`, finding D5) checked it:
**admin has no notification consumer of any kind.**

Verified 2026-08-04: a repo-wide grep for `notification` in `apps/admin/src` returns only comments. The
TopBar bell is a `<button>` with no `onClick` and no data source (`TopBar.tsx:130-136`); the
UI-redevelopment notes describe it as *"decorative, no behavior"* (`docs/ui-redevelopment/04-layout.md:51`),
and FE-02's bell AC was purely visual.

Scale of the gap: 15 distinct notification `type` strings are produced backend-side; exactly **one** is
consumed anywhere, and that one is mobile's ghost-assignment toast (`SeTabShell.tsx:50`). Every
manager-recipient notification — `INTRADAY_ESCALATION_REQUIRED`, the `CROSS_ZONE_*` family, and the ZM
`RECOVERY_UNABLE_TO_COLLECT` added by #76's 2026-08-04 slice — is written to the database and displayed
nowhere. `PRD:213` and the per-role event matrix at `workflow:1471-1483` specify in-app manager
notification explicitly, delivered as an Action Required panel plus a header badge (`PRD:99`, `:354`,
`:384`) — notably **not** as a notification-centre page, which the admin page inventory (`PRD:320-345`)
does not contain.

Nothing about this issue's own mobile scope changes. Recorded so the "n/a" line is not read as evidence
that the admin side was checked and found covered. Owned by
[#206](./206-admin-manager-action-surface.md).
