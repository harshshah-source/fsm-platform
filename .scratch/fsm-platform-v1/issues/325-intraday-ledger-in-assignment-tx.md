# 325 — The intraday ledger row lands inside the assignment transaction
Status: **done** (2026-09-02) — report [`docs/progress/325-intraday-ledger-atomicity.md`](../../../docs/progress/325-intraday-ledger-atomicity.md). **Re-scoped after #298 as this issue asked, and the re-scope is stated rather than assumed:** #298 already moved the `ESCALATION_REQUIRED -> ACCEPTED` close into `assignTicket`'s transaction, so the manual door's "row stays live-looking" half cannot happen — what remained there is that #298 closes the row *without the ids*, and an ACCEPTED row carrying no `assigned_schedule_id` is a ledger entry that cannot say where the work went. The direct-assign door was untouched by #298 and needed the whole row. `assignTicket` gained a final optional `inTransaction` callback: **a callback, not an exported `tx`** — handing the transaction client outward invites a caller to re-read or re-decide inside a boundary that already carries #265's P2002 recovery, #249's deferral spend and #298's escalation close; a callback receiving only the minted ids can do one thing. It runs last (ids final, a throw rolls the assignment back) and inside `retryOnceOnUniqueViolation` (safe — the losing attempt committed nothing). Notifications stay outside, which is what makes AC2 true by construction; AC2 matters **more** after this change, because until now there was no rollback for a push to be wrong about. The crash-injection proxy throws at the top level *and* inside `$transaction` — the same spec must fail before and pass after, and the fix is exactly that the call moves between them — and leaves `updateMany` alone so #298's close is not what breaks. Not done and not RC-9: a ledger failure still aborts the rest of the zone sweep; each iteration is now atomic, which is a different question from the loop being fault-tolerant.
Type: AFK
Wave: 4 · Severity: P3 · Finding: RC-9, `audit/2026-09-01-scheduler-engine-forensics.md` §8

## Problem
The CRITICAL direct-assign writes its `intraday_insertions` row and notification **after**
`assignTicket`'s transaction commits (`intraday-insertion.service.ts:292-345`; `manualAssign`
:417-455). A crash in the gap leaves an assigned ticket with no `ASSIGNED_DIRECT` ledger row
(breaking the intraday queue's completeness and the efficiency cube's inputs); in `manualAssign`,
the `ESCALATION_REQUIRED` row stays live-looking while the ticket is already assigned (mitigated
at display by #288's assignee join, not in the data).

## Root cause
Two writers, two transactions, no shared boundary.

## Affected files / symbols
`apps/backend/src/intraday/intraday-insertion.service.ts`;
`scheduling/override.service.ts` — `assignTicket` needs a seam (e.g. an in-tx callback or an
accepted `tx`), the pattern its outbox write (:656) already models.

## Intended behavior after fix
The insertion-row write (create for direct-assign; ACCEPTED stamp for manualAssign) commits
atomically with the assignment; the notification stays post-commit (outbox or after-commit —
notifications must never fire on a rolled-back assign, the existing rule).

## Implementation boundaries
Transaction boundary only; no status-machine change, no new columns. The seam on `assignTicket`
must not change any other caller's behavior (pin with existing assign suites).

## DB / API / frontend impact
None structural.

## Dependencies
Sequence with #298/#306/#310 (same `override.service.ts`). #298 (escalation-close in
`assignTicket`) makes half of this moot for the manual door — land after it and re-scope to what
remains.

## Regression risks
Widening `assignTicket`'s tx must not lengthen it materially (the RC-8 window) — the insertion
write is one row.

## Tests required
Crash-injection between the two writes (throw in the seam) → both absent; happy path → both
present atomically; existing intraday suites green.

## Acceptance criteria
- [x] AC1 — no reachable state has an engine-assigned CRITICAL ticket without its ledger row.
- [x] AC2 — notifications never fire for a rolled-back assignment.

## UI surfaces
n/a.

## Reference
n/a.

## Blocked by
298 (re-scope after it), sequence with 306/310
