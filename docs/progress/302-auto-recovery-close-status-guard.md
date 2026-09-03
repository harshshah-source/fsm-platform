# #302 — Auto-recovery close is guarded on the ticket still being OPEN

**Landed 2026-09-02** · branch `feat/autoplant-integration` · issue
[`.scratch/fsm-platform-v1/issues/302-auto-recovery-close-status-guard.md`](../../.scratch/fsm-platform-v1/issues/302-auto-recovery-close-status-guard.md)
· finding RC-2, `audit/2026-09-01-scheduler-engine-forensics.md` §8

## What was wrong

`closeAsAutoRecovery` closed a ticket by primary key. The `status: 'OPEN'` check lived only in the
caller's candidate scan — which, for the sweep, ran minutes earlier: the pass makes a per-ticket ping
query for every candidate and closes up to 200 of them.

The event most likely to land in that window is the exact one the rule forbids. CONTEXT §Auto-Recovery
says auto-recovery may only fire where **no SE troubleshooting form has been submitted**, and the
service's own comment claims the OPEN scan enforces it. A scan cannot enforce anything about the
moment of the write: an SE submitting mid-pass moves the ticket to `VERIFICATION_PENDING`, and the
sweep then stamped `CLOSED_AUTO_RECOVERY` straight over the work they had just done — closing the
cycle, resolving their soft states, and detaching the ticket from their day plan.

The same shape allowed a sweep-vs-`manualClose` double close: two complete seven-write transactions
on one ticket, leaving duplicate `ticket_events` and `audit_logs` rows.

## Root cause verified against the tree

| Claim in the issue | Verified |
|---|---|
| `closeAsAutoRecovery` writes by id | `tx.ticket.update({ where: { ticketId } })`, seven writes in one transaction |
| the OPEN check is scan-time only | sweep's `findMany({ where: { status: 'OPEN', … } })`; `manualClose`'s `if (ticket.status !== 'OPEN') return 'NOT_OPEN'` before its own await |
| the sibling pattern already exists | `sla-pause.ts` uses `transitionOrConflict` for this class |

## What was built

One guard and two callers' handling of a loss.

- **`closeAsAutoRecovery`** — `stampOnceOrLose(tx.ticket, { ticketId, status: 'OPEN' }, …)` as the
  first write in the transaction. Losing throws, so all seven writes roll back together: a skipped
  close leaves no event, no audit row, no closed cycle, no resolved soft state and no detached
  day-plan row for somebody to explain later.
- **The sweep** — catches the loss, counts it in a new `AutoRecoveryResult.skipped`, logs it and
  `continue`s. It does **not** consume the `maxClosures` cap: a skip did no work, so the cap still
  measures closures. It does not retry either — whoever moved the ticket did so with better
  information than a scan taken minutes ago, and if the ticket really is still open the evidence will
  still be there next pass.
- **`manualClose`** — maps the loss to `NOT_OPEN`, its existing 409. The caller gets the same honest
  conflict its own check would have produced a moment earlier, instead of a silent second close on
  top of somebody else's.

`IntegrationSyncService`'s gated-pipeline literal (`recovered: { closed: 0, … }`, returned when #230
skips the stage) gained the new field — the one place the compiler flagged.

## Tests

`test/auto-recovery-guarded-close.e2e-spec.ts` (new, 4). The race is made deterministic the same way
#301's is: the Prisma client is wrapped so the competing write fires once, immediately before the
service opens its transaction — the window between the candidate read and the close — rather than
adding a seam to production code for a test's benefit.

- **AC1/AC2** — an SE submission mid-sweep wins: the sweep reports `closed: 0, skipped: 1`, the ticket
  is `VERIFICATION_PENDING`, and the event/audit/soft-state counts are **identical to a baseline taken
  before the pass**, with the cycle still `OPEN`.
- **AC3** — sweep vs `manualClose`: exactly one `CLOSED_AUTO_RECOVERY` event exists and it is the
  manager's (`MANUAL_AUTO_RECOVERY`), with one audit row.
- **AC3** — `manualClose` against a ticket closed under it returns `NOT_OPEN` and writes nothing.
- **Regression** — an uncontended pass closes, verifies the cycle, clears `has_open_failure_cycle`,
  and writes its event and audit row exactly once.

**Red before green**: dropping `status: 'OPEN'` from the guard turns **3 of 4 red** — every race case
— while the regression case stays green.

## Validation

- Targeted: 4/4. Auto-recovery, plan-export, recovery-criteria, integration-sync, business-sweep,
  closure and work-history surfaces (10 files, 71 tests) green.
- Full backend suite and `tsc --noEmit`: recorded with Wave 2's combined run in
  [`INDEX.md`](../../.scratch/fsm-platform-v1/INDEX.md)'s session log.

## Follow-ups

None. The verification-side guards are #301.
