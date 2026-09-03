# 343 — Audit writers: leave, planner, ingestion triggers, voucher export, settings from/to, VU pause/resume

**Done 2026-09-03.** Wave 1 of the module-gaps completion plan (`docs/module-gaps/IMPLEMENTATION-PLAN.md`
§4), absorbing survey ids ENG-G1, ENG-G2, ING-05, VCH-09, AC-04(a), TKT-01. Red-first. Built on the
finished acting chain — #339 (the gate), #340 (attribution), #341 (acting narrows the door) — and read
back by #342, which is not a build dependency.

## What it closes

Six write paths changed dispatch, money or the SLA clock and left the ledger unable to say who did it:

| Path | Before | Now |
| --- | --- | --- |
| Leave approve | one `SE_AVAILABILITY_SET` row with no link to the request | `LEAVE_APPROVED` on `leave_requests`, carrying the availability window it created |
| Leave reject | **nothing at all** | `LEAVE_REJECTED`, carrying the mandatory reason |
| Planner set / remove | unaudited | `PLANNER_ENTRY_SET` / `PLANNER_ENTRY_REMOVED` on the cell |
| `POST /integration/sync-masters` | unaudited | `MANUAL_SYNC_TRIGGERED` |
| `POST /integration/run-pipeline` | unaudited | `PIPELINE_RUN_TRIGGERED`, with the clamped chunk size |
| `POST /snapshots/run` | unaudited | `SNAPSHOT_RUN_TRIGGERED`, keyed on the run it started |
| `GET /vouchers/export` | unaudited | `VOUCHER_EXPORT_DOWNLOADED`, keyed on the month |
| `PUT /settings/:key` | `SETTING_UPDATED` with no values | `+ metadata:{key, previous, next}` |
| VU file (SLA pause) | unaudited | `VU_SLA_PAUSED` on the ticket |
| VU manual resume | unaudited | `VU_SLA_RESUMED_MANUAL` on the report |

Every row goes through `AuditService.withAudit` (in the same transaction as the write) or, where there
is no mutation to ride along with, `AuditService.record` — the standalone form of the same insert. No
second audit shape was invented, and every controller hands the service `@CurrentActor()`, so an
acted-as write is attributed to the duty it was made under rather than to the caller's own role.

## Where the issue's premise was wrong

Three corrections, all minor, all built against reality:

1. **The task's file list named `exports/exports.controller.ts` for the voucher export.** That file
   already audits (`EXPORT_DOWNLOADED`, the entity-mapping CSV) and has nothing to do with vouchers.
   The unaudited export is `GET /api/vouchers/export`, dispatched from `vouchers.controller.ts` — that
   is where the row is written, in the same shape `ExportsController` established.
2. **The task's file list named only `planner/se-planner.controller.ts`.** The planner writes live in
   `se-planner.service.ts` (as the issue file itself says), and AC1 requires the row to be in the same
   transaction as the write, which the controller cannot do. The service is edited; see *shared leaves*
   below. The controller change is the `@CurrentActor()` the delete leg was missing.
3. **The plan named `integration-health-api` as the ingestion trigger spec.** That spec covers
   `GET /integration/health`. The triggers are covered by `integration-sync-api.e2e-spec.ts`, which is
   where the new cases went.

Everything else in the issue matched the working tree, including the `SETTING_UPDATED` gap and both VU
legs.

## Decisions worth keeping

**`entity_type` is written in this repo three ways (`'ticket'`, `'tickets'`, `'TICKET'`) and both
readers normalise.** The dominant form by a wide margin is the **snake_case table name**
(`tickets`, `users`, `zones`, `system_settings`, `se_availability`, `expense_vouchers`,
`vehicle_unavailability_reports`), so every new writer here uses it: `leave_requests`, `se_planner`,
`snapshot_runs`, `integration_pipeline`, `expense_vouchers`, `system_settings`, `tickets`,
`vehicle_unavailability_reports`. **No backfill was started** — that is the known follow-up this slice
deliberately does not own.

