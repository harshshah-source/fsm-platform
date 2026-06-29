# 87 — M8c: SE Availability — SOFT_UNAVAILABLE flag (mobile)

Status: ready-for-agent
Type: AFK · Mobile

## What to build

The SE self-service Availability screen (PRD Flow 11): set a SOFT_UNAVAILABLE flag with a from/to time
window over the built Issue 25 backend. During the window the SE is excluded from intra-day candidate
scoring; at `to_ts` availability auto-reverts to AVAILABLE (server-side).

## Business rules (authority)

- PRD §611 Flow 11 (SOFT_UNAVAILABLE with from/to; excluded from Intra-day Re-plan candidate scoring
  during the window; ZM notified; auto-revert at `to_ts`). ADR-0010 (time-windowed availability).

## Acceptance criteria

- [ ] SE sets SOFT_UNAVAILABLE with a from/to window → `POST /api/engineers/:seId/availability`
- [ ] Current availability state + active window shown
- [ ] Auto-revert at `to_ts` is server-owned (the screen just reflects it; no client timer)

## API contract (authority: backend on `main`)

- `POST /api/engineers/:seId/availability` —
  `@Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'SERVICE_ENGINEER')` → **SE self-serve is allowed**
  (`:seId` = self). Body `{ status, windowStart?, windowEnd? }`; `status` ∈ `SETTABLE_STATUSES`
  (includes SOFT_UNAVAILABLE) (`engineers/engineers.controller.ts`).
- `GET /api/engineers/:seId` (own) → current availability for display.

## Validation & error codes

- `INVALID_AVAILABILITY_STATUS` (400), `SE_NOT_FOUND` (404).

## Permissions

- SE may set their **own** availability only (`:seId` must resolve to the caller server-side).

## Navigation

- Set success → Availability screen reflecting the active window.

## Offline behaviour

- Set queues via #17 when offline; the active state reads from cache until sync.

## Edge cases & failures

- Invalid status → `INVALID_AVAILABILITY_STATUS`. The SE never sets another SE's availability.

## UI surfaces

- **Mobile:** Availability screen (SOFT_UNAVAILABLE flag). Owned by this issue.
- **Admin:** n/a (manager availability controls are Issue 25).

## Reference

- PRD §611 (no dedicated mobile screenshot — composed from the kit).

## Tests (TDD targets — red first)

- SE sets SOFT_UNAVAILABLE with a window → 200; invalid status → `INVALID_AVAILABILITY_STATUS`.
- The screen reflects auto-revert at `to_ts` (server-driven; no client timer asserted).

## Blocked by

- #54, #25
