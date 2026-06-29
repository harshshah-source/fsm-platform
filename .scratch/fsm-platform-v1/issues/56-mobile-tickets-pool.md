# 56 — M2: Tickets / Day-Plan / Shared Pool (mobile)

Status: ready-for-agent
Type: AFK · Mobile

## What to build

The SE Tickets tab: the assigned Day-Plan ticket list (Issue 11 `/api/schedules/me`) and a separate
Shared Pool list (Issue 12 `/api/me/shared-pool`), with priority/SLA visual treatment matching the
mockup. List rows open Ticket Detail (M3).

## Business rules (authority)

- PRD §503 Flow 1 + §497 (Shared Pool — always-visible secondary list for the SE's covered plants,
  shown alongside Assigned Work; never shows tickets outside coverage; no pick/reject action on the pool).

## Acceptance criteria

- [ ] Assigned Day-Plan list rendered from `/api/schedules/me`, ordered/badged per mockup
- [ ] Shared Pool list rendered from `/api/me/shared-pool`, visually separate from Assigned
- [ ] Row tap opens Ticket Detail (M3)

## API contract (authority: backend on `main`)

- `GET /api/schedules/me` → `DayPlanView` (see Issue 55 — stops carry `{ ticketId, sortOrder }` per plant).
- `GET /api/me/shared-pool` → `SharedPoolTicket[]` (`shared-pool.controller.ts`). Read-only list.

## Permissions

- Both SE-only, server-scoped to the caller. The pool is read-only — no Reject/claim action.

## Navigation

- Row tap → Ticket Detail (Issue 57 / M3), passing `ticketId`.

## Offline behaviour

- Lists render from cached `/schedules/me` + `/shared-pool` when offline, with an offline indicator.

## Edge cases & failures

- Empty assigned list (pre-dispatch) → empty state distinct from empty pool.
- A ticket present in both assigned and pool is shown only under Assigned (Assigned takes precedence).

## UI surfaces

- **Mobile:** Tickets tab (list + pool). Owned by this issue.
- **Admin:** n/a.

## Reference

- `docs/ui/mobile/tickets-priority-view.png.png`

## Tests (TDD targets — red first)

- Assigned list renders ticket rows in `sortOrder`, badged; pool list renders separately.
- Row tap navigates to M3 with the correct `ticketId`.
- Empty assigned vs empty pool render distinct states.

## Blocked by

- #54, #07, #11, #12
