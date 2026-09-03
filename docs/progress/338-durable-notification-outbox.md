# 338 — One durable outbox for every post-commit notify site

**Done 2026-09-03.** Wave 1 of the module-gaps completion plan
(`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4), absorbing survey ids NOTIF-02 and CZ-02 and the
notify half of **#140**. Red-first throughout. Seven commits:
`1f20620` (infrastructure) · `35bca9e` (intraday trio) · `543e986` (stranded work) ·
`d080433` (bulk unassign) · `806bb7a` (a wiring defect this slice found in its own part 1) ·
`deca11d` (install) · `ea155b3` (recovery) · `0001f9b` (cross-zone).

## What it closes

Twelve `notify()` sites fired **after** their transaction committed with nothing durable behind
them. Two different failures, and both were live:

- **A crash between the commit and the push lost the notice with no trace.** A CRITICAL ticket
  assigned to an engineer who is never told. A cross-zone escalation sitting PENDING in a queue no
  CSM or OH was asked to look at. A recovery ticket closed on warehouse receipt with the engineer
  never told, or flagged into the ZM decision queue with the ZM never told.
- **A *throw* in the push damaged the outcome that had already committed.** The intraday sweep
  abandoned the rest of a zone's CRITICAL tickets because one push failed; a Pan-India rebalance
  stopped partway through the zones; a Warehouse Manager who had physically received a device got a
  500 for a close that had already happened.

All twelve now write their notice **inside the transaction that makes the change**, and deliver it
post-commit off that committed row. A failed delivery is un-claimed and retried by the existing
`business-notification-outbox` sweep instead of being lost or thrown.

## The producers, and what each one's transaction was

| Producer | Sites | Transaction it enqueues in |
|---|---|---|
| `intraday-insertion.service.ts` — direct assign | 1 | #325's `inTransaction` hook on `assignTicket` |
| 〃 — the ZM's manual assign | 1 | the same hook |
| 〃 — `escalate` → `escalateToZm` | 1 | **new** — the ledger create and the alert were two bare awaits |
| `stranded-work-escalation.service.ts` | 1 | **new** — N ledger creates + one alert per zone, now one tx |
| `bulk-unassign.service.ts` | 1 | `executeZone`'s existing tx, beside the audit row |
| `install-lifecycle.service.ts` (owns `install-notifier.ts:52,64`) | 2 | `closeVerified` / `failActivation`, both existing |
| `recovery.service.ts` (owns `recovery-notifier.ts:76,93`) | 2 | `withAudit`'s tx, both doors |
| `cross-zone-escalation.service.ts` | 3 helpers, 5 callers | **new** per door (sweep, flag, decide, re-escalate, approve) |

## Decisions worth keeping

**1. Two row shapes, and the split is not cosmetic.**

`NOTIFY` rows carry a **resolved `NotifyInput`** and the drain replays `notify()`. That is right for
a site that calls `NotificationService` directly and owns no port, and it buys something specific:
recipients are resolved inside the producing transaction, so the row can answer *"who was told"*
afterwards — which a row that re-derives its recipients at delivery time cannot.

Install and recovery rows instead carry the **event**, and the drain hands it to
`InstallNotifier`/`RecoveryNotifier`. Flattening those into resolved notices would have deleted a
documented seam (#76) rather than converting a call: they have implementations, DI bindings and
their own specs, `SpineRecoveryNotifier` resolves the ZM by ticket → plant → zone, and
`RecoveryNotifier.escalatedToOh` **deliberately notifies nobody**, so it has no `NotifyInput` to
flatten to. This is also not a new pattern — `DayPlanNotifier`'s rows have been delivered through
their port since #264. The visible proof the seam survived: `install-verification` and
`business-sweep-scheduler-install` still assert through their spy `InstallNotifier` and were not
touched; the spy is now called by the post-commit drain instead of directly.

**2. `OutboxDeliverers` is a named bag, because a positional deliverer had already cost us a bug.**

Part 1 added the notify deliverer as an optional trailing constructor param, and
`business-sweep-scheduler.module.ts`'s `useFactory` stopped one argument short of it. In the running
app the retry sweep could therefore deliver day-plan events **and nothing else**: every converted
producer's row would have been claimed, thrown for want of a deliverer, un-claimed, and retried to
`MAX_OUTBOX_ATTEMPTS` before going quiet behind a `last_error` nobody reads. The post-commit drains
are exactly why it was invisible — they carry their own deliverer and succeed on the happy path, so
only a notice whose push had *already* failed would ever have reached the sweep and found the gap.
Part 1's test hand-built the service and could not see it.

Fixed in `806bb7a` with a regression test that boots the real module and runs the real tick. Then
three more deliverers would have widened the same hole, so the trailing param became one named bag
(`notify` / `install` / `recovery`); the sweep is the one drain that sees every producer's rows and
is the one place that carries all three.

**3. A missing deliverer throws; it never skips.** `drainRow` claims the row *before* delivering, so
a quiet skip would mark a notice sent that nobody sent. Throwing un-claims it for the drain that
does carry the port. (Part 1's decision, extended to the port branches.)

**4. Where there was no transaction, this slice opened one — it did not defer.** Three producers had
none: intraday's `escalate`, `StrandedWorkEscalationService`, and every cross-zone door. In each the
mutation is local (a create or update plus its audit row), so a local transaction is available and
is exactly what the gap asks for. Opening it closed AC1 for those sites here rather than parking
them.

**5. The earlier finding that cross-zone's AC1 had to wait for #354 was too pessimistic, and is
corrected.** It reasoned "there is no transaction to enqueue into". The answer was to open one —
which *is* CZ-02. What #354 still owns is **CZ-01**, untouched here: `approve` calls `assignTicket`
in its own transaction before updating the escalation, so an approval can still leave an assigned
ticket beside an un-updated escalation. That is cross-service atomicity, not a missing enqueue.
Approve's own three writes are now atomic, and the code says so at the site. `docs/module-gaps/`
plan §4 and the #354 issue should be read with this correction in hand.

**6. `stranded-work`'s atomicity is the strongest claim in the slice.** It wrote one
`ESCALATION_REQUIRED` row per stranded ticket in a bare loop and then alerted. A crash after row
three left an engineer's day half-escalated with nobody told — and **unescalatable afterwards**,
because #288's re-escalation guard reads a live escalation row as "a human already knows" and would
suppress the next availability write's attempt.

**7. Payloads are unchanged.** Every converted notice keeps the exact `NotifyInput` (or event) its
`notify()` call built, including `entityType`/`entityId`, so tap-routing and every existing consumer
are untouched. The only edit is that the intraday ids are stringified — which is what `AssignOutcome`
already handed them, and what a JSON column can hold at all.

## What was tested, and why in that shape

**Two properties per door, and they are different properties.** Every producer got both, red first:

- **Durability (AC2/AC5)** — the notifier throws. The mutation must still commit, the notice must
  survive as an unsent row carrying its `last_error`, the next drain must deliver it, and a *second*
  drain must not deliver it twice (the claim precedes the delivery).
- **Atomicity (AC1)** — the *enqueue* fails. The mutation must roll back with it. This is the only
  assertion that tells an in-transaction enqueue apart from a post-commit one that merely happens to
  write a row, and it is asserted on the mutation (ticket state, ledger row, audit row), never on the
  notice.

The crash rig is shared (`test/fixtures/outbox-crash-injection.ts`): all twelve producers are tested
for the same two properties, and a per-file copy of the proxy would let one door's rig drift from
another's while both kept passing. Its enqueue proxy deliberately fails only the rows #338 adds — a
day-plan row written in the same transaction must keep working, or the rollback under test would be
caused by the wrong write.

**One trap, recorded because it cost time twice:** `withAudit` opens its transaction on the
**`AuditService`'s own** client, so an interfering proxy handed only to the service under test never
sees the write. The recovery atomicity tests passed against unconverted code until both services
were built on the same client. #325's spec records the identical trap; the comment now names it in
`recovery-receipt-unable.e2e-spec.ts` too.

## Acceptance criteria

- **AC1** — met. All 12 sites enqueue inside their mutation transaction (intraday via #325's hook).
- **AC2** — met. Proved per door by crash injection.
- **AC3** — met, unchanged policy (part 1).
- **AC4** — met; day-plan payloads and tests untouched (part 1).
- **AC5** — met. Each door's spec drains twice and asserts one delivery.

## Tests, verbatim

New: `intraday-notification-outbox.e2e-spec.ts` (8), plus `#338` blocks in
`bulk-unassign-execute` (2), `install-verification` (3), `recovery-receipt-unable` (3),
`cross-zone-escalation` (4), `business-sweep-scheduler-wiring` (1), and part 1's
`notification-outbox-generic` (2) — 23 tests written for this slice.

Regression, as run per part: intraday neighbours 5 files/30 passed · bulk-unassign 4 files/24
passed · install 6 files/39 passed · recovery 9 files/34 passed · cross-zone 2 files/20 passed ·
outbox + notification + sweep 14 files/71 passed. `npx tsc --noEmit` exit 0 after every part.

## Follow-ups this slice does not own

- **#354** — CZ-01: `approve`'s assignment and its escalation update are still two transactions.
- **#337** — the push exit itself (FCM credentials are HITL). The outbox delivers to
  `NotificationService`; what leaves the building is that slice's problem.
- **#361** — the remaining PRD notification producers. New producers should use `queueNotification`
  inside their own transaction; there is now one pattern to copy.
