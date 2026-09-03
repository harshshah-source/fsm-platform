# #334 — Finishing the acquisition order: the dispatch run and the cross-schedule moves

**Finding:** forensics §8, follow-up to #327 (RC-12) · **Wave 4** · P3
**Landed:** 2026-09-03 · branch `feat/autoplant-integration`
**Issue:** [`.scratch/fsm-platform-v1/issues/334-acquisition-order-beyond-override-service.md`](../../.scratch/fsm-platform-v1/issues/334-acquisition-order-beyond-override-service.md)

---

## What was wrong

#327 gave `override.service.ts` one acquisition order —
`tickets → work_schedules → plant_batch_assignments → batch_assignment_tickets` — and named two
writers it could not bring into that order from inside its own boundary. #334 is those two.

**The dispatch run took the schedule before the tickets.** `dispatchForSe` resolved or created the
SE's `work_schedules` row and only then ran its guarded `tickets.updateMany`, per plant. That is the
documented pair inverted, so it cycles with any manual assign: the assign locks the ticket row and
then reaches for the same SE's schedule, while the run holds the schedule and waits for the ticket.
Narrow — it needs the SE's *first* schedule of the day, because an SE who already has one has nothing
to create and nothing to wait on — but the 05:00 run against a manager who is already working is
exactly that window.

