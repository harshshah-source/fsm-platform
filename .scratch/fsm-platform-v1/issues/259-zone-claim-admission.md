# 259 — Zone-claim admission: DB-backed per-zone dispatch claims, partial multi-zone outcomes

Status: done (2026-08-21)
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

- [x] Two concurrent single-zone runs, same zone: exactly one dispatches; the other receives 409
      naming the holder (trigger, actor, startedAt) — proven with the claim held by a *different
      connection* (not the in-process map).
- [x] Multi-zone run with one zone held: held zone → CONTENDED row; all other zones dispatch; run
      finalizes PARTIAL; ledger sums still reconcile per #123's invariant.
- [x] Two zone-scoped runs on disjoint zones run concurrently, two ledger rows, no interference.
- [x] Restart with a RUNNING claim row: `in-flight` still reports it (release is #261's reaper).
- [x] **All-held case**: request whose every zone is held → 409, and **zero** rows written to
      `dispatch_runs` AND `dispatch_run_zones` (asserted by row counts before/after, not by absence
      of an error).
- [x] **Partial case**: at least one free zone → exactly one `dispatch_runs` row, DONE rows for the
      dispatched zones, CONTENDED rows for the held ones, run status PARTIAL.

All six proven in `apps/backend/test/dispatch-zone-claim-admission.e2e-spec.ts`, every assertion made
across two independently constructed services over two separate `PrismaService` connection pools.
Full report: [`docs/progress/259-zone-claim-admission.md`](../../../docs/progress/259-zone-claim-admission.md).

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

---

## Corrections / found while building (2026-08-21)

**Three deviations from the text above, each deliberate.** `status` is a Prisma **enum**
(`DispatchZoneClaimStatus`) rather than the `TEXT` this issue specified — the two statuses beside it on
the same model are enums and a TEXT column would be the only unconstrained one in the ledger.
`contended_with_run_id` carries **no FK**: it is a historical breadcrumb, the #104 purge would either
cascade it away or null it, and a second relation to `DispatchRun` forces relation names onto the
existing `run` relation for no gain. The response field is `summary.zoneOutcomes`, not this issue's
`zones[].outcome` — `summary.zones` is an established **count** and renaming it breaks every consumer.

**The admission is `INSERT … ON CONFLICT DO NOTHING`, not the insert-and-catch this issue implies.**
#265 established that a P2002 aborts its Postgres transaction, so a caught one leaves nothing to
continue with. `DO NOTHING` answers with a row count, which is what lets the entire admission — run
row, claims and refusals — live in one transaction that can still roll back whole. That rollback is
what makes "two cases, no third" true: when the last free zone is taken between the pre-read and the
insert, the transaction unwinds and the caller gets the no-trace 409 rather than an empty run.

**A refusal could name nobody — a defect this issue's own AC-1 would not have caught.** The loser of an
admission race re-read the *live* claims after its rollback, and the winner may have finalized its own
claim by then, producing `inFlight: []` and a bare 409. Found by the barriered race test, intermittent
(2 of 5 runs). Fixed by reading the **latest** claim row for the zone — whichever status — inside the
losing transaction, where the row the insert collided with is guaranteed visible.

**`dispatch_run_zones.started_at` changed meaning**, from "when this zone's processing began" to "when
the zone was claimed". That is the honest reading for a row whose existence blocks everyone else.

**A contended zone is not an error.** `error` stays `null` on a CONTENDED row so the ledger's Errors
column is unchanged; the run status carries the fact (contended → PARTIAL).

**The new cardinality made the runs list and the run detail disagree about "Zones"** — the list reports
`dispatch_runs.zones` (processed) and the detail counted cards (which now include contended). Both
exclude contended zones now, the ZM list slice included: `zones: 1` for a contended zone would tell a
Zonal Manager their zone was worked and produced nothing.

**Two test-method traps, both recorded because both cost time.** A barrier at the read→write gap is not
enough when the whole run is stubbed — the winner can claim, dispatch and *release* before the loser
reaches its insert, and the test reports two legitimate winners; the zone has to be parked as well. And
`vi.restoreAllMocks()` **destroys** a Prisma delegate method (its methods are not own properties, so
restore deletes the spy and leaves nothing), silently breaking the client for every later test in the
file.

**#252 landed here**, per INDEX's "land it inside whichever of #259/#262 ships first", and was extended
to #177's `component_blocked_withheld` — the issue named only #238's and #242's columns, but the third
has the identical defect.
