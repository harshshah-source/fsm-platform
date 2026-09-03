# #325 — The intraday ledger row commits with the assignment it describes

**Finding:** RC-9 (`audit/2026-09-01-scheduler-engine-forensics.md` §8) · **Wave 4** · P3
**Landed:** 2026-09-02 · branch `feat/autoplant-integration`

---

## What was wrong

`IntradayInsertionService` wrote its `intraday_insertions` row **after** `assignTicket`'s transaction
had committed — the CRITICAL direct-assign created its `ASSIGNED_DIRECT` row at :318, `manualAssign`
stamped the ids at :435. Two writers, two transactions, no shared boundary.

The row is not decoration. The Intra-day Queue reads **nothing else** to know an insertion happened,
and the efficiency cube counts these rows. So a crash in the gap left an assigned CRITICAL ticket that,
to every reader of the queue, was never assigned by anybody — the SE holding work the operations view
cannot see.

## Re-scoped after #298, as the issue instructed

The issue says #298 "makes half of this moot for the manual door — land after it and re-scope to what
remains." That is right, and the re-scope is worth stating precisely rather than assumed:

- **#298 already closed the manual door's larger half.** It moved the `ESCALATION_REQUIRED → ACCEPTED`
  close *into* `assignTicket`'s transaction (`override.service.ts`, the guarded `updateMany`). The
  issue's "the `ESCALATION_REQUIRED` row stays live-looking while the ticket is already assigned" can
  no longer happen.
- **What remains on that door is narrower and still real:** #298 closes the row without the ids. An
  `ACCEPTED` row carrying no `assigned_schedule_id` is a ledger entry that cannot say where the work
  went — the queue shows a resolved escalation pointing nowhere.
- **What remains on the direct-assign door is the whole row.** There is no prior escalation row for a
  direct assign; the sweep creates one. #298 does not touch that path at all.

## The seam

`assignTicket` takes a final optional `inTransaction` callback, invoked with the ids it just minted:

```ts
export type AssignInTransaction = (
  tx: Prisma.TransactionClient,
  ids: { scheduleId: bigint; batchId: bigint },
) => Promise<void>;
```

**A callback, not an exported `tx`.** The issue offered either. Handing the transaction client outward
invites a caller to re-read or re-decide inside somebody else's boundary — and this boundary already
carries #265's P2002 recovery, #249's deferral spend and #298's escalation close, none of which want a
second opinion. A callback that receives only the ids can do one thing: write the row that goes with
this assignment.

**It runs last**, after every write the method owns, so the ids are final and a hook that throws rolls
the assignment back without anything else needing to know it might. It runs inside
`retryOnceOnUniqueViolation`, so a `WorkSchedule` race re-runs it — safely, because the losing attempt
committed nothing.

**Notifications stay outside.** `drainRows` fires only once the transaction has committed, and the SE's
own CRITICAL push is after the `assignTicket` call returns OK. That is what makes AC2 true by
construction rather than by ordering luck — and AC2 matters *more* after this change than before,
because until now there was no rollback for a push to be wrong about.

## Verification

The spec (`test/intraday-ledger-atomicity.e2e-spec.ts`, 5 cases) injects the crash with a Prisma proxy
that makes the ledger write throw **at the top level and inside `$transaction`** — the same spec has to
be able to fail before the fix and pass after, and the whole point of the fix is that the call moves
from one to the other. It targets `create`/`update` by name and deliberately leaves `updateMany` alone:
that is #298's in-transaction escalation close, and breaking it would be testing something else. Both
services are built on the interfering client, because `withAudit` opens the transaction on the
`AuditService`'s own connection.

**Red first, with the defect's exact signature on each door:**

| case | before |
|---|---|
| direct-assign, ledger write fails | ticket `FORMALLY_ASSIGNED`, **zero** `intraday_insertions` rows |
| the same, notifications | the Day Plan push had already fired (`OVERRIDDEN`) for an assignment that would now roll back |
| manualAssign, id stamp fails | ticket `FORMALLY_ASSIGNED`, row `ACCEPTED` (#298 in-tx) but `assigned_schedule_id` null |

Two control cases were green throughout and stay green — the happy path on each door, asserting not
merely that a row exists but that `assignedBatchId` equals the batch the ticket actually landed on. A
ledger row that exists beside the assignment rather than describing it would satisfy a weaker
assertion.

- **Full backend suite: 450 spec files, 2,400 tests passed, 5 skipped**, run as five foreground
  batches. The 26 specs that touch `assignTicket` / `IntradayInsertionService` / `intraday_insertions`
  were run together first, all green — that set is the real regression surface for a widened
  transaction.
- `tsc --noEmit` clean. `apps/admin` is untouched by this issue.
- Two known-flaky files behaved as documented and neither is related: `global-guard-validation`
  hit the #184 worker crash and survived every retry in one batch run, then passed on re-run (and 2×
  isolated); `dispatch-crashed-zone-recovery` failed once mid-batch and is 3× green isolated — the
  Wave-1 handoff's trap #2, unchanged.

## What this does not do

It does not widen the transaction meaningfully: the hook is one row on each door, which is what the
issue's own regression note asked for (the RC-8 window must not grow). It changes no status machine, no
column, and no other caller of `assignTicket` — the parameter defaults to `null` and the 26 specs above
pin that.

It also does not make the sweep *survive* a ledger failure. A throw still aborts
`assignCriticalForZone` for the rest of the zone, exactly as before; what changed is that the aborted
attempt now leaves nothing behind rather than an assignment nobody can see. Making the per-ticket loop
fault-tolerant is a different question from making each iteration atomic, and only the second is RC-9.
