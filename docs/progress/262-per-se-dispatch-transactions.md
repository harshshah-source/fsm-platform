# #262 — Per-SE dispatch transactions with row-claimed recommendations

**Landed** 2026-08-23 · branch `feat/autoplant-integration` · TDD via `/tdd`
**Issue:** [`.scratch/fsm-platform-v1/issues/262-per-se-dispatch-transactions.md`](../../.scratch/fsm-platform-v1/issues/262-per-se-dispatch-transactions.md)
**Commit:** `f4684b9`
**Supersedes the open half of #127.** Clears the last prerequisite of **#275**.

---

## What changed, in one paragraph

`dispatchForZone` was one transaction for the whole zone. It is now one transaction per SE, each
claiming that SE's recommendation rows with `SELECT … FOR UPDATE SKIP LOCKED`. A conflict costs the SE
it belongs to instead of everybody; transaction duration is a function of `daily_capacity` rather than
of zone size; and a concurrent claimer's rows are invisible rather than a P2002 nobody can recover from
in place.

## The number that says it best

The first RED measured all three defects at once. With the zone-wide transaction, a second connection
holding **one** SE's recommendation rows **blocked the whole zone** until the transaction timeout killed
it — **15 seconds**, and nothing dispatched. The same test after the restructure is **360 ms**, and the
other engineers get their day plans.

## Acceptance criteria

All seven met.

| AC | Where | Note |
|---|---|---|
| 1 · one SE's conflict costs one SE; others commit; the skipped SE and constraint named on the ledger | `dispatch-per-se-isolation.e2e-spec.ts` → `skips an SE whose recommendations another claimer holds…`, `records a zone-lock timeout as a per-SE skip…`, `persists per-SE skips onto the dispatch_run_zones row` | Staged with real contention, not a fault injection — see "How the failure was staged" |
| 2 · per-tx duration independent of N | → `dispatches a large zone with every transaction far inside the 15s budget` | 160 tickets across 4 SEs in **774 ms**; the whole zone now fits in the budget one transaction used to need |
| 3 · re-invoke after partial failure dispatches only the rest (G1 table-wide) | → `re-invoked after a partial dispatch, it completes the rest and never double-assigns` | G1 asserted on `batch_assignment_tickets` rows, #241 style |
| 4 · closure/bulk-unassign holding the lock delays a per-SE tx by at most `lock_timeout`, never deadlocks | → `records a zone-lock timeout as a per-SE skip…` | Bounded by `SET LOCAL lock_timeout`; the timeout is a named skip, not an exception |
| 5 · `SCHEDULE_CONFLICT` only for the schedule unique | `dispatch-se-skips.spec.ts` (5 tests) | See correction 1 |
| 6 · bulk-unassign cannot interleave; closure interleaving asserted as a no-op on today | `bulk-unassign-execute.e2e-spec.ts` → `#262: skips a zone a live dispatch run has claimed…` + `a finished claim does not block a rebalance`; `schedule-closure-scheduler.e2e-spec.ts` → `#262: closure interleaving is a no-op…` | See correction 2 |
| 7 · ledger reconciliation survives partial outcomes | → `run totals equal the sum of its zone rows with a per-SE skip AND a contended zone` | One fixture producing **both** shapes, as the AC requires |

## Two corrections to the issue, both load-bearing

**1. `e.meta.target` does not exist here.** Item 3 says to read the violated constraint from it. That
is the field every Prisma example uses and #265 measured its absence under this repo's driver adapter;
the identity arrives at `meta.modelName`. `uniqueViolationModel` is the mechanism, and it is what makes
AC-5 true rather than aspirational: `SCHEDULE_CONFLICT` is now **earned** by the schedule unique alone,
a ticket collision says `TICKET_CONFLICT`, a lock timeout says `ZONE_LOCK_TIMEOUT`, and anything else
reports itself instead of borrowing a label. Before this, *any* rollback cause was reported as
`SCHEDULE_CONFLICT`, so the ledger asserted a specific and checkable thing that was frequently untrue.

**2. Closure and bulk-unassign cannot *acquire* the #259 claim.** Item 6 instructs them to, "as non-run
holders". A claim **is** a `dispatch_run_zones` row and cannot exist without a `dispatch_runs` parent,
so acquiring one would mean either writing fake run rows into the transparency ledger or adding a second
claim table — a larger change than the problem. They **respect** the claim instead, which closes the
window #262 actually opened: the gaps *between* per-SE transactions, where the transaction-scoped
advisory lock is not held at all. The other direction is already covered — a dispatch starting while a
rebalance holds the zone waits on the advisory lock, bounded, and skips that one SE.

**Closure is deliberately not claim-gated**, against item 6's literal instruction and in line with the
issue's own verification (*"Schedule closure is safe and needs nothing"*). It targets `dateTo < today`
while dispatch writes today, so the row sets are disjoint however they interleave. Item 6's "therefore"
sentence also contradicts AC-6's own requirement that closure interleaving be *a no-op on today's
schedules* — a claim-gated closure would not run at all during a dispatch. **Demonstrated rather than
argued:** adding the gate makes the new closure test fail, because past-dated schedules stop closing
during every morning dispatch.

## Design decisions

