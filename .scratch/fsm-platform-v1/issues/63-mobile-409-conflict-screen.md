# 63 — SE mobile full-screen 409 (Ticket already closed) screen

Status: ready-for-agent
Type: AFK

## What to build

The SE mobile full-screen business-409 result (CONTEXT §Business 409 Conflict, Issue 24 AC#3). When a
troubleshoot submit returns HTTP 409 `TICKET_ALREADY_CLOSED`, the app shows a full-screen message:
"This Ticket was already closed by [SE] at [time]. Your consumed components have been logged as Shadow
Use and will be reconciled by the Warehouse." with **View Van Stock** / **Go Back** actions. Reads the
409 payload (`winnerSeId`, `winnerAt`, `shadowUseRecorded`) the backend already returns.

## Acceptance criteria

- [ ] On a 409 `TICKET_ALREADY_CLOSED` submit response, the full-screen conflict screen renders
- [ ] Copy shows the winning SE + time and whether Shadow Use was logged
- [ ] View Van Stock navigates to the Stock screen; Go Back returns to the Day Plan
- [ ] Idempotency duplicates (not 409) do not trigger this screen

## UI surfaces

- **Mobile:** full-screen 409 conflict result. Owned by this issue.
- **Admin:** n/a (the warehouse side is the Shadow Use Queue, Issue 24).

## Reference

- `docs/ui/mobile/ticket-detail-ready.png.png` (the submit context); 409 state copy per CONTEXT §Business 409 Conflict

## Blocked by

- #54
- #24
