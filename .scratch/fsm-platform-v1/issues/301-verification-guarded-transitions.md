# 301 — Guarded status transitions in verification finalize / fraud / auto-recovery mark
Status: **done** (2026-09-02) — report [`docs/progress/301-verification-guarded-transitions.md`](../../../docs/progress/301-verification-guarded-transitions.md). The guard is **the status the caller read**, not an enumerated from-list: `escalateFraud`'s legitimate from-state is `FAILED_VERIFICATION` — written by the very `finalize` it races — so a "not terminal" guard would have broken the door's primary flow. Optimistic concurrency on the observed status cannot narrow anything (the pre-read already decided legitimacy) and makes each event's `fromState` true by construction.
Type: AFK
Wave: 2 · Severity: P2 · Finding: RC-1, `audit/2026-09-01-scheduler-engine-forensics.md` §8

## Problem

The 5-minute verification sweep can silently overwrite a concurrent fraud escalation
(`ESCALATED`) or auto-recovery close (`CLOSED_AUTO_RECOVERY`) with `CLOSED`/`FAILED_VERIFICATION`
— and vice versa. The interleavings diverge in inventory consequences (finalize-FAILED restores
van stock; auto-recovery does not), so this is state corruption, not just a wrong label.

## Root cause

`verification.service.ts:311-329` (`finalize`), `:90-115` (`escalateFraud`), `:135-155`
(`markAutoRecovery`) write `ticket` and `verificationRun` **by primary key with no status
predicate**, from a candidate set read at scan start — the exact `read → check-in-JS →
update-by-id` idiom `common/transition-or-conflict.ts:5-11` was built to eliminate (and which
sla-pause, outbox, intraday and snapshot runs already use). `markAutoRecovery`'s
`verificationRun.updateMany({ where: { outcome: null } })` is guarded; its ticket write is not.

## Affected files / symbols

- `apps/backend/src/verification/verification.service.ts` — the three ticket writes and the
  run-finalize write named above
- Read-only reference: `common/transition-or-conflict.ts` (the idiom), `common/lost-race.ts`

## Intended behavior after fix

Every ticket status write in this service is a guarded `updateMany` (or `transitionOrConflict`)
keyed on the status the caller believes it is transitioning **from** (`VERIFICATION_PENDING` for
finalize; the states `escalateFraud`/`markAutoRecovery` legitimately act on). A lost race skips
that ticket (counted/logged), rolls back its per-ticket work including inventory movements, and
never overwrites the winner. Same treatment for the `verificationRun` finalize.

## Implementation boundaries

- This slice touches `verification.service.ts` only. The auto-recovery service's own unguarded
  write is #302 (different module, different transaction).
- Do not change verification's business outcomes, inventory rules, or the sweep cadence.

## DB / API / frontend impact

None (write-path guard only; same shapes).

## Dependencies

None. Sibling of #302 (same idiom, different module) — can land in either order.

## Regression risks

- Inventory restoration must stay atomic with the ticket write it belongs to — a skipped ticket
  must skip its inventory effect too (verify the per-ticket transaction boundary before guarding).
- Guard on the *correct* from-status per method; too-narrow guards would make legitimate
  transitions (e.g. fraud on a pending ticket) start failing.

## Tests required

- Barrier-harness race (the repo's `concurrency-harness` pattern): finalize vs escalateFraud on
  one ticket → exactly one wins; loser skips; final status is the winner's; inventory reflects
  the winner only.
- Same for finalize vs markAutoRecovery, and markAutoRecovery vs finalize (both orders).
- Regression: normal finalize/fraud/auto-recovery flows byte-identical.

## Acceptance criteria

- [x] AC1 — no interleaving of the three writers can transition a ticket out of a terminal or
      escalated status. All three ticket writes are `stampOnceOrLose` on the observed status; the run
      finalize is guarded on `outcome: null`.
- [x] AC2 — a lost race is a counted skip, never a silent overwrite or a 500. The sweep counts it in
      the new `VerificationSweepResult.skipped`; the two manual doors map it to `NOT_FOUND`, the mapping
      `common/lost-race.ts` documents — no new member on either outcome union, so no contract changed.
- [x] AC3 — inventory effects always match the winning transition. The guards are the FIRST writes in
      the transaction and a loss throws, so the per-ticket transaction rolls back whole — cycle close,
      assignment retirement, event, audit row and the inventory leg. Pinned by two cases: a lost CLOSED
      leaves `PRE_VERIFICATION` unconfirmed, a lost FAILED restores no van stock.

## UI surfaces

n/a.

## Reference

n/a.

## Blocked by

— (independent)
