# 56 — M2: Tickets / Day-Plan / Shared Pool (mobile)

Status: ready-for-agent
Type: AFK

## What to build

The SE Tickets tab: the assigned Day-Plan ticket list (Issue 11 `/api/schedules/me`) and a separate
Shared Pool list (Issue 12 `/api/me/shared-pool`), with priority/SLA visual treatment matching the
mockup. List rows open Ticket Detail (M3).

## Acceptance criteria

- [ ] Assigned Day-Plan list rendered from `/api/schedules/me`, ordered/badged per mockup
- [ ] Shared Pool list rendered from `/api/me/shared-pool`, visually separate from Assigned
- [ ] Row tap opens Ticket Detail (M3)

## UI surfaces

- **Mobile:** Tickets tab (list + pool). Owned by this issue.
- **Admin:** n/a.

## Reference

- `docs/ui/mobile/tickets-priority-view.png.png`

## Blocked by

- #54, #07, #11, #12
