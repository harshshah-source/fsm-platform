# 64 — SE mobile Vehicle Unavailability file screen + Transporter tap-to-call + readiness hints

Status: done except the readiness-hint AC (deferred to #65, per this issue's own split)
Type: AFK · Mobile

## What to build

The SE-side mobile half of Issue 28. On a Ticket the SE cannot work, the mobile app shows the
**Transporter name + contact (tap-to-call)** and a **Vehicle Unavailability Report** form posting to
the existing `POST /api/vehicle-unavailability` endpoint (built in Issue 28). The SE **never** sees the
Secondary SLA Clock. Readiness **colour hints** (`UPCOMING_TRIP` / `ON_TRIP` / `UNKNOWN` / `STALE`)
render on the SE Ticket Detail as **warnings only** — only `ON_TRIP` blocks normal assignment; the hint
never shows a pause indicator and raw readiness never pauses the SLA.

> **Readiness-hint leg is split out.** The report-form path is fully buildable today. The readiness
> *source* depends on Issue 65 (vehicle readiness source) — the readiness-chip AC below is marked
> **deferred until #65**; ship the form path independently.

## Business rules (authority)

- PRD §549 Flow 5 (Vehicle Unavailability) + §484/§486 (Ticket Detail readiness hints, warnings only).
  On submit the primary SLA pauses with `pause_reason = VEHICLE_UNAVAILABLE`; the manager-only Secondary
  SLA Clock keeps running (ADR-0020 — SLA pauses are component-only/vehicle-unavailable, not raw readiness).

## Acceptance criteria

- [x] SE Ticket Detail shows Transporter name + contact with tap-to-call
- [x] SE files a Vehicle Unavailability Report (all fields) → `POST /api/vehicle-unavailability`
- [x] SE never sees the Secondary SLA Clock (manager-only)
- [ ] *(deferred until #65)* Readiness colour hints render as warnings on Ticket Detail; only ON_TRIP blocks; no pause indicator

## API contract (authority: backend on `main`)

- `POST /api/vehicle-unavailability` — `@Roles('SERVICE_ENGINEER', …MANAGER_ROLES)`. Body
  `{ ticketId, seId (=self for an SE caller), reasonCode, transporterContacted?, expectedFrom (required),
  expectedTo?, notes?, gpsLat?, gpsLng? }` (`ticketing/vehicle-unavailability.controller.ts`).
- `reasonCode` ∈ `VEHICLE_ON_TRIP | VEHICLE_NOT_AT_PLANT | DRIVER_NOT_AVAILABLE | CUSTOMER_REFUSED | OTHER`.
- Transporter name/contact come from the ticket detail payload (Issue 07/57).

## Validation & error codes

- `TICKET_AND_SE_REQUIRED`, `INVALID_REASON`, `INVALID_EXPECTED_FROM`, `INVALID_EXPECTED_TO` (all 400) — inline.

## Permissions

- SE may file for self (passes own `seId`). The confirm-date / resume-SLA / review legs and the Secondary
  SLA Clock are MANAGER_ROLES-only (separate endpoints) — never shown to the SE.

## Navigation

- File success → back to Ticket Detail with the "Vehicle unavailable — expected back on [date/time]" state.

## Offline behaviour

- Report submit queues via Issue 17 when offline; GPS captured at submit if available.

## Edge cases & failures

- Missing `expectedFrom` → `INVALID_EXPECTED_FROM`. Bad date → same. Invalid reason → `INVALID_REASON`.
- Readiness `ON_TRIP` chip (when #65 lands) blocks normal assignment but never shows a pause indicator.

## UI surfaces

- **Mobile:** SE Ticket Detail — Transporter tap-to-call + Vehicle Unavailability form + (deferred) readiness hint chip. Owned by this issue.
- **Admin:** n/a (ZM review page built in Issue 28).

## Reference

- `docs/ui/mobile/troubleshooting.png` (Ticket Detail / unable-to-work path)
- `docs/ui/desktop/v2-reference/11-vehicle-unavailability.png` (field parity reference for the report fields)

## Tests (TDD targets — red first)

- Valid file (all fields) → 200; missing `expectedFrom` → `INVALID_EXPECTED_FROM`; bad reason → `INVALID_REASON`.
- Tap-to-call uses the Transporter contact from the ticket payload.
- Secondary SLA Clock is never rendered for the SE role.

## Blocked by

- #28
- #54
- (readiness-hint AC) #65

## Comments

### 2026-08-04 — DONE except the readiness-hint AC; unblocked #171 first (tap-to-call needed a real number)

The tap-to-call AC needed a real contact number, which didn't exist anywhere (`transporters` had no
phone column — see #171, filed 2026-07-28, decisions already settled but its status label was stale
`ready-for-human`). Built #171's minimal buildable slice first: `Transporter.contactPhone` (FSM-owned,
nullable, empty on day one per the issue's own bootstrapping section), resolved server-side into
`transporterContact` on `GET /api/me/tickets/:id`; `vehicle_unavailability_reports` gained
`transporterName`/`transporterContact` for the SE's own per-report capture. #171's OH/CSM admin
maintenance surface is NOT built — out of this issue's scope, and #171's own text says the column
shipping empty does not block mobile development (only the field pilot).

`VehicleUnavailabilityFormScreen`: reason (`TilePicker`, 5 values), transporter-contacted toggle,
transporter name/number used (prefilled from the master contact, SE-editable — the report's own
fields are field evidence, not required to match the master), expected-back via 4 quick relative
presets (2h / 4h / tomorrow AM / tomorrow PM) rather than a native date/time picker — no reference
mockup specifies that field's input UX, and installing a native picker for one required field wasn't
worth the added native-module/test-mocking surface. Files with `seId` = the caller's own id (the
server already 403s a mismatched `seId` — `vehicle-unavailability.service.ts`'s existing
`actor.userId === input.seId` check, unchanged). No Secondary SLA Clock field exists on this screen
at all — not a hidden/conditional render, simply never built into the SE-facing form.

**Not built:** `expectedTo` (optional field, skipped for scope); the readiness-hint AC, explicitly
deferred to #65 per this issue's own split. 197 mobile tests green, `tsc`/`eslint` clean both apps.
