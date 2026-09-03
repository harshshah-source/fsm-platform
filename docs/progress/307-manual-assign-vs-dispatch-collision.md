# #307 — A colliding manual assign no longer costs the SE their whole engine plan

**Landed 2026-09-02** · branch `feat/autoplant-integration` · issue
[`.scratch/fsm-platform-v1/issues/307-manual-assign-vs-dispatch-collision.md`](../../.scratch/fsm-platform-v1/issues/307-manual-assign-vs-dispatch-collision.md)
· finding RC-8, `audit/2026-09-01-scheduler-engine-forensics.md` §8

## What was wrong

A manager assigning one ticket inside a per-SE dispatch transaction's window trips the
`batch_assignment_tickets` partial unique, and a P2002 aborts its interactive transaction (#265) —
there is no catching it in place. So the SE landed in `seSkips`, and `clearFailedSeOrphans` then
retired **every** SUGGESTED row the engine had produced for them.

One ticket somebody else took discarded that engineer's entire plan for the run, and the only recovery
was a human noticing the zone card and pressing Run again. Bulk-unassign already checks the zone claim
to avoid exactly this; manual assigns deliberately do not, and making them start would put an operator
in a queue behind the engine — the inversion #258's posture rules out.

## What was built

One retry per SE, and nothing else:

```
for (let attempt = 0; ; attempt++) {
  try { … dispatchForSe … break }
  catch (e) {
    if (attempt === 0 && uniqueViolationModel(e) === 'BatchAssignmentTicket') continue;
    seSkips.push(describeSeSkip(seId, e)); break;
  }
}
```

It works without any new coordination because the idempotency re-read inside `dispatchForSe` runs in
the **new** transaction: the collided ticket is now in `alreadyAssigned`, folds out through #306's
`ticketSkips` as `ALREADY_ASSIGNED`, and the rest of the plan dispatches. `clearFailedSeOrphans` is
driven off `seSkips`, so a retried SE never reaches it and their recommendations are not retired.

The discriminator already existed — `uniqueViolationModel`, established by #262/#265 because
`e.meta.target` does not arrive under this repo's driver adapter. Scoping to it is what keeps the retry
from looping on a `WorkSchedule` conflict (which would collide identically) or on a lock timeout.

Landed after #306, as its dependency required, so the retry wraps the loop's final shape rather than
one that was about to change underneath it.

## Tests

`test/dispatch-manual-collision-retry.e2e-spec.ts` (new, 3).

**Staging the window took two corrections worth recording.**

First, the collision must commit *inside* the transaction. A hook before `$transaction` produces the
graceful path, not the one under test: the idempotency re-read folds the ticket out and no P2002 ever
happens. So the transaction client itself is wrapped and the competing insert fires immediately before
the first `batchAssignmentTicket.create`.

Second, and less obvious: **the competing write must not touch a row the open transaction already
holds.** The first draft also flipped `tickets.assignment_state` — a row #306's guarded update had just
locked — so the collision waited on the dispatch while the dispatch waited on the collision, and the
spec deadlocked against the code under test (surfacing as a 5s test timeout, not as a lock error). A
manual assign's entire *effect* on the dispatch is the `batch_assignment_tickets` unique, so the insert
alone stages it faithfully.

The collision targets whichever ticket the pending insert is about to write, read from the create's own
arguments. That makes it order-independent — the assertions read the collided ticket back out of the
summary rather than assuming a processing order — and it is what makes the retry hit a *fresh*
collision in the budget test rather than the one it already folded out.

- **AC1/AC2** — no `seSkips`, no `orphansCleared`, `tickets` one short of the plan, every other ticket
  on the SE's plan, and the collided one named once and sitting on the manager's plan only.
- **The budget is one** — a second collision exhausts it; the injection count proves exactly two
  attempts, and the skip reports `TICKET_CONFLICT` with `constraint: 'BatchAssignmentTicket'` as before.
- **AC3** — a lock timeout is skipped on the first attempt. Asserted by *counting the injections*: one,
  not two, so it is provably not retried rather than merely observed to report the right string.

Each case retires its own tickets afterwards rather than resetting them to OPEN — otherwise the
recommender folds every earlier case's tickets into the next case's plan and "the rest of the plan"
stops meaning what the assertion says.

**Red before green**: disabling the retry condition turns **2 of 3 red** (the AC1/AC2 case and the
budget case); the not-retried case stays green, which is the correct split.

## Validation

- Targeted: 3/3. Dispatch / batch-assignment / per-SE-isolation / transactional surfaces run together:
  **55 files / 281 tests green**.
- `tsc --noEmit` clean.
- Full backend suite: recorded with the dispatch chain's combined run in
  [`INDEX.md`](../../.scratch/fsm-platform-v1/INDEX.md)'s session log.

## Follow-ups

None. The manual doors are untouched, as the issue's boundary requires.
