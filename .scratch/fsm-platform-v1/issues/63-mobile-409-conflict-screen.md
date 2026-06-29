# 63 — SE mobile full-screen 409 (Ticket already closed) screen

Status: ready-for-agent
Type: AFK · Mobile

## What to build

The SE mobile full-screen business-409 result (CONTEXT §Business 409 Conflict, Issue 24 AC#3). When a
troubleshoot submit returns HTTP 409 `TICKET_ALREADY_CLOSED`, the app shows a full-screen message:
"This Ticket was already closed by [SE] at [time]. Your consumed components have been logged as Shadow
Use and will be reconciled by the Warehouse." with **View Van Stock** / **Go Back** actions. Reads the
409 payload (`winnerSeId`, `winnerAt`, `shadowUseRecorded`) the backend already returns.

## Business rules (authority)

- PRD §591 Flow 8 + CONTEXT §Business 409 Conflict. Van stock is decremented on the server regardless
  of the rejected submission; the loser's consumption is logged as Shadow Use for reconciliation.

## Acceptance criteria

- [ ] On a 409 `TICKET_ALREADY_CLOSED` submit response, the full-screen conflict screen renders
- [ ] Copy shows the winning SE + time and whether Shadow Use was logged
- [ ] View Van Stock navigates to the Stock screen; Go Back returns to the Day Plan
- [ ] Idempotency duplicates (not 409) do not trigger this screen

## API contract (authority: backend on `main`)

- Triggered by `POST /api/tickets/:id/troubleshoot` returning HTTP 409 with body
  `{ code: 'TICKET_ALREADY_CLOSED', winnerSeId, winnerAt, shadowUseRecorded }`.
- No new endpoint; this screen is a client response to the existing 409 payload.

## Validation & error codes

- ONLY HTTP 409 `TICKET_ALREADY_CLOSED` triggers this screen. A `client_submission_id` idempotency
  duplicate returns the existing submission (200) and must NOT render this screen.

## Permissions

- SE-only (it is the loser SE's submit response).

## Navigation

- View Van Stock → Stock tab (Issue 60). Go Back → Day Plan (Issue 56).

## Offline behaviour

- N/A for trigger (a 409 is an online server response). If the submit was queued offline, the 409 is
  surfaced when the queued item is rejected on sync (Issue 17 marks it FAILED → opens this screen).

## Edge cases & failures

- `shadowUseRecorded=false` → copy omits the Shadow-Use reconciliation line.

## UI surfaces

- **Mobile:** full-screen 409 conflict result. Owned by this issue.
- **Admin:** n/a (the warehouse side is the Shadow Use Queue, Issue 24).

## Reference

- `docs/ui/mobile/ticket-detail-ready.png.png` (the submit context); 409 state copy per CONTEXT §Business 409 Conflict

## Tests (TDD targets — red first)

- 409 `TICKET_ALREADY_CLOSED` renders the screen with winner SE/time + Shadow-Use line when `shadowUseRecorded`.
- 200 idempotency duplicate does NOT render the screen.
- View Van Stock / Go Back navigate correctly.

## Blocked by

- #54
- #24
- #58 (the troubleshoot submit whose 409 response this screen renders/routes from)