**The two-schedule movers had no order at all between their two ends.** `moveTickets` and `swapSe`
took the *destination* schedule at the top (through `ensureSchedule`) and stamped the *source* at the
bottom (`flagOverridden`, and `swapSe`'s inline `workSchedule.updateMany`). "Destination first" is not
an order: run two moves in opposite directions between one pair of engineers and each holds the row the
other needs next.

Neither was a 500 — #327 maps a residual 40P01 onto each door's own conflict outcome — and that is
what made both worth fixing rather than leaving. A mapped deadlock is invisible: the operator is told
`ALREADY_ASSIGNED` or `NOT_FOUND`, which is exactly what they would be told after a *fair* race, so the
only thing they can do is click again. On the run's side the same 40P01 costs a whole day plan, arriving
as a per-SE `seSkip`.

## The decision the issue insisted on

The issue permitted either direction and required **one** recorded choice rather than two files each
deciding locally. **The dispatch run moved.**

1. **#327's order was measured and argued; this file had never stated one.** Realigning the two manual
   doors to schedule-first would have unwound the three reasons #327 picked its order — it is what the
   run already did for the ticket-vs-*batch* pair (#306), the ticket row is what every path actually
   contends on so taking it first is what makes a loser leave nothing behind, and aligning the *lane*
   the other way would have meant removing #265's `FOR UPDATE … SKIP LOCKED` re-verify, which this
   issue's own regression note forbids.
2. **It costs the run nothing.** The schedule is only needed once there is something to hang off it,
   so moving its resolution after the ticket writes changes when a row is taken, not what is written.
3. **It is one file.** The other direction touches two doors, four call sites and the re-verify.

Recorded in the `override.service.ts` order docblock (~:230), because that block is the single place
this codebase states the order — not in `batch-assignment.service.ts`, which now carries the *reason*
its own writes are shaped that way and defers to the docblock for the order itself.

**Do not read #306's comment as having settled this.** "The ticket write comes FIRST, and it is
guarded" is about ticket-vs-batch inside the plant loop; it says nothing about ticket-vs-schedule,
which sat above the loop. The two statements were consistent all along, and the schedule genuinely sat
ahead of both.

## AC1 — the run writes its tickets first

`dispatchForSe`'s `byPlant.size > 0` block is now: resolve coverage → the whole per-plant guarded ticket
pass, collecting `placedByPlant` → resolve/create the schedule → stop-number base → batches and
batch-ticket rows → outbox.

Nothing else moved. The guard's WHERE, its `CHANGED_DURING_DISPATCH` skip, the claim, the capacity read,
the advisory locks (#262/#304) and #307's one-shot P2002 retry are untouched.

**One deliberate non-change, easy to get wrong.** The schedule is still resolved on `byPlant`, **not** on
`placedByPlant`. An SE whose every claimed ticket loses its guard still ends the transaction with a
schedule, `schedules: 1` and an outbox row carrying `tickets: 0` — exactly as before. Gating the schedule
on whether anything was placed would have been a tidier outcome and a different one, and this slice is
about *when* the row is taken, not whether.

## AC2 — a transaction touching two schedules takes them ascending by id

`lockSchedulesInOrder(tx, ...ids)` dedupes, drops absents, sorts ascending and takes each row with the
existing `lockSchedule`. `ensureSchedule` gained a `peerScheduleId` parameter and calls it, so the two
ends are taken together in one place — the one place all four writers already obtain a schedule. The
movers pass `batch.scheduleId`; every other caller passes nothing and behaves identically.

Ascending id, because it is the only rule both movers can evaluate without knowing about each other: it
depends on the *pair of rows*, never on which end of *this particular move* a row sits at. Any total
order would do; this one needs no new column, no coordination and no migration.

Two edges are deliberately outside it. A destination this transaction is about to **create** contributes
nothing to lock — a row nobody else can see cannot be half of a cycle — and a concurrent insert of the
same `(se, zone, day)` still meets the partial unique, which is the collision
`retryOnceOnUniqueViolation` has always answered and not a lock-order problem. And a duplicate id (a
`SPLIT_BATCH` whose destination SE already owns the source schedule) collapses.

`flagOverridden` and `swapSe`'s inline stamp keep their own `lockSchedule` calls: re-taking a row this
transaction already holds costs nothing, and stating it there is what makes each of them correct on its
own rather than by the grace of its callers.

## The test that could see it, and why the obvious one could not

The first draft of AC1's concurrency case **passed against the unguarded code**. The deadlock happened;
`assignTicket`'s #327 mapping turned it into `ALREADY_ASSIGNED`, which is also what a fair loser gets.
Every observable — both calls fulfilled, one live batch row, one schedule, one assigned ticket — was
identical either way. Asserting "no 5xx" cannot express "cannot deadlock" in a codebase that maps 40P01
by design.

So the cycle is watched for at the statement: `watchDeadlocks(hits, hook)` in
`test/support/tx-hooks.ts` records the path of any statement whose rejection satisfies `isDeadlock` and
rethrows. Red, it names the statement that closed the cycle — `ticket.updateMany` for AC1,
`workSchedule.updateMany` for AC2 — which is also the fix's address.

`test/acquisition-order-dispatch-and-moves.e2e-spec.ts`, 4 cases, red first:

| case | red |
|---|---|
| the run takes the ticket rows before the schedule | schedule statement at index 7, first ticket write at 12 |
| manual assign concurrent with the run | `deadlocks` = `['ticket.updateMany']` |
| two opposite-direction moves | `deadlocks` = `['workSchedule.updateMany']`; one move answered `NOT_FOUND` |
| a mover locks the lower id first | locks `[7n, 7n]` — the destination, twice; the source never |

The fourth is the structural pin and runs both directions of the same pair, because "lock the
destination first" passes a one-direction test.

### Two traps worth not rediscovering

- **The park point has to be the `create`, not the `findFirst` before it.** Parking on the lookup holds
  nothing: the manual assign then commits its schedule first and the run collides on the partial unique
  — a real P2002, already answered by #307, and not the cycle under test. The first run of this spec
  staged that instead and reported `SCHEDULE_CONFLICT`.
- **A predicate built with `new RegExp('FROM\\s+' + table)` silently loses its `\s` to string
  escaping** and then never matches, so the gate never opens and the spec hangs on its own rendezvous
  rather than failing. `isRowLock` now takes a regex *literal* per table, and says why in a comment.

`hookedPrisma`, the gates and the bounded waits moved from the #327 spec to
`test/support/tx-hooks.ts` unchanged; #327's file imports them from there.

## Verification

- `test/acquisition-order-dispatch-and-moves.e2e-spec.ts` — 4/4, red first on all four.
- 26-file targeted regression surface (the two dispatch write paths, all four override doors, the stop
  ordering, `lost-race-hygiene`, the outbox writers, #327's own spec) — 104/104.
- **Full backend suite: 453 spec files, 2,418 passed, 5 skipped, zero failures**, five foreground
  batches, every batch exit 0, no `SUITE INCOMPLETE`, no #184 recovery, neither documented flake
  misbehaving.
- `npx tsc --noEmit` clean.
- **No migration**, so `prisma/drift-baseline.txt` is untouched and the drift gate is not in play.

## Acceptance criteria

- [x] **AC1** — a manual assign concurrent with the dispatch run cannot deadlock, and the recorded
      order says which of the two moved and why (`override.service.ts` order docblock: the run moved).
- [x] **AC2** — two cross-schedule moves in opposite directions cannot deadlock.

No UI or mobile ACs (`UI surfaces: n/a`), so the parity gate does not apply.

## What this does not close

`isDeadlock` stays wired at both doors. A writer neither file owns can still form a cycle, and a
destination schedule created concurrently still meets the partial unique. The mapping is the backstop;
#334 is about not reaching for it.
