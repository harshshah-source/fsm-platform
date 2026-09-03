# #327 — One acquisition order across the manual assignment write paths

**Findings:** RC-12 + RC-13 (`audit/2026-09-01-scheduler-engine-forensics.md` §8) · **Wave 4** · P3
**Landed:** 2026-09-02 · branch `feat/autoplant-integration`
**Issue:** [`.scratch/fsm-platform-v1/issues/327-assignment-write-path-ordering.md`](../../.scratch/fsm-platform-v1/issues/327-assignment-write-path-ordering.md)

---

## What was wrong

**RC-12 — a lock-order inversion between the two manual assign doors.** `assignLane` locked the ticket
row (`FOR UPDATE ... SKIP LOCKED`) and *then* inserted the `batch_assignment_tickets` row.
`assignTicket` inserted that row first and updated `tickets` last. Two managers acting on one ticket
through the two doors therefore each held the row the other needed next, and Postgres broke the cycle
the only way it can — a 40P01 that nothing caught.

**RC-13 — two `max + 1` mints with nothing serialising them.** `nextStopSequence` and `nextSortOrder`
read a maximum and wrote maximum+1 with no lock between the read and the write, so two adds landing on
one plan together minted the same stop number. `reorder` compounded it by reading the plan it was about
to renumber **before** its transaction opened.

## What the red run actually showed — the 500 has a quieter twin

The issue predicted "40P01 → unhandled 500 / spurious `LANE_FAILED`". Staged, both halves appeared, and
the second is the one worth recording:

| door | before |
|---|---|
| `POST /schedules/assign` (`assignTicket`) | `DriverAdapterError: deadlock detected` escapes the service — a 500 on a path both controllers map to 409 |
| `POST /schedules/assign-batch` (`assignLane`) | `assignBatch`'s blanket `catch` folds the throw into `LANE_FAILED`, assigned 0, **skipped `[]`** |

`LANE_FAILED` with an empty skip list is the same 40P01 wearing a friendlier name: the operator is told
the lane failed and given nothing to act on, and no log line distinguishes it from a genuine failure.
The spec asserts `result === 'OK'` on that lane for exactly this reason — a lane may lose a *ticket*,
but it may not fail as a whole because of an ordering defect.

## The order, and why this one

```
tickets  →  work_schedules  →  plant_batch_assignments  →  batch_assignment_tickets
```

Documented above the class, and `assignTicket` moved to match `assignLane` rather than the reverse.
The issue allowed either ("pick one"); three things decided it:

1. **It is the order the dispatch run already writes in** — `batch-assignment.service.ts`, "#306: the
   ticket write comes FIRST, and it is guarded". Choosing the other direction would have put the manual
   doors on an order the engine does not use.
2. **The ticket row is the row every path actually contends on.** Taking it first is what makes a loser
   leave nothing behind, which is the same argument #306 makes for the guarded write.
3. **Aligning `assignLane` instead would have unwound #265's `SKIP LOCKED` re-verify** — the one guard
   between a multi-ticket lane and a P2002 that aborts every sibling already written in that
   transaction. The issue's own regression note forbids exactly that, and the `lost-race-hygiene` suite
   pins it.

`assignTicket` now opens its transaction with a blocking `SELECT ... FOR UPDATE` on the ticket and
re-checks `assignment_state`. **Blocking, not `SKIP LOCKED`** — and that asymmetry is deliberate: a lane
skips because a ticket it cannot lock has siblings waiting behind it, so reporting one lost race is
cheaper than stalling the rest; a single-ticket assign has nothing to get on with, so waiting for the
concurrent writer is what lets it give the *true* answer rather than a guess. Under READ COMMITTED the
lock re-evaluates the row, so what it reads is the winner's committed state.

