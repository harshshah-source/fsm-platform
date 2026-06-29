# 85 — M8a: SE Notifications (in-app list)

Status: ready-for-agent
Type: AFK · Mobile

## What to build

The SE in-app Notifications list (PRD Screen Inventory) over the already-built notification spine
(Issue 03). Lists all SE-relevant events with read state; tapping a notification routes to its entity
(ticket / day plan / component request). Read surface — delivery channels are Issue 03/#76/#89.

## Business rules (authority)

- PRD §499 (Notifications — in-app list for all SE-relevant events), §211 (All Roles — Notifications &
  Audit), §725 (Notification Delivery: in-app always fires).

## Acceptance criteria

- [ ] Notification list rendered from `/api/notifications` with read/unread state
- [ ] Tapping a notification marks it read and routes to its entity
- [ ] "Mark all read" action wired
- [ ] Unread filter supported

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
