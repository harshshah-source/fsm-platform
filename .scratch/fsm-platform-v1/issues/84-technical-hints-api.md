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

## Comments

### 2026-07-28 — full scope from the reference images (freeze plan §1.1, F2.4)

This issue is larger than "derive hints" and is **freeze-list blocking**: it is the single biggest
block of missing payload on the SE surface.

**Nothing exists.** `grep technicalHint|TechnicalHint|technical_hint` across `apps/backend/src` and
`apps/admin/src` returns **zero hits**. The source table `raw_device_snapshots`
(`prisma/schema.prisma:1320-1348`) is written by ingestion and **read by nothing** — `grep
rawDeviceSnapshot` hits only generated Prisma and one comment
(`ingestion/autoplant/autoplant-source-reader.ts:35`). It is a write-only table.

**Two deliverables, not one:**

1. **The raw telemetry read.** `ticket-detail-ready.png` renders a "Technical Health" block of
   **13 named fields**, each mapping 1:1 to a snapshot column: `gpsValidity` (`:1329`), `mainsStatus`
   (`:1327`), `mainsVoltage` (`:1328`), `csq` (`:1335`), `creg` (`:1333`), `cgreg` (`:1334`),
   `ignitionStatus` (`:1331`), `unitNo`/IMEI (`:1339`), `deviceType` (`:1340`), `gpsDatetime`
   (`:1324`), `lat`/`lon` (`:1325-1326`), `ipAddress`/`portNo` (`:1336-1337`), `simSubscriberName`
   (`:1338`). PRD §660 additionally lists `gpsMode` (`:1330`) and `speed` (`:1332`). Plus the
   **"Telemetry unavailable" empty state** (PRD §660.3, CONTEXT:491) and a `dataAsOf`.
2. **The derived hints.** Chips appear on **4 screens** (Tickets list, both Ticket Detail states,
   Daily Status) with strings like "No main power — check fuse", "Not on network", "Device not
   reporting since 42h". Workflow:259 requires derivation **at API time** — server-side. Putting the
   thresholds (e.g. CSQ ≤ 9 → weak) in the client forks them from the future ZM view.

**Freeze-relevant:** the hint *vocabulary* is part of the frozen contract — a client that renders
chips must know the closed set, or receive display-ready strings. Decide which under **#169**.