Losing throws `LostRaceError` rather than returning: `withAudit` writes the audit row in that same
transaction, and a refusal must leave no trail claiming an assignment that never happened (#265). The
existing P2002 recovery stays as the braces to that belt — it is the database's own answer, and it also
covers a racer that inserts without locking first.

## RC-13: prevention, and why not the index the issue permitted

`lockSchedule` takes the `work_schedules` row before anything hanging off it, called from
`ensureSchedule` (the one place all four writers obtain a schedule), both mints, both renumbering paths
(`moveBatchToTop`, `reorder`) and `flagOverridden`. `nextSortOrder` takes the batch row for the same
reason one level down.

**The DB unique was allowed and is still wrong.** `scripts/probe-stop-sequence-duplicates.cjs` was
written and run against the dev database `fsm` (1,133 schedules, 1,579 plant batches, 7,391 live
batch-ticket rows): **zero duplicate groups** on `(schedule_id, stop_sequence)` and zero on
`(batch_id, sort_order)`, so #155's rule would not have blocked a `UNIQUE` index. It was rejected on a
ground the probe cannot see: **renumbering writes transient duplicates by construction.**
`moveBatchToTop` sets the incoming batch to stop 1 while the outgoing first stop still holds 1, so a
non-deferrable unique index would refuse the very operation that heals the ordering — and Prisma cannot
express the `DEFERRABLE` constraint that would not. Prevention at the mint has no such edge and needs no
migration, so `prisma/drift-baseline.txt` is untouched and this slice adds no migration at all.

**Why duplicates were worth preventing rather than tolerating.** The forensics called them "cosmetic;
self-heals on reorder", and that undersells it: every reader of a day plan orders by `stop_sequence`
(`day-plan-query`, `zm-schedule-query` ×2, `dispatch-today-query`, `dispatch-transparency-query`,
`engineers-query`, ops-explorer). With two stops sharing a number the SE's route order is whichever row
the index happens to return first — so two reads of the same plan can disagree, and the operator and
the engineer can be looking at different orders for the same day. Making every reader carry a
deterministic tiebreak was the alternative the issue offered; it would have meant editing seven readers
in five services, outside this issue's stated boundary (`override.service.ts` internals only), to fix
by convention what one lock fixes at the source.

`reorder` also moved its read inside the transaction, under that lock. Before, a stop added between the
read and the write was never renumbered — which is precisely the two-stops-one-number state this action
exists to heal — and a stop removed in the gap failed the whole reorder on a row that no longer existed.
One consequence is stated in the code rather than hidden: the audit row now records the stop position
the operator **asked for** instead of one clamped against a pre-transaction count. The clamp is a
function of the plan's length, which only the transaction can know, and the resulting order is on the
plan itself; nothing reads that metadata field.

## The residual 40P01

Ordering cannot be made total from inside one file, so the issue's second half is not belt-and-braces —
it is load-bearing. Two residues are known and named rather than implied:

- **Cross-schedule moves have no natural order between source and destination.** `moveTickets` and
  `swapSe` lock the destination schedule and then stamp the source; two moves in opposite directions
  between the same pair of engineers can still cycle.
- **Writers this file does not own** — the dispatch run creates the `work_schedules` row before it
  touches `tickets`, which is the reverse of the manual doors' first two steps.

`isDeadlock` (in `common/lost-race.ts`, beside `LostRaceError` because both mean *this transaction lost
a race and rolled back whole* — the difference is only whether a guard we wrote or Postgres picked the
loser) maps those to each door's **existing** conflict outcome:

| door | residual 40P01 answers |
|---|---|
| `assignTicket` | `ALREADY_ASSIGNED` → 409 `TICKET_ALREADY_ASSIGNED` at all three controllers |
| `override()` (remove / defer / reorder / swap / reassign / split / move) | `NOT_FOUND` — the same answer its guarded writes already give a lost race |
| `assignPlants` | the summary with `assigned: 0` — the legacy shape's "vanished" gap, since it has no failure member at all and a throw reached the controller as a 500 |
| `assignBatch` | `LANE_FAILED`, unchanged — the lane committed nothing and that is what the member means |

**The shape was measured, not assumed** — the same trap `uniqueViolationModel` documents for P2002.
Under this repo's driver adapter a 40P01 arrives with **no Prisma `code` and no `meta`**; the SQLSTATE is
on `cause` alone:

```
DriverAdapterError: deadlock detected
  cause = { originalCode: '40P01', kind: 'postgres', code: '40P01', severity: 'ERROR',
            detail: 'Process N waits for ShareLock on transaction …' }
```

`P2034` is checked too, so a future driver change degrades to a recognised conflict rather than a 500.

**Retrying was considered and rejected.** #307 retries an SE once on a P2002 and
`retryOnceOnUniqueViolation` retries a whole transaction, so the precedent exists — but a retry would
have made the mapping dead code on the first deadlock and would have required lifting `assignLane`'s
accumulators into a re-runnable closure, disturbing the method this slice deliberately does not touch.
The issue asked for a mapping; a mapping is what is here.

## Tests

`test/assignment-write-path-ordering.e2e-spec.ts` (new, 5 cases). Every case drives the interleaving
explicitly through a hooked transaction client — a generalisation of
`dispatch-manual-collision-retry`'s wrapper from one delegate method to all of them, because the
ordering under test spans four tables.

**The staging trick worth reusing.** Each party opens a gate for the other and then waits on the other's
gate **with a timeout**. That is not laziness: the whole point of the fix is that the second party can
no longer *reach* the statement the first is waiting for, so a plain rendezvous (`test/support/
concurrency.ts`'s `createBarrier`) would hang once the code is correct. The timeout is what lets one
spec express both the defect and its absence — pre-fix the gate opens and the deadlock happens; post-fix
it never opens, the timeout releases the holder, it commits, and the blocked party then gets the honest
answer.

**Red first, with each defect's own signature:**

| case | before |
|---|---|
| assign-batch vs one-click on one ticket | lane `LANE_FAILED`, assigned 0, skipped `[]` |
| the one-click door's statement order | no ticket lock in the transaction at all (`indexOf` → `-1`) |
| two adds on one schedule | stop sequences `[1, 1]` |
| a residual deadlock | `OK` — the 40P01 was never mapped (and pre-fix the case cannot even be staged, because the door takes no ticket lock to stage against) |

The fifth case pins `isDeadlock` against the measured error shape and against the three things it must
**not** claim (a plain `Error`, a P2002, `null`).

The residual-deadlock case chooses its victim deterministically rather than hoping. Postgres runs its
deadlock check once per wait, `deadlock_timeout` after that wait begins — so letting the competitor
start waiting first, and pass its own check while no cycle yet exists, makes the transaction under test
the one that detects the cycle and therefore the one aborted. (`SET LOCAL deadlock_timeout` was tried
first and is not available: the `fsm` role is not a superuser.)

## Verification

- **Full backend suite: 451 spec files, 2,406 tests passed, 5 skipped, zero failures**, run as five
  foreground batches. No `SUITE INCOMPLETE` banner and no #184 worker recovery in any batch; neither
  documented flake (`dispatch-crashed-zone-recovery`, `global-guard-validation`) misbehaved this run.
- The **47-file regression surface** for this file (every spec naming `OverrideService`, `assignTicket`,
  `assign-batch` or `override(`) was run together first: 317 tests, all green — `lost-race-hygiene`
  among them, which is the issue's named pin for the #265 traps.
- `npx tsc --noEmit` clean. `tsconfig.test.json` reports **158** pre-existing errors in files this slice
  does not touch; measured with the new spec removed and again with it present, the count is identical,
  so this slice adds none. (The #325 handoff recorded 157; the discrepancy is in the pre-existing set,
  not in this change.)
- `apps/admin` is untouched by this issue — no API shape changed, no new outcome member exists.

## What this does not do

- **It does not make the ordering total across the repo.** The two residues above are named, mapped, and
  left: making the dispatch run take `tickets` before `work_schedules` is a change to
  `batch-assignment.service.ts`, outside this issue's stated boundary, and giving cross-schedule moves an
  order means picking one by schedule id in `moveTickets`/`swapSe` — worth doing, not worth smuggling
  into a P3 hygiene slice. Filed as a follow-up in INDEX.md.
- **It adds no migration and no index.** See the probe section above for why the permitted unique index
  is the wrong instrument.
- **It changes no API shape, no outcome union and no reorder semantics.** The only observable change
  outside a race is the reorder audit row's `stopSequence` metadata, stated above.