**A planner audit row is keyed on the cell (`se:plant:date`), not on `se_planner.id`.** A cell that is
planned, removed and planned again gets a fresh autoincrement each time; keying on the id would
scatter one cell's history across as many entities as it had lives, and the question the row exists to
answer is "what happened to *this* cell". The composite entity id has precedent —
`engineer-admin.service.ts` keys `se_coverage` on `${seId}:${plantId}`.

**A refused ingestion trigger writes nothing.** Both AutoPlant triggers 503 when AutoPlant is
unconfigured. The audit row is written after that gate: a ledger that records attempts as well as
actions stops meaning "this ran", which is the same loss as not auditing at all. Pinned by a test.

**The two AutoPlant triggers are audited *before* the pipeline runs; the snapshot run *after*.** Not an
inconsistency — a different entity in each case. `run-pipeline` can take minutes and can throw halfway,
and the run an operator comes looking for is precisely the one that did not finish, so "who started
this" must survive it; there is no run row to key on before the fact, so the entity is the pipeline
door itself. `POST /snapshots/run` resolves with a run id and a status even when the run fails, so its
row keys on `snapshot_runs/<id>` and joins "who asked" to "what it did" without a timestamp guess.

**Two rows carry a fact only their transaction knows.** `VU_SLA_PAUSED` records `slaPaused`, and
`VU_SLA_RESUMED_MANUAL` records `slaResumed`. Neither is bookkeeping: filing a VU report on a cycle
already stopped for a component wait does **not** re-stamp the pause (#247's guard, deliberate and
unchanged), and a manual resume resolves the report without restarting the clock when the pause was not
its own. A row that always claimed the clock moved would be worse than no row, because it would be
believed. `withAudit` inserts the audit row *after* the work function returns and reads its `metadata`
at that moment, so the object is filled in inside the transaction — that ordering is the guarantee
`withAudit` exists to provide, and both fields are asserted in the e2e so a refactor that snapshots
metadata early fails loudly.

**`VU_SLA_PAUSED` is keyed on the ticket, not the report.** The report does not exist until inside the
transaction, and "when did this ticket's clock stop and start again" is the question the row is read
for — one entity, the whole pause history. The report id is on the row's metadata.

**Settings `previous` is threaded from the read `set()` already did**, not re-read in the writer: it is
the same row the lock verdict was taken on, so the audit row and the permission decision cannot
disagree about what was there. `previous: null` means the key had no value at all — deliberately
distinct from a previous value of `0` or `false`.

**Scope and actor stayed separate on the two VU legs that only had scope.** `file` and `resume` now
take `@CurrentActor()` *in addition to* `@CurrentScope()`, and the actor contributes only
`actedAsRole` / `actingZone`. Spreading the actor's `zoneId` over the scope would have quietly widened
a write door #341 narrowed — an attribution fix must not move a permission.

**Three routes left the `acting-scope-route-sweep` allowlist.** `IntegrationSyncController.runPipeline`
/ `syncMasters` and `SnapshotsController.run` now inject `@CurrentActor()`, and that sweep's own rule is
that an allowlist entry which is in fact scoped must be deleted rather than left to hide a later
un-scoping. They are still pan-India OH-only jobs that narrow to no zone; the reason is kept as a
comment where the entries were.

## Shared leaves touched (called out per the parallel-round rules)

- `planner/planner.module.ts` and `ingestion/ingestion.module.ts` — one `AuditModule` import each, so
  `AuditService` resolves in those contexts. Nothing else in either module changed.
- `planner/se-planner.service.ts` — outside the task's file list but named by the issue, and the only
  place an in-transaction planner audit row can be written. No other in-flight slice touches planner.
- `test/acting-scope-route-sweep.spec.ts` — the three allowlist entries above, as the sweep demands.

Both services that gained an `AuditService` parameter (`LeaveRequestService`, `SePlannerService`) took
it **defaulted**, matching `LeaveRequestService`'s existing idiom for `availability`. Nest injects the
module singleton, so the default is dead at runtime; it exists so that the four specs constructing
these services directly — one of which (`se-unavailable-stranded-work`) belongs to another in-flight
slice — keep compiling without being edited.

