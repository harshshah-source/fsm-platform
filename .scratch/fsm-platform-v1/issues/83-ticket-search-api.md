# 83 — Ticket Search API (QR / manual lookup)

Status: ready-for-agent
Type: AFK · Backend

## Business purpose

The SE QR Scanner (Issue 20) opens the active Ticket for a scanned vehicle/device. It needs a backend
lookup that resolves a `vehicle_no` or `device_id` to its active eligible Ticket(s). Entry shortcut
only — read path, never a mutation.

## PRD references

- §623 Flow 13 (QR Scanner — "backend searches active eligible Tickets by `vehicle_no` or `device_id`";
  no match → "No active ticket found"; multiple → disambiguation list; manual text-entry fallback).
- §498 (QR Scanner screen — no state changes).

## Workflow references

- `fsm-business-technical-workflow.md` — eligible/active ticket definition (reuse the existing
  device-state / ticket eligibility model; do not introduce a new notion of "active").

## API specification

- `GET /api/tickets/search?vehicleNo=<v>` or `?deviceId=<d>` →
  `{ matches: [{ ticketId, vehicleId, deviceId, plantId, workType, slaBucket, status }] }`
  (fields mirror `TicketView`). 0 matches → `{ matches: [] }`; >1 → all returned for client disambiguation.
- Read-only; no side effects.

## Acceptance criteria

- [ ] `vehicleNo` / `deviceId` resolves to the active eligible Ticket(s)
- [ ] 0 matches → empty list (client shows "No active ticket found")
- [ ] >1 active Ticket for one vehicle → all returned (client disambiguates)
- [ ] Only ACTIVE eligible tickets returned (reuse existing eligibility — no new rule)
- [ ] RBAC: SERVICE_ENGINEER; results scoped to the SE's coverage (never tickets outside coverage)

## Validation & error codes

- `SEARCH_TERM_REQUIRED` (neither param) (400).

## Permissions

- SERVICE_ENGINEER; coverage-scoped exactly like the Shared Pool (Issue 12) — never out-of-coverage tickets.

## Dependencies

- #05/#07 (tickets + device state), #12 (coverage scoping). Consumed by #20.

## Test plan (TDD)

- single active match returns one row; none → empty; multi-device vehicle → multiple rows.
- a ticket outside the SE's coverage is never returned.
- missing search term → `SEARCH_TERM_REQUIRED`.

## TDD implementation notes

- Pure read over existing tables; reuse the coverage filter. Start with the empty/single/multi cases red.

## Blocked by

- #07, #12
