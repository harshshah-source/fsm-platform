# 262 — Per-SE dispatch transactions with row-claimed recommendations

Status: done (2026-08-23) — see `docs/progress/262-per-se-dispatch-transactions.md`
Type: AFK · Backend
Decision: #258 Q8 / Part 4 (G1, G3, G4). Supersedes the open half of #127 (whose "done via APPEND"
INDEX note overstated it — the zone is still one all-or-nothing transaction).

## Objective

The dispatch write unit shrinks from the zone to the SE: one SE's conflict costs that SE's
increment only, transaction duration becomes bounded by `daily_capacity`, and the Prisma 5-second
interactive-transaction default stops being a production cliff.

## Current behaviour

- `dispatchForZone` is ONE transaction for the whole zone (`batch-assignment.service.ts:64-226`):
  any P2002 (e.g. a ZM `assignTicket` landing between the in-tx guard read at `:88-98` and the
  create) rolls back EVERY SE's plan, mislabeled `SCHEDULE_CONFLICT` (`:262-268`).
- ~3 sequential round-trips per ticket inside that tx; **no `transactionOptions` anywhere** → Prisma
  defaults (maxWait 2s, timeout 5s). Test fixtures are small; a production-sized zone can abort on
  the timer.
- Recommendation consumption is zone-batch at the end (`:195-200`); the recommender's concurrent-run
  collision path is a silent P2002 `continue` (`recommender.service.ts:610`).

## Required change

1. Restructure `dispatchForZone`: group SUGGESTED recs by SE (read outside), then **one transaction
   per SE**: `SELECT ... FOR UPDATE SKIP LOCKED` that SE's `recommendations` rows
   `WHERE status='SUGGESTED'` (verify the lifecycle first — rows are created by the recommender
   under the same runId and nothing else locks them; SKIP LOCKED makes a concurrent claimer's rows
   simply invisible instead of a P2002), re-run the live-batch idempotency guard for that SE's
   tickets, create/append schedule + batches + ticket rows, flip tickets, consume THAT SE's recs →
   commit. Notification intents buffer per-SE (#264 makes them durable).
2. Zone-level exclusion: run-vs-run is #259's claim. Closure/bulk-unassign exclusion keeps the
   shared advisory key — each per-SE tx takes `pg_advisory_xact_lock` (blocking) under a local
   `SET LOCAL lock_timeout` of a few seconds; contention windows are milliseconds, and a timeout
   skips only that SE with an explicit per-SE skip reason. Key stays `dispatch-zone-lock.ts:13` —
   do NOT fork the string.
3. Per-SE failure containment: P2002/timeout in one SE's tx → record on the zone row (new
   `seSkips` JSON: seId, reason, constraint name from `e.meta.target`), continue with the next SE.
   Zone `skipReason` is reserved for whole-zone conditions (lock/claim).
4. At zone completion, delete this run's leftover SUGGESTED for the zone (existing
   `clearRunZoneOrphans`, now covering per-SE failures too).
5. Set explicit client-wide `transactionOptions` (maxWait 5s, timeout 15s) in `PrismaService` — a
   deliberate policy, not a default nobody chose.
6. **Zone-level plan-shaping gets ONE owner (review correction).** Splitting the zone transaction
   opens a window between SE transactions that the all-or-nothing tx did not have. Verified:
   - **Schedule closure is safe** and needs nothing — `closeZone` targets `dateTo: { lt: today }`
     (`schedule-closure-scheduler.service.ts:166`) while dispatch writes today; the data sets are
     disjoint regardless of interleaving.
   - **Bulk-unassign is NOT safe by data** — it targets *today's* work under the same zone key, so
     it can now land between SE transactions and produce a half-rebalanced zone (SE1 dispatched →
     unassigned → SE2 dispatched fresh).
   Therefore: **`BulkUnassignService.executeZone` and `ScheduleClosureScheduler.closeZone` acquire
   the #259 zone claim** (as non-run holders, released on completion) in addition to keeping the
   advisory lock. One admission concept answers "who owns this zone right now"; the advisory lock
   stays as the in-transaction backstop. A bulk-unassign that finds the zone claimed by a live
   dispatch skips that zone with its existing per-zone skip reporting — the behaviour it already has
   for lock contention, now decided one level up.

## Existing code to reuse

APPEND/`liveScheduleFilter` lookup (`:127-157`) unchanged per SE; `alreadyAssigned` guard logic;
`clearRunZoneOrphans`; `orderPlantStops`; the uniques as final backstop.

## Data model

`dispatch_run_zones.se_skips JSONB NULL`. No other migration.

## API / UI surfaces

Transparency zone card may list per-SE skips (small addition to `dispatch-transparency-query` +
zone card — fold into #252's rendering pass if it lands together). Mobile: n/a.

## Acceptance criteria

- [x] A ZM `assignTicket` racing the dispatch of a 5-SE zone costs at most one SE's batch; the
      other 4 SEs' plans commit; the skipped SE and the violated constraint are named on the ledger.
- [x] A zone with N tickets dispatches with per-tx duration independent of N (asserted: max tx
      wall-clock bounded; e2e with a few hundred fixture tickets stays far under the 15s policy).
- [x] Re-invoke after partial failure dispatches only the remaining SEs' tickets (G1: no ticket
      ever on two live batch rows — asserted table-wide, the #241 style).
- [x] Closure or bulk-unassign holding the zone advisory lock delays a per-SE tx by at most the
      lock_timeout and never deadlocks.
- [x] `SCHEDULE_CONFLICT` label appears only for the schedule unique; ticket-unique conflicts say so.
- [x] **Bulk-unassign cannot interleave**: a bulk-unassign issued while a zone dispatch is mid-run
      (between SE transactions) is refused/skipped for that zone with its existing reporting, and the
      dispatch completes every SE it admitted. Closure interleaving is separately asserted as a
      no-op on today's schedules.
- [x] **Ledger reconciliation survives partial-zone outcomes** (#123's invariant): run totals
      (`schedules`, `batches`, `ticketsDispatched`, `recommended`, `unassignable`) equal the sum of
      the run's zone rows even when some SEs were skipped and some zones CONTENDED (#259) — asserted
      on a fixture that produces at least one per-SE skip AND one contended zone in a single run.

## Tests

Rework `dispatch-zone-wedge`, `dispatch-concurrent`, `dispatch-idempotent`, `dispatch-same-day-append`
to the per-SE contract; new per-SE-isolation e2e (the #127 spec that never existed); duration probe.

## Dependencies / Blocked by

**#259 is now a HARD prerequisite** (upgraded from "recommended" by the pre-implementation review):
item 6 puts closure and bulk-unassign on the zone claim, which #259 defines. #261 should precede
this too, so a crashed per-SE run cannot hold a claim indefinitely. #264 depends on this issue's
per-SE buffering.

## Risks

Highest-touch change of the set — the batch/schedule invariants (#100's four specs) must all stay
green; SKIP LOCKED semantics must be verified against the actual recommendation lifecycle (no other
reader locks those rows today — verify at implementation).

## Rollback

Code-only restructure; revert restores the zone tx. `se_skips` column is additive.
