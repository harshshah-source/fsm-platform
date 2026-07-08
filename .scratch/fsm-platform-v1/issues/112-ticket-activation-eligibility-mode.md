# 112 — Activate the ticket half: eligibility mode + pipeline chaining

Status: done (2026-07-07 — both slices + acceptance landed, see report at bottom)
Depends on: 05, 97
Refs: `docs/architecture/backend-engineering-review-2026-07-05.md` (A8, B7),
`docs/audits/2026-07-07-production-validation-audit.md` (Finding 2, tickets = 0),
`docs/HANDOFF-autoplant-ingestion-2026-07-07.md` §4.3, remediation plan R1 cadence row `ticket-create`.

## Problem

The 2026-07-07 production validation ran the full pipeline against live AutoPlant data and produced
**zero tickets, by construction**. Two independent causes, both diagnosed in the 07-05 engineering
review and re-confirmed by the 07-07 audits:

1. **The pipeline ends one stage early (review A8).** `IntegrationSyncService.ingestTelemetry` /
   `runPipeline` chain master-sync → snapshot ingest → device-state recompute and stop.
   `TicketCreationService.createForInactiveEligible` (`src/ticketing/ticket-creation.service.ts:27`)
   has **no non-test caller** — the entire acting half (tickets → recommender → dispatch) is dark.
2. **The eligibility gate is structurally false (review B7).** `eligible_for_uptime` requires a PGI
   within 15 days, but `pgi_history` has **no feed** (SAP integration unbuilt) — so all 18,204
   devices are ineligible and `createForInactiveEligible` would select zero candidates even if wired.

B7's decision framing: build the SAP feed (weeks) / bulk-seed PGI (interim data fudge) / an
**eligibility-mode setting** so the gate runs permissive until the feed exists. This issue implements
the third option — it is a *mechanism*, keeps the canonical PGI rule as the default, and makes the
interim proxy an explicit, audited, reversible Ops setting instead of an invented value in code.

## Changes

### Slice A — `eligibility_mode` system setting, honored by the recompute

- `src/settings/settings.service.ts` `SETTINGS_DEFAULTS`: add
  `eligibility_mode: 'pgi'` — description documents the two values:
  - `'pgi'` (default, canonical CONTEXT.md rule): active PGI within `DEFAULT_PGI_WINDOW_DAYS` (15).
  - `'all-deployed'` (interim proxy, R2/B7): the device's current vehicle fitment has deployment
    status `ACTIVE`/`DEPLOYED` (mirrored verbatim from AutoPlant onto `vehicles.status` by master
    sync). No fitment / null status ⇒ ineligible. PGI is not consulted.
- `src/device-state/eligibility.ts`: export `EligibilityMode` union +
  `parseEligibilityMode(value: unknown): EligibilityMode` (junk/unset ⇒ `'pgi'` — the gate never
  silently widens on a bad setting).
- `src/device-state/device-state.service.ts` `recompute()`: read the setting; branch the
  `eligible_for_uptime` SQL fragment on mode. The **Non-Op exclusion applies in BOTH modes**
  (a CONFIRMED/ACTIVE `non_operational_markings` row short-circuits ineligible — that rule is not
  interim).
- Tests (e2e, follows `test/device-state-eligibility.e2e-spec.ts` idiom):
  - mode `all-deployed`: device on a `DEPLOYED` vehicle with **no PGI** → eligible;
    device with no current fitment → ineligible; vehicle status `UNDEPLOYED`/null → ineligible;
    Non-Op device on a deployed vehicle → ineligible.
  - mode `pgi` (and unset/junk value): existing behavior byte-identical (existing suite is the
    regression net).

### Slice B — chain ticket creation into the pipeline

- `src/ingestion/autoplant/integration-sync.service.ts`: inject `TicketCreationService`; after
  `deviceState.recompute()` in **both** `ingestTelemetry()` and `runPipeline()`, call
  `createForInactiveEligible()`; log the created count; extend `TelemetryTickResult` /
  `PipelineSummary` with `tickets: { created: number }`.
