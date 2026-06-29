# 57 — M3: Ticket Detail (ready + verification-pending) + soft-state actions

Status: ready-for-agent
Type: AFK · Mobile

## What to build

The mobile Ticket Detail screen in both states (ready, verification-pending) plus the soft-state
action flow (Issue 15): VIEWED → ON_SITE → TROUBLESHOOT_STARTED. Consumes Issue 07 ticket data and
Issue 18 verification status.

> **Geofence is server-side (resolves the prior "200 m" ambiguity).** The mobile only captures and
> sends `location: {lat,lng}` on the ON_SITE tap; the **server** stamps `onsiteSource = AUTO_GEOFENCE`
> when the point is within the plant radius (config default 200 m, `DEFAULT_GEOFENCE_RADIUS_M` in
> `soft-state.service.ts`) else `MANUAL`. The client never computes the radius. (CONTEXT §339/§401.)

## Business rules (authority)

- PRD §513 Flow 2 steps 1–3; CONTEXT §339 (ON_SITE auto/manual), §401 (Presence — multi-signal; no
  separate "I am at the vehicle" screen).

## Acceptance criteria

- [ ] Ticket Detail renders the "ready" state from `/api/tickets/:id`
- [ ] Ticket Detail renders the "verification-pending" state (from `/api/tickets/:id/verification`)
- [ ] Soft-state actions (VIEWED / ON_SITE / TROUBLESHOOT_STARTED) post to `/api/tickets/:id/soft-state`; one active state per ticket per SE
- [ ] ON_SITE sends captured `location` when available; the server decides AUTO_GEOFENCE vs MANUAL
- [ ] When location is off/unavailable, the SE taps Mark ON_SITE (server records MANUAL); no client geofence math

## API contract (authority: backend on `main`)

- `GET /api/tickets/:id` → `TicketDetailView { ticketId, workType, status, failureCycleId, deviceId,
  vehicleId, plantId, companyId, companyTier, assignmentState, slaBucket, repeatFailure,
  failureCycleState, componentRequestStatus, waitingComponentSince, createdAt, lastStateChangedAt }` +
  lifecycle events (`ticketing/ticket-query.service.ts`).
- `GET /api/tickets/:id/verification` → outcome/phase/pings/partialDeadline (`verification/verification-query.service.ts`).
- `POST /api/tickets/:id/soft-state` — body `{ target: 'VIEWED'|'ON_SITE'|'TROUBLESHOOT_STARTED',
  location?: { lat:number, lng:number } }`; response `{ result, softState:{ softStateId, ticketId, seId,
  type, onsiteSource, setAt, timeoutAt, resolvedAt } }` (`soft-state/soft-state.controller.ts`).

## Validation & error codes

- 409 `INVALID_SOFT_STATE_TRANSITION { from, to }` → toast + refresh; action bar enables only the next legal target.
- Idempotent re-tap of the current state returns the existing state (no error).

## Permissions

- Soft-state is SERVICE_ENGINEER only; server scopes to the caller's own id.

## Navigation

- Start Troubleshooting (after TROUBLESHOOT_STARTED) → Troubleshoot form (Issue 58 / M4).

## Offline behaviour

- Ticket read renders from cache when offline. Soft-state writes queue via Issue 17 (`client`-side
  ordering preserved); the geofence decision is still the server's on replay.

## Edge cases & failures

- Location OFF / capture failure → omit `location`; show Mark ON_SITE fallback.
- Out-of-order tap → 409 handled as above.
- Verification-pending state shows the pending treatment (no outcome yet).

## UI surfaces

- **Mobile:** Ticket Detail (both states) + soft-state action bar. Owned by this issue.
- **Admin:** n/a.

## Reference

- `docs/ui/mobile/ticket-detail-ready.png.png`
- `docs/ui/mobile/ticket-detail-verification-pending.png.png`

## Tests (TDD targets — red first)

- VIEWED→ON_SITE→TROUBLESHOOT_STARTED posts the correct `target` each step.
- ON_SITE with a location sends `{lat,lng}`; without sends none (Mark ON_SITE path).
- 409 `INVALID_SOFT_STATE_TRANSITION` renders the recovery toast; re-tap is idempotent.
- Ready vs verification-pending render distinct states.

## Blocked by

- #54, #07, #15, #18