## What was tested, and why in that shape

Every path is asserted through HTTP, against the row that actually landed — not against a spy. An
audit row's whole value is that it is durable and readable later, so a test that proves the service
*called* an auditor proves the wrong thing.

Each assertion checks the tuple an operator reconstructs from: action, entity, actor role, and the
metadata that makes the row explain itself. Three cases exist only to pin a *silence*: the 503 trigger
writes nothing, `previous` is `null` on a first setting write (not absent, not `0`), and the two VU
rows say whether the clock actually moved.

The ingestion triggers cannot reach a configured AutoPlant in test, so that spec's second block
replaces exactly two collaborators — the client's `isConfigured()` gate and the sync service whose
pipeline would otherwise take minutes — and asserts the controller's audit contract. The pipeline
itself has its own specs and is not re-tested here.

## Acceptance criteria

- **AC1 — one audit row per action, in the same transaction as the write, with the named metadata.**
  Met. Leave, planner and both VU legs write through `withAudit`; the three triggers and the voucher
  export have no mutation to enlist in and use `record`, the same insert without a wrapped mutation.
- **AC2 — leave reject carries the reason.** Met (`LEAVE_REJECTED.metadata.reason`), and on the row as
  well as in `decision_reason`: the column is overwritten if the request is decided again, the row is
  not.
- **AC3 — settings rows carry previous and next.** Met (`metadata:{key, previous, next}`).

## Tests, verbatim

Target specs, second (green) run:

```
 ✓ test/voucher-controller.e2e-spec.ts (9 tests) 2028ms
 ✓ test/snapshots-api.e2e-spec.ts (18 tests) 2704ms
 ✓ test/leave-request-controller.e2e-spec.ts (8 tests) 1434ms
 ✓ test/vehicle-unavailability-controller.e2e-spec.ts (7 tests) 2809ms
 ✓ test/integration-sync-api.e2e-spec.ts (4 tests) 1059ms
 ✓ test/se-planner-controller.e2e-spec.ts (4 tests) 1369ms
 ✓ test/settings-write.e2e-spec.ts (4 tests) 923ms

 Test Files  7 passed (7)
      Tests  54 passed (54)
```

The same seven files on the first (red) run: `Test Files 7 failed (7) · Tests 7 failed | 47 passed (54)`
— one failure per new assertion, none from a boot error.

Regression sweep over everything that touches the changed files:

```
 Test Files  15 passed | 2 failed (17)      → after fixing the route-sweep allowlist:
 ✓ test/acting-scope-route-sweep.spec.ts (6 tests)
 ✓ test/acting-scope-write-doors.e2e-spec.ts (4 tests)
 ✓ test/global-guard-validation.e2e-spec.ts (8 tests)
 Test Files  3 passed (3) · Tests 18 passed (18)

 ✓ acting-attribution-pin · acting-attribution · request-actor-attribution · audit-trail-controller
 ✓ audit-ledger-search · voucher-service · me-vouchers-controller · snapshot-run-lifecycle
 ✓ integration-scheduler
 Test Files  9 passed (9) · Tests 62 passed (62)
```

The one remaining red in that sweep — `se-unavailable-stranded-work.e2e-spec.ts`,
`rows.find is not a function` — is **#356's**: it changed `IntradayInsertionService.listForScope` to
return a page object. Not touched here.

`npx tsc --noEmit` reports no error in any file this slice owns; the errors it does report are in
`intraday/`, `me-tickets/`, `scheduling/intraday-updates`, `ticketing/recovery` and `verification/` —
all working-tree state belonging to #353, #356 and #360.

## Follow-ups this slice does not own

- **`entity_type` normalisation.** Three spellings across the existing writers, both readers
  normalising. New writers here pick the dominant form; a backfill is a separate, deliberate pass.
- **Making these rows readable.** #342 owns the ledger surface; until it lands the rows exist and are
  queryable only in SQL.
- **Leave integrity (revoke, tie-break, overlap guard).** #363, which depends on this slice.