- `src/ingestion/ingestion.module.ts`: import `TicketingModule` (no cycle — Ticketing imports only
  Prisma + Audit).
- The existing single-in-flight/overlap semantics are untouched: ticket creation is idempotent by
  the `has_open_failure_cycle` filter + invariant I1 partial-unique, so a re-run or overlapping
  manual pipeline is safe (same posture as recompute).
- Tests: unit test on `IntegrationSyncService` with fakes asserting ticket-create runs **after**
  recompute on both paths and its count propagates; update the sync-API e2e response shape.

### Docs / tracker

- INDEX.md: replace the "acting half — flagged, not filed" note with this issue.
- This file records the activation runbook (below).

## Activation runbook (Ops, not code — the default changes nothing)

1. Flip the setting (audited): `PUT /api/settings/eligibility_mode` → `"all-deployed"`.
2. Next telemetry tick (or `POST /api/integration/run-pipeline`) recomputes eligibility fleet-wide
   and creates TROUBLESHOOT tickets for inactive+eligible devices with a plant/company fitment.
3. Revert to `"pgi"` the day the SAP PGI feed lands — no deploy needed either way.

**Expected first-run volume (declare to Ops before flipping):** at the 07-07 validation snapshot,
~5,015 inactive devices; minus UNZONED-plant devices still get tickets (tickets scope by plant, not
zone-mapping) — expect a one-time burst of roughly that magnitude, then steady-state trickle. No
per-run cap is implemented — a cap would silently defer SLA clocks; if Ops wants staging, stage via
the zone-mapping queue instead. The per-candidate repeat-detection `findFirst` is a known bounded
N+1 (remediation plan follow-up note) — acceptable for the burst, revisit only if slow logs say so.

## Explicitly out of scope (owned elsewhere)

- #108 business-sweep scheduler (verification / intraday timeouts / aggregations).
- Recommender + dispatch activation — needs real SE/coverage data (Ops exercise) and #100.
- The real SAP PGI feed (B7 option 1) and `pgi_history` bulk seed (option 2).
- UNZONED zone completeness (R6 operational queue / `docs/audits/unzoned-plants-2026-07-07.md`).

## Completion report (2026-07-07, TDD red→green per slice)

**Slice A** — RED `test/device-state-eligibility-mode.e2e-spec.ts` (eligible case + registry default
failed against HEAD) → GREEN: `eligibility.ts` gained `EligibilityMode`/`parseEligibilityMode`
(junk ⇒ `pgi`), `SETTINGS_DEFAULTS.eligibility_mode = 'pgi'`, `DeviceStateService.recompute` branches
the `eligible_for_uptime` base fragment on the setting (`COALESCE(v.status IN ('ACTIVE','DEPLOYED'),
false)` in all-deployed; Non-Op `NOT EXISTS` unconditional). 5/5 new + existing
`device-state-eligibility` / `device-state-recompute` suites unchanged-green.

**Slice B** — RED `test/integration-sync-tickets.e2e-spec.ts` (no `tickets` in either result) →
GREEN: `IntegrationSyncService` takes `TicketCreationService`, chains it after recompute in
`ingestTelemetry()` + `runPipeline()`, logs + returns `tickets: { created }`;
`IngestionModule` imports `TicketingModule` (AppModule DI boot proven by
`integration-sync-api.e2e-spec`). Pre-existing direct constructions in `telemetry-tick` /
`integration-scheduler` specs updated with a fake (skipped tick asserts no ticket half-work).

**Acceptance** — `test/ticket-activation.e2e-spec.ts`: silent 30h device on a DEPLOYED vehicle,
empty `pgi_history`, mode `all-deployed` → recompute → `createForInactiveEligible` → one OPEN
TROUBLESHOOT ticket with denormalised plant/tier. Green.

Gates: `npm run build` (tsc) clean; targeted regression green (settings ×3, dual-write,
fleet-uptime report+aggregation, dashboard zone-overview/critical-queue, repeat-failure,
ticket-creation + gate). Full-suite run deliberately skipped (known OOM on this box — targeted only).
