# Progress — Issue 28: Vehicle Unavailability Report + dual SLA clocks + readiness

> Build date: 2026-06-25 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **ACCEPTED (core)** — Vehicle Unavailability Report + dual SLA clocks + ZM review built
> end-to-end (backend + admin). Readiness-conflict resolution (AC#6) + readiness-hint render (AC#5
> UI) deferred to follow-ups **64/65** with a flagged **authority conflict** (see below).
> Backend **+1 model / migration `20260624220000_add_vehicle_unavailability` / +2 e2e files**; admin
> **+1 page / +1 api client / +1 test**. Backend `tsc` clean + **463/463** e2e; admin `tsc` clean +
> **72/72**.

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | SE files Vehicle Unavailability Report with all fields; Transporter tap-to-call shown | 🟢 backend / 🟡 mobile | `VehicleUnavailabilityService.fileReport` + `POST /api/vehicle-unavailability` (SE + managers). All fields persisted (`reason_code`, `transporter_contacted`, `expected_from/to`, `notes`, `gps_lat/lng`). Mobile SE screen + Transporter tap-to-call → **Issue 64** (blocked-by Mobile Foundation #54). |
| 2 | Submit pauses primary SLA `pause_reason = VEHICLE_UNAVAILABLE`; Ticket resurfaces at expected date | 🟢 pause / 🟡 resurface | Filing pauses the Failure Cycle SLA (`slaPaused/slaPauseReason=VEHICLE_UNAVAILABLE/slaPausedAt/slaPauseSource`), only if not already paused. `expected_from` is stored and shown to the ZM. **Recommender-side "resurface at expected date" is a seam** — the Recommender currently hardcodes vehicle readiness `UNKNOWN` (`recommender.service.ts:111`); wiring expected-date resurfacing belongs with the readiness source → **Issue 65**. |
| 3 | Secondary SLA Clock (never pauses) visible only to ZM/CSM/OH, never the SE | 🟢 | `listForZone` derives BOTH clocks from the cycle (`secondary = now − opened_at`; `primary = secondary − accumulated − currentPause`). Surfaced only on the **manager-gated** `GET /api/vehicle-unavailability` (SE → 403) and the manager-gated admin page. e2e asserts SE 403 + `primary < secondary`. |
| 4 | ZM can edit/confirm expected-availability date or manually resume SLA | 🟢 | `confirmDate` + `resumeSla` (accumulates paused seconds, resolves the report). Zone-scoped manager auth (`isManagerForTicket`). Admin page Confirm-date + Resume-SLA actions. |
| 5 | Readiness hints render as warnings; only ON_TRIP blocks assignment; raw readiness never pauses SLA | 🟢 blocking / 🟡 render | **Blocking leg already satisfied** in the Recommender Hard Filter: `ON_TRIP → VEHICLE_ON_TRIP` drop; `STALE`/`UNKNOWN` deliberately NOT dropped (`hard-filters.ts:41`). Raw readiness never pauses SLA (pause is only via a filed VU report). **Hint *render*** on SE Ticket Detail (colour warnings) → **Issue 64/65** (needs the readiness source + ticket UI). |
| 6 | Readiness conflicts (UNKNOWN / STALE / WAITING_CONFIRMATION) resolvable by ZM | 🔴 **blocked** | Requires (a) a **vehicle-readiness data source** (AutoPlant LR-Date / Next-Trip ingestion — external-integration seam; readiness is hardcoded `UNKNOWN` today) and (b) resolves an **authority conflict** (below). Owned by **Issue 65**; **STOP flagged for HITL**. |

## Slice-by-slice RED→GREEN report

- **Slice 1 — schema (pre-session, committed-pending).** `VehicleUnavailabilityReport` model + `VehicleUnavailReason` (VEHICLE_ON_TRIP / VEHICLE_NOT_AT_PLANT / DRIVER_NOT_AVAILABLE / CUSTOMER_REFUSED / OTHER) + `VehicleUnavailStatus` (OPEN / RESOLVED); migration `20260624220000_add_vehicle_unavailability`; `Ticket.vehicleUnavailabilityReports` back-relation.
- **Slice 2 — service.** `fileReport` (auth: own-SE or manager; pauses SLA), `listForZone` (dual clocks, ZM zone-scoped), `confirmDate`, `resumeSla` (resume + resolve). 5 e2e (`vehicle-unavailability-service.e2e-spec.ts`) — GREEN.
- **Slice 3 — HTTP.** `VehicleUnavailabilityController` (`/api/vehicle-unavailability`): `POST` file (SE + managers, 400 on bad reason/date), `GET` list (managers; SE 403), `POST :id/confirm-date`, `POST :id/resume-sla`. 4 e2e (`vehicle-unavailability-controller.e2e-spec.ts`) — GREEN.
- **Slice 4 — admin UI (this session).** `VehicleUnavailabilityPage` (`/readiness/vehicle-unavailability`, v2-reference/11-vehicle-unavailability): metric strip + table with REPORT / TICKET / VEHICLE&PLANT / REASON / FILED-BY / EXPECTED-DATE / **PRIMARY SLA** + **SECONDARY SLA** / STATUS + ZM actions (Confirm-date, Resume-SLA); `vehicleUnavailability.ts` api client; RoleRoute-gated to manager roles + nav link. 3 tests (`vehicle-unavailability.test.tsx`) — GREEN. RED captured (missing-module resolve failure) before implementing.

## Deviations / decisions (read before extending)

1. **Secondary clock is manager-only by surface, not by field.** Both clocks are computed in `listForZone`; the SE never reaches them because the only read endpoint is manager-gated (SE → 403). No separate SE projection exists — matches CONTEXT ("renders only for ZM / CSM / Operations Head — never the SE").
2. **SLA pause is idempotent w.r.t. an existing pause.** Filing pauses only if the cycle is not already paused (e.g. already WAITING_COMPONENT), so a VU report never clobbers another pause reason. Resume accumulates the paused span into `slaAccumulatedPauseSeconds`.
3. **`resolvedBy` UUID guard.** `resumeSla` stores `resolvedBy` only when the actor id is a 36-char UUID (dev tokens like `'zm'` store null role-only) — keeps the FK/`@db.Uuid` column clean in tests/dev.
4. **Vehicle readiness stays a seam.** The Recommender still scores with `vehicleReadiness: 'UNKNOWN'` (`recommender.service.ts:111`). The readiness data source (AutoPlant LR-Date / Next-Trip) is the external-integration seam — AC#5 render + AC#6 resolution + AC#2 expected-date resurfacing all depend on it → **Issue 65**.

## Parity-gate disposition (CLAUDE.md / workflow.md)

- **Admin surface built** in-issue: ZM Vehicle Unavailability Review page (net-new, v2-reference/11). Both SLA clocks rendered; Confirm-date + Resume-SLA actions; manager-gated nav + route.
- **Mobile surface** (SE file-report screen + Transporter tap-to-call + readiness hints): **Issue 64**, `blocked-by #54` (Mobile Foundation). Tracked, not silently deferred.
- **ZM Readiness Conflicts page** (ref `10-readiness.png`) + AC#6 resolution: **Issue 65**, `blocked-by #28 + #04` (AutoPlant readiness source). Tracked.
- The Issue 28 spec file lacked `## UI surfaces` / `## Reference`; the authoritative images exist
  (`11-vehicle-unavailability.png`, `10-readiness.png`) and are recorded here + on the follow-ups.

## Authority conflict (AC#6) — RESOLVED (HITL, 2026-06-25)

**AC#6** listed `WAITING_CONFIRMATION` as a readiness-conflict state "resolvable by ZM", implying a
**per-ticket confirmation gate** — contradicting **CONTEXT.md → Hard Filter** (`STALE`/`UNKNOWN`
resolved "via ON_SITE capture or a **Vehicle Unavailability Report**, **not a per-Ticket confirmation
gate**"); `WAITING_CONFIRMATION` is also absent from the `VehicleReadiness` enum
(`READY | ON_TRIP | STALE | UNKNOWN`, `hard-filters.ts:16`).

**Decision: field path (CONTEXT-aligned).** Drop `WAITING_CONFIRMATION`; **no** new readiness state,
**no** enum/CONTEXT change. The ZM resolves `STALE`/`UNKNOWN` via the existing field path (ON_SITE
capture or a filed VU report); the Readiness page is signal/visibility, not a gate. Carried into
**Issue 65** (now `ready-for-agent`, AutoPlant readiness-source is the external seam). No shipped code
changed — the existing `VehicleReadiness` model and Hard Filter already match this decision.

## Follow-ups (filed)

- **Issue 64** — SE mobile Vehicle Unavailability file screen + Transporter tap-to-call + readiness hints → 28, 54.
- **Issue 65** — Vehicle readiness source (AutoPlant LR-Date/Next-Trip) + ZM Readiness Conflicts page + AC#6 resolution → 28, 04 (carries the authority-conflict note above).

## How to run / verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run \
  test/vehicle-unavailability-service.e2e-spec.ts test/vehicle-unavailability-controller.e2e-spec.ts \
  test/schedules-route-conflicts.e2e-spec.ts
cd apps/admin && node node_modules/vitest/vitest.mjs run test/vehicle-unavailability.test.tsx
```
