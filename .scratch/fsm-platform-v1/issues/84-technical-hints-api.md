# 84 — Technical Hints API (derived telemetry signals)

Status: landed
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

- [x] Hints derived from the latest snapshot per the §641 table exactly
- [x] Card source = the single highest-severity hint; detail source = all hints
- [x] Raw telemetry field set (§662) returned with the snapshot `dataAsOf`
- [x] Missing snapshot → `available=false`, empty hints, null raw ("Telemetry unavailable")
- [x] Hints never alter ticket state, SLA, assignment, scoring, verification, or closure

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

### 2026-08-03 — landed

Built as **option 1** from this issue's own API spec: extended the existing `GET /api/me/tickets/:id`
payload (`MeTicketDetailView.technicalHealth`, #161/#07's read) rather than a new
`GET /api/tickets/:id/technical` route — this reuses that endpoint's already-correct
`SeCoverageService`-based RBAC scope with no new predicate. Also added `topHint` to the
`GET /api/me/tickets` list row (`MeTicketRow.topHint`) per AC #2's card-source requirement; both
surfaces call the same pure derivation so they can never disagree.

**New files:**
- `apps/backend/src/me-tickets/technical-hints.ts` — the pure §641 derivation
  (`deriveTechnicalHints`, `pickTopHint`, `buildTechnicalHealth`). No DB/ORM dependency.
- `apps/backend/test/technical-hints.spec.ts` — 17 unit tests (no DB): one per §641 condition +
  boundary cases, multi-anomaly/top-hint determinism, `available:false`, `Prisma.Decimal` input.

**Changed files:**
- `apps/backend/src/me-tickets/me-ticket-detail.service.ts` — `MeTicketDetailView.technicalHealth:
  TechnicalHealth`, computed via a new private `technicalHealth(deviceId)` (`rawDeviceSnapshot.
  findFirst` ordered by `gpsDatetime desc`, the existing index).
- `apps/backend/src/me-tickets/me-tickets-query.service.ts` — `MeTicketRow.topHint: TechnicalHint |
  null`, computed via a new private `topHintsByDevice(deviceIds)` (deduplicated by device, one
  `findFirst` per distinct device on the page).
- `apps/backend/test/me-ticket-detail-controller.e2e-spec.ts` — 3 new e2e tests: missing-snapshot
  `available:false`, multi-anomaly full-hints + raw-telemetry + `dataAsOf`, and a read-only assertion
  (ticket/TicketEvent/SoftState rows unchanged by the GET).
- `apps/backend/test/me-tickets-controller.e2e-spec.ts` — 2 new e2e tests: `topHint` null with no
  snapshot, `topHint` = the single highest-severity hint with a multi-anomaly snapshot.

**Code vocabulary (frozen per #169's request — do not rename without updating there), severity
descending:**

| code | severity | label |
|---|---|---|
| `NO_MAIN_POWER` | 8 | "No main power — check fuse" |
| `NOT_ON_NETWORK` | 7 | "Not on network" |
| `GPS_INVALID` | 6 | "GPS signal invalid" |
| `NO_GPS_FIX` | 5 | "No GPS fix" |
| `LOW_VOLTAGE` | 4 | "Low voltage" |
| `WEAK_GSM` | 3 | "Weak GSM signal" |
| `IGNITION_OFF` | 2 | "Ignition off" |
| `VEHICLE_IN_MOTION` | 1 | "Vehicle in motion" |

**Severity-ranking rationale:** conditions meaning the device may be producing NO further usable
telemetry at all (no power, not on network, GPS unreliable/no-fix) block diagnosis entirely and
outrank conditions that are just informational context about a device still reporting (ignition,
motion). Within that top tier, total power loss outranks a comms/GPS problem (unpowered = nothing
can be reasoned about; briefly off-network/no-fix may self-recover). Low voltage / weak GSM are
degraded-but-still-working warnings, ranked between the two tiers. All eight conditions are evaluated
independently (not `else if`) — a snapshot can fire several at once; `deriveTechnicalHints` returns
them severity-descending so "all hints" and "the top hint" (`pickTopHint`, effectively `hints[0]`)
can never disagree between the list and detail surfaces.

**Ambiguous-string literal judgment calls** (nothing in the current ingestion path produces these
fields — see `ingestion/autoplant/mapping.ts:152-161`, all hardcoded `null` today — so these are
best-effort literals for whenever ingestion is later enriched, or for a fixture that sets the field
directly):
- `gpsValidity` — case-insensitive equality to `"invalid"` (PRD's own literal, case-folded).
- `gpsMode` "no fix" — case-insensitive equality to the literal `"no fix"`.
- `creg` / `cgreg` "not registered" — case-insensitive equality to the literal `"not registered"`
  (either field alone is sufficient). Deliberately NOT matching AutoPlant/3GPP's numeric CREG/CGREG
  codes (e.g. `0`/`3`) — the source column is a free `String?` with no confirmed real value yet, and
  a numeric-code mapping would be a new threshold this issue's own "no new thresholds" rule forbids.
- `ignitionStatus` "off" — case-insensitive equality to the literal `"off"` (AutoPlant's
  `IGNITION_STATUS` column is documented free text, likely `"ON"`/`"OFF"`).

**Scope note:** the earlier 2026-07-28 comment above also mentions a "Device not reporting since 42h"
staleness chip on 4 screens — that is NOT one of the 8 §641 conditions in this issue's corrected spec
and was intentionally NOT built here (it would be a new, uncited threshold). If a staleness hint is
wanted it needs its own PRD citation and is a candidate follow-up, not silently folded into this
derivation.

**Verification:** `pnpm --filter backend exec tsc --noEmit` clean. Full `pnpm --filter backend test`
suite run — see the session commit for the final pass/fail counts (`voucher-controller.e2e-spec.ts`
has the pre-existing, already-filed #187 fixture bug, unrelated to this work).