**SKIP LOCKED, because a P2002 cannot be recovered in place.** #265 established that a P2002 aborts its
Postgres transaction. Zone-wide consumption was a single `updateMany` at the very end, so a concurrent
claimer produced exactly that unrecoverable collision. `FOR UPDATE OF r … SKIP LOCKED` makes the rows
invisible instead. `OF r` names the recommendations alone — locking the joined ticket and plant rows
would block unrelated writers for the length of the SE's transaction.

**The idempotency guard moved inside the per-SE transaction**, and that is what makes AC-3 work. The
zone-wide read happened once, before any SE committed, so it structurally could not see its own
progress; a re-invoke now re-reads per SE and finds the tickets the previous pass placed.

**Orphan cleanup is scoped to the SEs that failed, not to the zone.** This is a correction the
restructure forced. A row this dispatch could not *see* is a row somebody else has locked, and a
zone-wide sweep would delete work out from under its claimant — a bug the old code could not have,
because it had no notion of a row it could not see.

**The advisory lock changed job rather than going away.** Run-vs-run exclusion is #259's claim now, so
what it still guards is dispatch against closure and bulk-unassign — windows of milliseconds. That
makes blocking the right posture where a non-blocking `try` would abandon a zone that was free a
moment later; `SET LOCAL lock_timeout` (3 s) bounds it so one stuck holder cannot stall the dispatch,
and a timeout is one SE's named skip.

**`transactionOptions` stated rather than inherited.** Prisma's unconfigured defaults are `maxWait` 2 s
and `timeout` **5 s**, set nowhere in this repo. `maxWait` is pinned to 5 s to match
`DB_POOL_ACQUIRE_TIMEOUT_MS` — both answer "how long before the caller learns the server is saturated",
and answering it twice differently makes the backpressure signal arrive at two different times.
Asserted **behaviourally** (a 7 s transaction survives), because reading the option back would only
assert that a field was set.

## A latent bug found while here

`BulkUnassignService` hand-spelled the advisory key as `'dispatch_zone_' + zoneId` instead of importing
`dispatchZoneLockKey`. It matched by luck. That module exists precisely because two spellings that drift
by a character take **different** locks and contend with nothing — a race no test would fail on. Now
imported, as item 2 instructs ("do NOT fork the string").

## How the failure was staged, and why

Worth recording, because the obvious approaches do not work here.

- **A Prisma delegate patch does not reach inside a transaction.** Measured directly: patching
  `prisma.zone.findFirst` is visible outside `$transaction` and **not** inside it. That is why the #259
  and #213 wedge tests could patch `dispatchRunZone.update` — those calls are outside a transaction —
  and why the same trick cannot inject a fault into a per-SE transaction.
- **A natural per-SE P2002 is unreachable by construction**, and that is the design working. After
  #127's APPEND (a pre-existing schedule is *reused*, not collided with) and the per-SE guard re-read
  (a ticket already on a live batch is filtered, not inserted twice), the only ways to produce one are
  a genuinely concurrent external writer or fault injection.
- **So the isolation claim is proven with real contention**: a second connection holding one SE's rows
  (SKIP LOCKED) and a second connection holding the zone lock (`lock_timeout`). Both are the exact
  mechanisms the issue specifies, both are deterministic, and both assert on committed rows rather than
  on returned counts. AC-5's label discrimination is pinned at its own seam with the error shape #265
  recorded.

## Sensitivity

| Break | Test that caught it |
|---|---|
| (initial RED) zone-wide transaction | `skips an SE whose recommendations another claimer holds` → blocked 15 s, whole zone lost |
| (initial RED) no claim respected by bulk-unassign | `skips a zone a live dispatch run has claimed` → rebalance ran straight through |
| (initial RED) no `se_skips` column | `persists per-SE skips onto the dispatch_run_zones row` → undefined |
| (initial RED) no label module | `dispatch-se-skips.spec.ts` → module not found |
| zone row stops recording what the run counts | `run totals equal the sum of its zone rows` → 8 ≠ 0 |
| closure gated on the claim (item 6's literal text) | `closure interleaving is a no-op` → past-dated work stopped closing |
| `transactionOptions` reverted to Prisma's default | `lets a transaction run past the 5s default` → P2028 |

## Tests

Backend **406 files / 2015 passed / 5 skipped / 0 failed**, four chunks exit 0. Admin **105 files / 545
passed** (the single reported error is the pre-existing `TicketDetailDrawer.tsx:440` fault).

`npx tsc -p tsconfig.test.json --noEmit` leaves three errors, all pre-existing: two in files this issue
never touched (`bulk-unassign.e2e-spec.ts:64`, `closure-clears-assignment.e2e-spec.ts:335`) and one at
`bulk-unassign-execute.e2e-spec.ts:76`, well outside this issue's only hunk in that file (line 177+).

**The DI-wiring test earned its keep.** The new `config` constructor parameter needs `@Optional()` or
Nest treats it as an injection token and fails to resolve `SchedulingModule` at boot. That surfaced as
**36 failed files in one chunk** from a single missing decorator.

## What this deliberately does NOT do

- **No notification durability.** Intents still buffer in memory and fire after the transactions settle.
  **#264** owns making that durable, and depends on this issue's per-SE buffering.
- **#124's effective snapshot did not ride along.** INDEX still lists it with #262; it is untouched here
  and needs a home.
- **Zone `skipReason` narrowed, not removed.** It is now reserved for whole-zone conditions; the only
  producer left is a zone nobody could work at all.
