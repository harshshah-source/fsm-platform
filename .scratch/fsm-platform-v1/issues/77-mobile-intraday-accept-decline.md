# 77 — SE mobile intra-day CRITICAL insertion Accept/Decline + ghost-assignment toast

Status: ready-for-agent
Type: AFK · Mobile

## What to build

The SE-facing mobile surfaces for the intra-day CRITICAL/HIGH_CRITICAL insertion flow (Issues 29/30).
The backend is built and green (`/api/intraday-insertions`): the full-screen / notification-shade
**Accept / Decline** prompt, the `CRITICAL INSERTION` Day-Plan badge on an accepted ticket, and the
one-time **ghost-assignment toast** when an offered insertion timed out while the SE was offline.

## Business rules (authority)

- PRD §541 Flow 4 (Accept → "Accepted. WhatsApp Confirmation sent." + ticket at top of Day Plan;
  Decline → mandatory reason picker → system reroutes; offline/no-response within 10 min → on reconnect
  the ghost-assignment notice). §489 (Intra-day Insertion Screen). ADR-0016 (SE-Acceptance WhatsApp).

## Acceptance criteria

- [ ] Full-screen / shade Accept/Decline prompt renders for a PENDING insertion offered to this SE
- [ ] Accept posts to `/api/intraday-insertions/:id/accept`; accepted ticket appears at top of Day Plan badged `CRITICAL INSERTION`
- [ ] Decline opens the mandatory reason picker and posts to `/api/intraday-insertions/:id/decline`
- [ ] Ghost-assignment toast shown once on reconnect when the offer was already rerouted (no action needed)

## API contract (authority: backend on `main`, `@Roles('SERVICE_ENGINEER')`)

- `POST /api/intraday-insertions/:id/accept` — no body. Errors: `INSERTION_NOT_FOUND` (404),
  `NOT_OFFERED_TO_YOU` (409), `INSERTION_NOT_PENDING { status }` (409).
- `POST /api/intraday-insertions/:id/decline` — body `{ reasonCode }`,
  `reasonCode` ∈ `AT_CAPACITY | TRAVEL_TOO_FAR | VEHICLE_TROUBLE | OTHER`
  (`DECLINE_REASON_CODES`). Errors: `REASON_REQUIRED` (400), `INVALID_REASON`.
- Accepted ticket renders at top of `/api/schedules/me` (server orders it `insertAtTop`).
- Ghost state: a `GET /api/intraday-insertions` row in a timed-out/rerouted status surfaced to the offered SE.

## Validation & error codes

- `NOT_OFFERED_TO_YOU` / `INSERTION_NOT_PENDING` → close the prompt + inform (already resolved elsewhere).
- Decline without a reason → `REASON_REQUIRED`; bad reason → `INVALID_REASON`.

## Permissions

- SERVICE_ENGINEER only; an SE can accept/decline only an insertion offered to them.

## Navigation

- Accept → Day Plan (new ticket at top). Decline → back to Day Plan. Toast → no navigation.

## Offline behaviour

- The Accept/Decline action requires connectivity (it competes for an offer). If the SE was offline
  past the 10-min `ACCEPTANCE_TIMEOUT_MIN`, the offer is gone → show the ghost toast on reconnect.

## Edge cases & failures

- WhatsApp confirmation copy is a side-effect of accept (first-class SE_ACCEPTANCE) — the toast text
  is "Accepted. WhatsApp Confirmation sent." Decline reroute is server-side.

## UI surfaces

- **Mobile:** Accept/Decline prompt + `CRITICAL INSERTION` badge + ghost toast. Owned by this issue.
- **Admin:** n/a (manager-side insertion/escalation are Issues 29/30/31).

## Reference

- `docs/ui/mobile/home-dashboard.png` (Day Plan / badge context); copy per PRD §541.

## Tests (TDD targets — red first)

- Accept posts to `/accept`; accepted ticket renders top-of-plan badged.
- Decline without reason → `REASON_REQUIRED`; with a valid enum → posts + reroute.
- `NOT_OFFERED_TO_YOU` / `INSERTION_NOT_PENDING` close the prompt gracefully.
- Timed-out offer → ghost toast shown once.

## Blocked by

- #54 (Mobile Foundation)
- #29, #30 (done — backend + endpoints)
- (push delivery of the offer) #89 / #76
