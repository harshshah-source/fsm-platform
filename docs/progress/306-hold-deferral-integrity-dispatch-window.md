# #306 — Hold/deferral integrity across the dispatch window

**Landed 2026-09-02** · branch `feat/autoplant-integration` · issue
[`.scratch/fsm-platform-v1/issues/306-hold-deferral-integrity-dispatch-window.md`](../../.scratch/fsm-platform-v1/issues/306-hold-deferral-integrity-dispatch-window.md)
· findings RC-6 + RC-7, `audit/2026-09-01-scheduler-engine-forensics.md` §8

## What was wrong

One invariant — *a live deferral and a live assignment cannot coexist, and dispatch must respect
holds* — with a writer on each side, both violable, and the window between them is the one operators
actually work in: the recommender writes SUGGESTED, the preview screen is where a ZM looks at the
proposed plan, and the dispatch transaction commits minutes later.

- **RC-6, the hold side.** `placeHold` tested OPEN+UNASSIGNED with a plain read and wrote by primary
  key. A dispatch committing between the two left a hold on already-assigned work: a live batch row
  the hold does not touch, plus a `deferred_until` that silently holds the ticket out of *every*
  future run the moment it is REMOVEd back to the pool. Permanent, and invisible.
- **RC-7, the dispatch side.** The ticket write was `deferredUntil: null` with no predicate at all, so
  a hold placed in that window was erased — leaving an audit trail showing a hold placed and nothing
  recording an override. A ticket **closed** in the same window still landed on the SE's day plan and
  stayed there until the 04:00 closure recycled it.

## Policy

Taken from the existing contract as the issue instructed, not re-decided: holds win over the engine
(#251 — a hold is "a date the existing `notDeferredOn` predicate already respects"; #249 — every
manual door needs confirm+reason to break one). Dispatch therefore **skips, counted**, and never
overrides. Nothing about that reading was disputable against the code, so no escalation.

## What was built

**Hold side.** `placeHold`'s write is `stampOnceOrLose` on `{ ticketId, status: 'OPEN',
assignmentState: 'UNASSIGNED' }`. It throws rather than returning because the write lives inside
`withAudit`, which inserts the audit row *in the same transaction* — returning would commit a
permanent record of a hold that never took. The caller gets the door's existing `NOT_HOLDABLE` shape,
with status and assignment state **re-read** so the refusal names what the ticket is now rather than
what this caller last saw. No new outcome member; no contract change.

**Dispatch side, two skips, and the distinction is load-bearing.**

1. *After the claim, in JS.* The claim query now also selects the ticket's `status`,
   `assignment_state` and `deferred_until`, and an `ineligibleReason` helper partitions the claimed
   rows. This is deliberately **not** a WHERE clause on the claim: an unclaimed SUGGESTED row is never
   retired (only `clearFailedSeOrphans` sweeps them, and only for SEs whose transaction threw), so
   filtering at the claim would leave exactly the poisoned-ledger residue #126 exists to prevent.
   Claimed and skipped, the row is retired with its siblings at the end of the transaction.
2. *At the write, guarded.* That read is not locked (`FOR UPDATE OF r` names the recommendations
   alone), so it is a pre-filter, not the guarantee. The ticket update carries `status: 'OPEN'`,
   `assignmentState: 'UNASSIGNED'` and `notDeferredOn(day)` in its WHERE, and it was **moved before
   the batch-row insert** — previously the batch row went in first, so a guard failing afterwards would
   have left a row on the plan with no ticket to match it. A plant whose every ticket loses gets no
   stop and no empty batch.

`notDeferredOn(day)`, never `deferredUntil IS NULL` — the regression risk the issue names. A ticket
dispatched **on** its return day is legitimate and still has its spent deferral cleared, exactly as
`:283` always did.

`DispatchSummary.ticketSkips` reports `{ ticketId, reason }` with a four-member vocabulary
(`NOT_OPEN` / `ALREADY_ASSIGNED` / `DEFERRED` / `CHANGED_DURING_DISPATCH`). Counted rather than
logged, for the same reason `ingestComplete` and `VerificationSweepResult.skipped` are: a run that
quietly dispatched a held ticket and one with nothing held must not report the same thing.

## Tests

`test/hold-dispatch-integrity.e2e-spec.ts` (new, 5), driving the real recommender and the real
dispatch.

- **AC2** — hold placed after SUGGESTED: not dispatched, `ticketSkips` names it `DEFERRED`, the hold
  survives, the audit shows it placed and un-overridden, and the SE's *other* work still dispatches
  (one held ticket is not a failed dispatch).
- **AC3** — a ticket closed in the window is skipped `NOT_OPEN` and never reaches the plan.
- **AC1, dispatch-won ordering** — `placeHold` on an assigned ticket returns `NOT_HOLDABLE` and leaves
  no audit row.
- **AC1, the guard's own race** — the case RC-6 is actually about. `placeHold`'s check and its write
  are separated by a vehicle-report read and a transaction start, so the interference has to land *at
  the write*: a Prisma facade flips the ticket to `FORMALLY_ASSIGNED` once, immediately before
  `withAudit` opens its transaction, proving the pre-read saw OPEN/UNASSIGNED and only the WHERE can
  catch it. Both services are built on the interfering client, because `withAudit` opens the
  transaction on the AuditService's own connection. (The first draft of this case flipped the ticket
  *before* calling `placeHold`, which only re-tested the pre-read — it passed against the unguarded
  code and was rewritten.)
- **Regression** — a deferral due today still dispatches and is still cleared.

**Red before green**: reverting both guards to update-by-id turns **3 of 5 red**, one per defect
(hold erased, closed ticket planned, hold landing on assigned work); the two cases that assert
unchanged behaviour stay green.

## Validation

- Targeted: 5/5. Every dispatch / hold / deferral-touching spec run together: **81 files / 460 tests
  green**.
- `tsc --noEmit` clean.
- Full backend suite: recorded with the dispatch chain's combined run in
  [`INDEX.md`](../../.scratch/fsm-platform-v1/INDEX.md)'s session log.

## Follow-ups

None. Past-date *validation* on hold/defer inputs stays with #310, as the issue's boundary says.
