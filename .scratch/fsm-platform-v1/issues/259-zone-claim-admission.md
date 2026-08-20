# 259 — Zone-claim admission: DB-backed per-zone dispatch claims, partial multi-zone outcomes

Status: ready-for-agent
Type: AFK · Backend + Admin
Decision: #258 Q8.3/Q8.4/Q8.5 (G2, G5-half, G6, G7)

## Objective

Run admission becomes **per-zone and database-authoritative**: a busy zone is a contention outcome
for that zone only, refusals carry the holder cross-process and across restarts, and a multi-zone
run proceeds on every free zone instead of failing globally.

## Current behaviour

- Admission authority is an in-process `Map` (`dispatch-run.service.ts:121-163`) — dies on restart,
  invisible to a second instance.
- **Global refusal**: `if (conflicts.length > 0) return CONFLICT` (`:157`) — one held zone refuses
  the entire requested set. A zone-scoped rebalance run in flight at 05:00:00 cancels the whole
  national cron run (see #260 for the no-retry half).
- `dispatch_run_zones` rows are written only at zone *completion* (`zoneRow`, `:346-381`); a refused
  request leaves no trace by design.
- `GET /schedules/dispatch-run/in-flight` reads the in-memory map (`schedules.controller.ts:168`).

## Required change

1. **Claim = the zone ledger row, opened at admission.** Create the `dispatch_run_zones` row when a
   zone is *admitted*, `status = RUNNING`, finalize it to `DONE`/`ERROR` where `zoneRow` writes
   today. Refused zones get a `CONTENDED` row on the refused run naming the holder run id.
2. **Partial unique** `ux_dispatch_run_zones_one_running_per_zone ON dispatch_run_zones(zone_id)
   WHERE status = 'RUNNING'` (raw SQL, same posture as the #100 backstops). Admission = insert;
   a unique violation = read the holder row and report it. This is the cross-process, restart-proof
   replacement for the map (which loses its authority; it may be deleted or kept as pure UX cache).
3. **Per-zone admission loop**: admit zone-by-zone; process admitted zones exactly as today; record
   contended zones as `CONTENDED(holderRunId, holderTrigger, holderActor, holderStartedAt)`.
4. **Response shape — stated explicitly, because a `dispatch_run_zones` row CANNOT exist without its
   parent `dispatch_runs` row** (`DispatchRunZone.runId`, `schema.prisma:826`). Two cases, no third:
   - **Every requested zone is already held** → **409** `DISPATCH_ALREADY_RUNNING` with holder info,
     **no `dispatch_runs` row, no zone rows**. This preserves #213's existing no-trace refusal
     semantics: a run that never happened leaves no history.
   - **At least one requested zone is free** → open the `dispatch_runs` row, claim and dispatch the
     free zones, and write `CONTENDED` zone rows for the held ones on that run. Run finalizes
     PARTIAL when any zone was contended.
5. `in-flight` endpoint reads RUNNING claim rows (works across instances/restarts).

## Existing code to reuse

`DispatchRunService.runForActiveZones/execute/zoneRow` (restructure, don't rewrite);
`DispatchInFlight` shape; `describeDispatchConflict`; the #100 partial-unique migration idiom
(`20260708120000_dispatch_idempotency_backstops`); transparency query already renders zone rows.

## Data model

- `dispatch_run_zones.status` TEXT (`RUNNING | DONE | ERROR | CONTENDED`) — new column, backfill
  existing rows to `DONE`/`ERROR` from `error IS NULL`.
- Holder linkage: `contended_with_run_id BIGINT NULL`.
- Partial unique above. `finishedAt` becomes nullable while RUNNING.

## API

`POST /schedules/dispatch-run` — response gains `zones[].outcome`; 409 semantics preserved for the
fully-held single-zone case. `GET /schedules/dispatch-run/in-flight` — same shape, DB-sourced.

## UI surfaces

Admin: Dispatch run detail (zone card shows CONTENDED with holder); Batch Schedules "Run dispatch"
button disabled-state now DB-truthful. Mobile: n/a.

## Reference

`docs/ui/desktop/v2-reference/` batch-schedules/transparency pages (no layout change — new zone
outcome label only).

## Acceptance criteria

- [ ] Two concurrent single-zone runs, same zone: exactly one dispatches; the other receives 409
      naming the holder (trigger, actor, startedAt) — proven with the claim held by a *different
      connection* (not the in-process map).
- [ ] Multi-zone run with one zone held: held zone → CONTENDED row; all other zones dispatch; run
      finalizes PARTIAL; ledger sums still reconcile per #123's invariant.
- [ ] Two zone-scoped runs on disjoint zones run concurrently, two ledger rows, no interference.
- [ ] Restart with a RUNNING claim row: `in-flight` still reports it (release is #261's reaper).
- [ ] **All-held case**: request whose every zone is held → 409, and **zero** rows written to
      `dispatch_runs` AND `dispatch_run_zones` (asserted by row counts before/after, not by absence
      of an error).
- [ ] **Partial case**: at least one free zone → exactly one `dispatch_runs` row, DONE rows for the
      dispatched zones, CONTENDED rows for the held ones, run status PARTIAL.

## Tests

e2e: concurrent-admission spec (two live connections), multi-zone-partial spec, in-flight-across-
restart spec (new Nest app instance against same DB); update `dispatch-concurrent`,
`dispatch-in-flight-guard` specs to the DB-backed contract.

## Dependencies / Blocked by

None (first implementation issue of #258). #260 and #261 build on it.

## Risks

Claim rows change `dispatch_run_zones` cardinality (CONTENDED rows on refused runs) — transparency
reads must not double-count; the reconcile-by-construction invariant must be re-asserted.

## Rollback

Column + index are additive; reverting to map-admission is a code revert, rows remain valid history.
