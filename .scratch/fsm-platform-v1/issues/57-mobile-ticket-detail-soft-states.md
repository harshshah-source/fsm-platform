# 57 — M3: Ticket Detail (ready + verification-pending) + soft-state actions

Status: ready-for-agent
Type: AFK

## What to build

The mobile Ticket Detail screen in both states (ready, verification-pending) plus the soft-state
action flow (Issue 15 `/soft-state`): VIEWED → ON_SITE → Start, with the geofence prompt at ON_SITE
(200 m default per the soft-state/geofence model). Consumes Issue 07 ticket data and Issue 18
verification status.

## Acceptance criteria

- [ ] Ticket Detail renders the "ready" state from `/api/tickets/:id`
- [ ] Ticket Detail renders the "verification-pending" state
- [ ] Soft-state actions (VIEWED / ON_SITE / Start) post to `/soft-state`; one active state per ticket
- [ ] ON_SITE triggers the geofence prompt/capture

## UI surfaces

- **Mobile:** Ticket Detail (both states) + soft-state action bar. Owned by this issue.
- **Admin:** n/a.

## Reference

- `docs/ui/mobile/ticket-detail-ready.png.png`
- `docs/ui/mobile/ticket-detail-verification-pending.png.png`

## Blocked by

- #54, #07, #15, #18
