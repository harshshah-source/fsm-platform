# #259 — Zone-claim admission: DB-backed per-zone dispatch claims, partial multi-zone outcomes

**Landed** 2026-08-21 · branch `feat/autoplant-integration` · TDD via `/tdd`
**Issue:** [`.scratch/fsm-platform-v1/issues/259-zone-claim-admission.md`](../../.scratch/fsm-platform-v1/issues/259-zone-claim-admission.md)
**Also closes #252** (per INDEX's "land it inside whichever of #259/#262 ships first" instruction),
extended to #177's third counter.

---

## What changed, in one paragraph

Run admission was an in-process `Map` on the `DispatchRunService` singleton (#213). It gave an
operator a clear answer when they pressed the button twice *in one process* and nothing at all when
the second caller was a second instance or the same instance after a restart. It is now a row: the
`dispatch_run_zones` row is created `RUNNING` **at admission** and finalized `DONE`/`ERROR` where it
used to be created at completion, guarded by a partial unique
`ux_dispatch_run_zones_one_running_per_zone ON dispatch_run_zones(zone_id) WHERE status = 'RUNNING'`.
Admission is per zone, so one held zone costs exactly that zone instead of cancelling the whole
request — the 05:00 national cron run is no longer cancelled by a zone-scoped rebalance in flight.

## Acceptance criteria

All six met. Proof lives in `apps/backend/test/dispatch-zone-claim-admission.e2e-spec.ts` unless
noted; every assertion in that file is made across **two independently constructed services over two
separate `PrismaService` connection pools**, because a test that drove one singleton twice would pass
against the old map and prove nothing.

| AC | Where | Note |
|---|---|---|
| 1 · two concurrent single-zone runs, one 409 naming the holder, claim held by a *different connection* | `refuses a run whose zone is claimed by a different connection…` | Service B has never heard of service A; the only thing between B and a second concurrent run is the row A wrote |
| 2 · multi-zone with one held → CONTENDED row, others dispatch, run PARTIAL, #123's sums reconcile | `dispatches every free zone, records the held one CONTENDED…` | The CONTENDED row contributes zeros, so the run's columns still equal the sum of its cards |
| 3 · disjoint zones run concurrently, two ledger rows, no interference | `runs two zone-scoped runs on disjoint zones concurrently…` | Asserted *while* the first is still parked, so a silent serialization would not pass |
| 4 · restart with a RUNNING claim → `in-flight` still reports it | `still reports a RUNNING claim from a service instance that never saw it taken` | Release is #261's reaper, deliberately not here |
| 5 · all-held → 409 and **zero** rows in both tables, by row count | `writes zero rows to dispatch_runs AND dispatch_run_zones…` + `…when an unscoped run finds every active zone held` | Counted either side of the call; "no error thrown" would pass against an implementation that opened a run row and finalized it empty |
| 6 · partial → one run row, DONE rows dispatched, CONTENDED rows held, status PARTIAL | same test as AC-2 | |

Beyond the ACs, two invariants that the change put at risk are pinned here too: the wedge (a run that
dies holding a claim must not refuse its zone forever) and the admission race itself (two callers that
both saw the zone free).

## Design decisions

**`INSERT … ON CONFLICT DO NOTHING`, not insert-and-catch.** #265 established that a P2002 aborts its
Postgres transaction, so catching one leaves nothing to continue with. `DO NOTHING` answers with a row
count instead, which lets the entire admission — run row, claims and refusals — live in **one**
transaction that can still roll back cleanly. That is what makes the issue's "two cases, no third"
true rather than aspirational: a `dispatch_run_zones` row cannot exist without its parent
`dispatch_runs` row, so when the last free zone is taken between the pre-read and the insert, the
whole transaction rolls back and the caller gets the no-trace 409.

**Zones are claimed in ascending id order**, always (`activeZoneIds` orders by zone id; a scoped run is
one zone), so two concurrent admissions cannot deadlock on each other's speculative inserts.

**Three deviations from the issue text, each deliberate:**

- `status` is a **Prisma enum** (`DispatchZoneClaimStatus` → `dispatch_zone_claim_status`), not the
  issue's literal `TEXT`. `DispatchRunStatus` and `DispatchZoneMode` on the same model are enums; a
  TEXT column here would be the only unconstrained status in the ledger.
- `contended_with_run_id` is a plain nullable `BIGINT` with **no FK**. It is a historical breadcrumb;
  the #104 90-day purge would either cascade the refusal away or null it, and neither improves the
  record. A second relation to `DispatchRun` would also force explicit relation names onto the
  existing hot `run` relation for no gain.
- The response field is `summary.zoneOutcomes`, not the issue's `zones[].outcome` — `summary.zones` is
  an established **count**, and renaming it would break every existing consumer.

**`dispatch_run_zones.started_at` changed meaning** from "when this zone's processing began" to "when
the zone was claimed". That is the honest reading for a row whose existence is what blocks everyone
else: the zone is genuinely unavailable from admission, not from its turn in the loop.

## Found while building

Six things the issue did not describe. Four are defects in work this session produced and caught; two
are properties of the environment worth not rediscovering.

**1 · A refusal could name nobody.** The loser of an admission race re-read the live `RUNNING` claims
after its rollback — and by then the winner may already have finalized its own claim to `DONE`,
leaving `inFlight: []` and a bare 409, the one thing #213 exists to prevent. Caught by the barriered
race test, which failed intermittently (2 of 5 runs) rather than never. Fixed with a second read
(`claimantsOf`): the **latest** claim row for the zone, whichever status, read *inside* the losing
transaction where the row the insert collided with is committed and therefore guaranteed visible. It
is by construction the right row — no second claim could have been taken while the first was RUNNING.
`holdersFor` keeps its live-only semantics, because "who holds this now" is a different question and
is the one the in-flight endpoint asks.

**2 · A barrier at the read→write gap is not enough when the run is stubbed.** The first version of
the race test barriered both callers between their free-check and their first write, which is the
correct gap — and reported **two winners**. Both were legitimate: the winner's whole run is stubbed, so
it can claim, dispatch, finalize and *release* the zone before the loser reaches its insert, at which
point the loser is not racing anybody. The fix is to **park** the zone, so whichever caller wins holds
the claim while the other tries. `test/support/concurrency.ts` warns that a start-together race proves
nothing; this is the next trap along — a genuinely barriered race that still does not overlap where it
matters.

**3 · `vi.restoreAllMocks()` destroys a Prisma delegate method.** A delegate's methods are not own
properties, so `vi.spyOn` writes one and `restoreAllMocks` deletes it, leaving **nothing** behind —
`companyTierOverride.findMany is not a function` for every later test in the file, reported against
whichever test happened to run next. Patch Prisma delegates by assignment with an explicit restore,
which is what `dispatch-in-flight-guard.e2e-spec.ts` already did.

**4 · The first wedge test proved nothing.** It broke the run-level finalize (`dispatchRun.update`) —
but by then every zone claim has already been closed by the per-zone finalize, so there is nothing
stranded and the test passes whether or not the release exists. Verified by deleting the release and
watching it stay green. Retargeted at `dispatchRunZone.update`, where a claim really is open; it now
fails without the release. The same correction was applied to #213's own wedge test in
`dispatch-in-flight-guard.e2e-spec.ts`, which had drifted the same way for the same reason.

**5 · The new cardinality made the runs list and the run detail disagree.** `dispatch_runs.zones`
counts zones the run *processed*; the detail page counted *cards*, which now include contended zones.
Same run, two different "Zones" numbers on two screens. Both now exclude contended zones — including
the ZM slice of `listRuns`, where `zones: 1` for a contended zone would have told a Zonal Manager
their zone was worked and produced nothing, the opposite of what happened. The cards themselves still
show the contended zone, labelled.

**6 · A contended zone is not an error.** `error` stays `null` on a CONTENDED row, so the ledger's
"Errors" column is unchanged and nobody is sent to look for a fault that never happened. The run
status carries the fact instead: contended → `PARTIAL`, which is exactly what PARTIAL already meant.

## #252, landed here

INDEX assigned #252 to whichever of #259/#262 shipped first. Three `dispatch_run_zones` columns were
written by the engine and projected by nothing — `withheld_below_threshold` (#238),
`bucketless_dropped` (#242) and `component_blocked_withheld` (#177; the issue named only the first
two, but the third has the identical defect and was added rather than left to rot). The zone detail
subtitle read `N considered · N recommended · N dispatched · N unassignable`, which invites the
arithmetic `considered = recommended + unassignable` — and on the dev mirror at #252's filing, 5,127 of
6,464 open unassigned Troubleshoot tickets carried no computed SLA bucket, i.e. the invisible class was
the *majority* of the pool.

All three now render, apart from `unassignable` and from each other, because each sends a different
team: `unassignable` is an Ops coverage gap, `withheld below threshold` is policy working, `no SLA
bucket` is a data fault, `waiting on a part` is the warehouse's clock. The two nullable ones render
**"not recorded"**, never `0` — they are nullable precisely so a run predating the counter does not
claim a measurement nobody took. They use a `label: value` form rather than the `value label` of the
four counters beside them, because "not recorded no SLA bucket" is not a sentence.

## Tests

**Backend, full suite, four foreground chunks** (background long-runs are terminated by this
environment; the foreground cap is 10 min and the suite takes ~11.5):

```
401 files · 398 passed · 3 skipped · 0 failed
1977 tests passed · 5 skipped
exit 0 on all four chunks
```

One #184 worker crash inside chunk 2, auto-retried and recovered. The 3 skipped files / 5 skipped
tests are pre-existing. Baseline before this work was 400 files / 1969 tests; the deltas are this
issue's new spec file (8 tests) and assertions added to existing tests.

**Admin:** 104 files / 544 tests passed, `tsc --noEmit` clean. The single unhandled error is the
**pre-existing** `TicketDetailDrawer.tsx:440` fault in `ticket-drawer-tabs.test.tsx`, unrelated and
already recorded in the previous handoff.

**Sensitivity.** Six tests were green on arrival (the minimal implementation for AC-1 necessarily
carried AC-3/4/5/6 with it). Each was broken deliberately and its red recorded rather than assumed:

| Break | Red |
|---|---|
| pre-read short-circuit **and** rollback both disabled | `{zoneRows: 4, runs: 1}` vs `{zoneRows: 3, runs: 0}` — the AC-5 counts, specifically |
| restore the old global refusal (`preRead.length > 0`) | AC-2/6 partial: `expected 'CONFLICT' to be 'RAN'` |
| contended no longer affects run status | `expected 'SUCCESS' to be 'PARTIAL'` |
| claims no longer per-zone (`holdersFor` ignores its scope) | AC-3 disjoint: `expected 'CONFLICT' to be 'RAN'` |
| `inFlightZones` answers from process memory | AC-4 restart: `expected undefined to match object` |
| stranded-claim release removed | wedge: `expected { id: 16n, runId: 13n, … } to be null` |

## Files

| | |
|---|---|
| `apps/backend/prisma/migrations/20260821130000_dispatch_zone_claims/` | enum, two columns, backfill, partial unique |
| `apps/backend/prisma/schema.prisma` | `DispatchZoneClaimStatus`, `status`, `contendedWithRunId` |
| `apps/backend/src/scheduling/dispatch-run.service.ts` | `admit` / `holdersFor` / `claimantsOf` / `releaseStrandedClaims` / `finalizeZoneClaim`; the `Map` deleted |
| `apps/backend/src/scheduling/schedules.controller.ts` | `in-flight` reads the ledger (async; same response shape) |
| `apps/backend/src/scheduling/dispatch-transparency-query.service.ts` | zone card `outcome` + `contendedWithRunId` + the three #252 counters; ZM list slice excludes contended |
| `apps/admin/src/api/dispatch-runs.ts` · `pages/dispatch/DispatchRunDetailPage.tsx` · `pages/dispatch/DispatchZoneDetailPage.tsx` | CONTENDED badge + holder note, Zones metric, the #252 funnel line |
| `apps/backend/test/dispatch-zone-claim-admission.e2e-spec.ts` | new — 8 tests |
| `dispatch-in-flight-guard` · `dispatch-preview` · `dispatch-run-containment` · `dispatch-run-removed-since` · `dispatch-transparency-api` · admin `dispatch-run-detail` · admin `dispatch-zone-detail` | migrated to the DB-backed contract |

## What this leaves for the next issues

- **#261** owns the reaper. This release only covers a run that *unwinds*; a process that dies without
  unwinding leaves a `RUNNING` claim that refuses its zone until somebody clears it. That is the
  intended division — AC-4 pins the claim surviving a restart precisely so #261 has something to reap.
- **#260** owns retrying a contended zone. Admission is try-once here, by ruling: manual stays
  try-once, and the cron's patience is #260's.
- **#262** takes the zone claim for closure and bulk-unassign, so zone plan-shaping has one owner.
