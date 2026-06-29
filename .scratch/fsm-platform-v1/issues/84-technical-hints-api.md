# 84 — Technical Hints API (derived telemetry signals)

Status: ready-for-agent
Type: AFK · Backend

## Business purpose

The SE Ticket Detail shows **Technical Hints** — advisory diagnostic signals derived at API time from
the latest snapshot telemetry — plus the full raw telemetry field set. Purely informational: hints
never affect lifecycle, SLA, assignment, Recommender scoring, verification, or closure. This issue owns
the backend derivation + read that Issue 20 renders.

## PRD references

- §641 Flow 14 (the complete condition→hint table + raw-telemetry field set + "Telemetry unavailable"):
  `MAINS_STATUS=off` → "No main power — check fuse"; `MAINS_VOLTAGE<10V` → "Low voltage";
  `CSQ≤9` → "Weak GSM signal"; `GPS_VALIDITY=invalid` → "GPS signal invalid"; `GPS_MODE=no fix` →
  "No GPS fix"; `CREG/CGREG=not registered` → "Not on network"; `Ignition=OFF` → "Ignition off";
  `Speed>5km/h` → "Vehicle in motion". Highest-severity only on the card; all hints + raw fields on detail.
- §662 (raw telemetry field list), §824 (data-as-of timestamp carried with the snapshot).

## Workflow references

- §04 snapshot ingestion (the telemetry source). Hints are derived; nothing is stored as a lifecycle state.

## API specification

- Expose on the ticket detail payload (or `GET /api/tickets/:id/technical`) →
  `{ hints: [{ code, severity, label }], rawTelemetry: { … §662 fields … }, dataAsOf, available: boolean }`.
- `available=false` (no snapshot) → `hints: []`, `rawTelemetry: null` (client shows "Telemetry unavailable").
- Derivation table is verbatim from PRD §641 — no new thresholds invented.

## Acceptance criteria

- [ ] Hints derived from the latest snapshot per the §641 table exactly
- [ ] Card source = the single highest-severity hint; detail source = all hints
- [ ] Raw telemetry field set (§662) returned with the snapshot `dataAsOf`
- [ ] Missing snapshot → `available=false`, empty hints, null raw ("Telemetry unavailable")
- [ ] Hints never alter ticket state, SLA, assignment, scoring, verification, or closure

## Validation & error codes

- `TICKET_NOT_FOUND` (404). No mutation paths.

## Permissions

- Read for the SE on their own/covered tickets + manager roles (mirror ticket-detail read RBAC).

## Dependencies

- #04 (snapshot telemetry), #07 (ticket detail). Consumed by #20.

## Test plan (TDD)

- each §641 condition produces its exact hint; multi-anomaly card returns the highest severity.
- missing snapshot → `available=false`.
- a hint computation never writes ticket/SLA/assignment state (read-only assertion).

## TDD implementation notes

- Encode the §641 table as data; pure function over the latest snapshot row. Start with one
  condition→hint test red, then the severity ordering, then the unavailable case.

## Blocked by

- #04, #07
