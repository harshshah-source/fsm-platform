# 302 — Auto-recovery close is guarded on the ticket still being OPEN
Status: **done** (2026-09-02) — report [`docs/progress/302-auto-recovery-close-status-guard.md`](../../../docs/progress/302-auto-recovery-close-status-guard.md). A skip does not consume the `maxClosures` cap (it did no work) and is not retried — whoever moved the ticket did so with better information than a scan taken minutes ago.
Type: AFK
Wave: 2 · Severity: P2 · Finding: RC-2, `audit/2026-09-01-scheduler-engine-forensics.md` §8

## Problem

Auto-recovery can close a ticket the SE just worked: a troubleshooting submission moving the
ticket to `VERIFICATION_PENDING` during a sweep pass (minutes long — per-ticket ping queries, up
to 200 closures) is stomped to `CLOSED_AUTO_RECOVERY` — violating the CONTEXT rule ("no SE
troubleshooting form may have been submitted") that the code's own comment
(`auto-recovery.service.ts:159-161`) claims the OPEN scan enforces. The same shape allows
sweep-vs-`manualClose` double closes (duplicate `ticket_events` and `audit_logs` rows). It also
makes the zombie-ingestion-run residual (forensic F6/RC-14) harmful — two concurrent pipeline
tails both reaching this unguarded write.

## Root cause

`ticketing/auto-recovery.service.ts:264-276` — `closeAsAutoRecovery` does
`tx.ticket.update({ where: { ticketId }, data: { status: 'CLOSED_AUTO_RECOVERY', … } })` with the
`status: 'OPEN'` check made only at candidate-scan time (:126-143 sweep, :218 manualClose).
The sibling `sla-pause.ts:60` uses `transitionOrConflict` for exactly this class.

## Affected files / symbols

- `apps/backend/src/ticketing/auto-recovery.service.ts` — `closeAsAutoRecovery` (:264-276), and
  the callers' handling of a skip (sweep loop, `manualClose`)

## Intended behavior after fix

The close is a guarded transition from `OPEN` (`updateMany`/`transitionOrConflict` with
`status: 'OPEN'` in the WHERE). Count 0 ⇒ the ticket changed under the sweep: skip it, count it,
write **no** event/audit/cycle updates for it (the 7-write transaction rolls back whole for that
ticket). `manualClose` maps the same loss to its existing conflict response rather than a double
close.

## Implementation boundaries

- One service. Do not change the recovery criteria, evidence rules, caps, or scan predicate.
- Verification-side guards are #301, not here.

## DB / API / frontend impact

None (guard only). `manualClose` may newly return its conflict shape in a race — an honest 409
where a silent double-close happened before.

## Dependencies

None. Sibling of #301.

## Regression risks

- The per-ticket transaction must remain all-or-nothing: a skipped close must not leave a closed
  failure cycle or a stray event (assert by row-counting in the test).

## Tests required

- Barrier race: sweep close vs troubleshoot submission — submission wins, sweep skips, ticket is
  `VERIFICATION_PENDING`, zero auto-recovery events/audit rows written for it.
- Barrier race: sweep vs `manualClose` — exactly one closure event exists.
- Regression: normal sweep pass unchanged (existing `auto-recovery*.e2e-spec` stays green).

## Acceptance criteria

- [x] AC1 — a submitted ticket can never end `CLOSED_AUTO_RECOVERY` via a race. The close is
      `stampOnceOrLose` on `status: 'OPEN'`, the first write in the seven-write transaction.
- [x] AC2 — a lost close writes nothing (no event, no audit, no cycle change). Asserted against a
      baseline of event / audit / soft-state counts taken before the pass, plus the cycle still `OPEN`.
- [x] AC3 — double-close between sweep and manualClose is impossible; the loser gets a conflict.
      Exactly one `CLOSED_AUTO_RECOVERY` event survives either ordering; `manualClose` returns its
      existing `NOT_OPEN` (409) rather than closing on top of somebody else's close.

## UI surfaces

n/a.

## Reference

n/a.

## Blocked by

— (independent)
