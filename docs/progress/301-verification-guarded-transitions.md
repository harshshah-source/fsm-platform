# #301 — Guarded status transitions in verification finalize / fraud / auto-recovery mark

**Landed 2026-09-02** · branch `feat/autoplant-integration` · issue
[`.scratch/fsm-platform-v1/issues/301-verification-guarded-transitions.md`](../../.scratch/fsm-platform-v1/issues/301-verification-guarded-transitions.md)
· finding RC-1, `audit/2026-09-01-scheduler-engine-forensics.md` §8

## What was wrong

Three writers in `verification.service.ts` — the 5-minute sweep's `finalize`, a manager's
`escalateFraud`, a manager's `markAutoRecovery` — each did `read → check in JS → update by primary
key`. Under READ COMMITTED that is not a state machine; it is three processes taking turns
overwriting each other's verdict, with the last writer winning regardless of what it read.

The reason this is corruption rather than a wrong label is the **inventory leg**. A
`FAILED_VERIFICATION` finalize restores the SE's van stock (the device was not repaired, so the
components go back); a `CLOSED` finalize confirms them `DEDUCTED`; an auto-recovery close does
neither. Interleave any two and the loser's inventory movement commits against the winner's status —
van stock restored on a ticket recorded as consumed, or consumption confirmed against a close that
credited nobody.

It also made the ledger lie in a quieter way: every one of these writes emits a `ticket_events` row
whose `fromState` is the status the *caller* read. With no guard, that field was free to claim a
transition the database never made.

## Root cause verified against the tree

| Claim in the issue | Verified |
|---|---|
| `finalize` writes by id, no status predicate | `tx.ticket.update({ where: { ticketId } })`, candidate set read at scan start |
| `escalateFraud` likewise | `tx.ticket.update({ where: { ticketId } })`; its pre-read has **no** status filter at all |
| `markAutoRecovery` likewise | same shape; its `verificationRun.updateMany({ where: { outcome: null } })` *was* already guarded — the ticket write beside it was not |
| the idiom exists to fix exactly this | `common/transition-or-conflict.ts`, `common/lost-race.ts`, already used by sla-pause, outbox, intraday, snapshot-run |

## What was built

Every ticket write in the file is now a guarded transition, and the guard is **the status that
caller read**, not an enumerated from-list.

That choice matters. An enumerated list would have to be right about which states each door
legitimately acts on, and `escalateFraud`'s legitimate from-state is `FAILED_VERIFICATION` — the same
`finalize` writes on the fraud path — so a "not terminal" guard would have broken the primary flow the
door exists for. Guarding on the observed status is optimistic concurrency: it cannot narrow anything,
because the pre-read already decided legitimacy, and it makes the `fromState` on the emitted event
true by construction.

- **`finalize`** — guards the run (`outcome: null`, matching the guard `markAutoRecovery` already
  had) and the ticket (`status` as the scan read it), both **first** in the transaction, so nothing
  else can commit against a verdict that lost. A loss throws `LostRaceError`, which rolls back the
  whole per-ticket transaction: cycle close, assignment retirement, event, audit row **and** the
  inventory leg.
- **`escalateFraud` / `markAutoRecovery`** — same guard; a loss maps to `NOT_FOUND`, the mapping
  `common/lost-race.ts` documents ("the row you asked me to act on is no longer the row you read" is
  the answer the caller's own pre-read would have produced a moment later). No new member on either
  outcome union, so no contract changes — only which silent overwrites become honest 404s.
- **`VerificationSweepResult.skipped`** — a counted outcome, not a log line, for the reason
  `PipelineSummary.ingestComplete` is: a sweep that declined to act on half its candidates must not
  report the same shape as one that had nothing to do.

## Tests

`test/verification-guarded-transitions.e2e-spec.ts` (new, 8).

**How the race is made deterministic.** `Promise.all([sweep(), sweep()])` only *starts* two calls
together — the second is entered when the first hits an await, and nothing makes them straddle the
write. That was not a theoretical worry: the first version of the double-sweep case used it and
**passed against the unguarded code**, which is precisely the trap `test/support/concurrency.ts`
documents. None of these methods has an injection point at the write, so rather than adding a
production seam for a test, the spec wraps the Prisma client and fires the competing write once,
immediately before the service opens its transaction — exactly the window between the candidate read
and the guarded write.

Cases: a CLOSED finalize losing to a fraud escalation (ticket, cycle, run, event and the
`PRE_VERIFICATION` inventory row all unchanged); a FAILED finalize losing to an auto-recovery close
(no van stock restored — AC3); `escalateFraud` and `markAutoRecovery` each losing cleanly (NOT_FOUND,
no event, no audit row); two overlapping sweeps closing exactly once and stamping one run outcome;
and three regression cases proving the guards narrow nothing — fraud escalation, manual auto-recovery
and an uncontended sweep all behave exactly as before, inventory included.

**Red before green**: neutering the three guards (dropping the `status` / `outcome: null` predicates,
leaving everything else) turns **5 of 8 red** — every race case — while the 3 regression cases stay
green. That split is the point: the guards are what the failures discriminate on, not the scaffolding.

## Validation

- Targeted: 8/8. Verification surfaces (9 files, 62 tests) green; verification-adjacent sweeps,
  closure, inventory-rollback and work-history (8 files, 53 tests) green.
- Full backend suite and `tsc --noEmit`: recorded with Wave 2's combined run in
  [`INDEX.md`](../../.scratch/fsm-platform-v1/INDEX.md)'s session log.

## Follow-ups

None. The sibling unguarded write in `ticketing/auto-recovery.service.ts` is #302, deliberately not
touched here — different module, different transaction, its own tests.
