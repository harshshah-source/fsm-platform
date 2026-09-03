# 354 — Cross-zone approve is atomic and the target zone is told

**Done 2026-09-03.** Wave 3 of the module-gaps completion plan (`docs/module-gaps/IMPLEMENTATION-PLAN.md`
§4), absorbing survey ids CZ-01, CZ-09, CZ-11 (including the corrected SCH-05), CZ-13, and closing
**#139**, **#140** and the cross-zone half of **#331**. Red-first.

## What it closes

**An approval was two transactions, and the retry that should have repaired it could not.**
`approve` committed the Formal Assignment in `assignTicket`'s own transaction and then updated the
escalation in another. A crash in the gap left a Platinum ticket assigned to a target-zone engineer
beside an escalation still reading PENDING — the queue and the schedule disagreeing, permanently,
because the retry hit the assignment it had itself made and returned `ALREADY_ASSIGNED` for ever
(#139). Both halves now live in one transaction, and the conflict that is really *this door's own
earlier attempt* reconciles instead of refusing.

**One bad ticket abandoned a whole zone's sweep** (#140). `sweepAutoEscalations` had no per-ticket
catch: the first ticket that could not be escalated took every ticket behind it down with it, on a
scheduled tick nobody watches.

**The zone that had to do the work was never told** (CZ-11). Approving put a ticket on a target-zone
engineer's Day Plan and notified the *home* ZM — the manager losing the work, not the one doing it —
and `listForScope` scoped a ZM by `homeZoneId` alone, so the receiving zone's queue showed nothing at
all. §1's correction holds: the target **SE** was already told (`override.service.ts:850`); the target
**ZM** was the one nobody told.

**A vacant ZM chair silently dropped notices** (CZ-09). `notifyHomeZm` read
`zones.zonal_manager_user_id` and returned `null` when it was empty, with nothing logged.

**Three different situations were reported as one 404** (CZ-13): a missing escalation, an engineer id
that names nobody, and a ticket held to a return date all answered `ESCALATION_OR_SE_NOT_FOUND`.

## The premise the issue got wrong, and what was verified instead

The issue text (and §4) describe the sweep and the decision doors as having *no transaction*. That was
true when the survey ran and is no longer: **#338 landed first and gave every cross-zone door its own
transaction (CZ-02)**, which its own report records as decision 5 — "the earlier finding that
cross-zone's AC1 had to wait for #354 was too pessimistic". The cited line numbers no longer match
either. Verified against the working tree before building: what remained was CZ-01 (cross-service
atomicity), the missing per-ticket catch, the recipients and the read. Nothing #338 built was rebuilt.

## Decisions worth keeping

**1. The approval rides #325's `inTransaction` hook rather than opening a transaction around
`assignTicket`.** The hook runs last inside the assignment's own transaction, against ids that are
final, and a throw from it rolls the assignment back. Wrapping the call from outside was not available
— `assignTicket` opens its own `withAudit` transaction and owns a P2002 retry that must be able to
re-run the caller's write — and the hook exists for exactly this shape (#325 built it for the intraday
ledger row that *describes* an assignment). The hook may run twice under
`retryOnceOnUniqueViolation`; the outbox ids are re-assigned on each run, which is correct because the
losing attempt committed nothing.

**2. Reconciliation is keyed on the live assignment, not on anything remembered.** An
`ALREADY_ASSIGNED` whose live `batch_assignment_tickets` row (the un-removed one) names the very
engineer being approved is not a conflict: the world already holds the outcome the operator is asking
for and only the escalation row is behind. It is repaired from that row — schedule and batch ids
included — so the escalation names the batch the ticket is actually on. A *different* engineer stays a
conflict, and the outcome now carries `assignedSeId` so the caller can see who holds it.

**3. The per-ticket catch is only safe because #338 opened the transaction.** A sweep that carries on
past a failure is dangerous precisely where #140 was: the `crossZoneEscalations: { none: {} }`
predicate treats *any* escalation row as "already escalated", so a half-written one would exclude the
ticket for ever. With the whole per-ticket write in one transaction a failure leaves nothing behind,
and the next sweep finds the ticket again. The catch logs at `error` — a Platinum ticket that failed to
escalate is the one thing this sweep exists to prevent.

**4. `recipientsInRoles` lives on `NotificationService`, and the designated manager still wins.** The
resolver is role-based (`{ role, zoneId }`), takes a client so it can resolve inside the producing
transaction (#338's rows record the recipients they resolved), and logs `NO_RECIPIENT` when the role is
vacant. Cross-zone's `zoneManagers` still prefers `zones.zonal_manager_user_id` when it is set: that is
the accountable manager, and a zone that names one does not want its news fanned out to everyone who
happens to hold the role there. The role fallback is what a vacancy falls to — never a silent return.
#356 adopts the same resolver (the plan makes whichever of 354/356 lands first the one that builds it).

**5. `CROSS_ZONE_INCOMING` is its own type, not a second recipient on `CROSS_ZONE_DECISION`.** They are
different facts for different readers: the home ZM is told what happened to their request; the target
ZM is told what has landed on their zone's plan. Both are enqueued in the approval's transaction, so
neither can announce work that did not commit.

**6. The incoming arm of the read carries APPROVED rows; the outgoing arm does not.** For the home zone
a decided escalation is no longer theirs to act on, which is why the queue has always been actionable-
only. For the receiving zone the approval is not the end of the story — it is the beginning of it, and
an APPROVED row filtered out of their queue is exactly the invisibility CZ-11 names. `direction` is
`null` for a pan-India reader (CSM / Operations Head): the queue they see is every zone's, and a
direction relative to no zone would be an invention.

**7. The admin type extension is deliberate, and temporary.** `CrossZonePage.tsx` declares
`CrossZoneQueueRow = CrossZoneRow & { direction?: ... }` locally rather than widening
`api/crossZone.ts`, which this slice does not own under the parallel-run file split. The field is
optional, so an older backend still renders. #355 owns the page (and its API client) and should fold
the field into `CrossZoneRow` proper.

## What was tested, and why in that shape

**Atomicity is asserted on the mutation, never on the notice** — the same rule #338 set, and the only
assertion that can tell one transaction from two. The AC1 test injects a failing enqueue and asserts
that **the assignment rolled back too**: the ticket is still `UNASSIGNED`, there is no live batch row,
and the escalation is still PENDING. Before this slice the assignment had already committed in its own
transaction and only the escalation update rolled back — the half-done approval itself.

**AC3 needed a rig #338's shared fixture could not express.** `failingNotifyEnqueue` fails *every*
producer row, which cannot say "one bad ticket in a sweep of several". The spec adds a local
predicate-narrowed variant (fails only the notice whose `entityId` matches), so the test asserts what
#140 is actually about: the good ticket escalates, the bad one leaves *nothing* behind, and the next
sweep still finds it.

**One #338 assertion was deliberately amended.** `cross-zone-escalation.e2e-spec.ts`'s "AC1 — a failed
enqueue rolls the auto-escalation back" asserted the sweep *rejects*. With the per-ticket catch it no
longer does, by design (AC3). The property #338 was asserting is untouched and still asserted —
`escalated: 0`, no escalation row, no notice — only the rejection expectation is gone, with the reason
recorded at the site.

## Acceptance criteria

- **AC1** — met. `approve` writes APPROVED + the target ids through #325's `inTransaction` hook; the
  crash-injection test proves the assignment rolls back with them.
- **AC2** — met. `ALREADY_ASSIGNED` on the same engineer reconciles to APPROVED from the live
  assignment; a different engineer still conflicts and names the holder.
- **AC3** — met. Per-ticket try/catch with an `error` log; the failed ticket is re-swept.
- **AC4** — met. Designated ZM → the zone's ZMs by role → a logged `NO_RECIPIENT`. Never a silent
  return.
- **AC5** — met. The target ZM gets `CROSS_ZONE_INCOMING` and the row appears in their `/cross-zone`
  read with `direction: 'incoming'`, badged on the admin page.

## Tests, verbatim

New in `cross-zone-escalation.e2e-spec.ts` (`#354` block, 8): AC1 crash injection · AC2 reconcile ·
AC2 different-SE conflict · AC3 one bad ticket in a sweep · CZ-13 deferred ticket · CZ-13 unknown SE ·
AC4 role fallback · AC5 incoming notice + direction. New in `cross-zone-controller.e2e-spec.ts` (3):
`ESCALATION_NOT_FOUND`, `TARGET_ZONE_AND_SE_REQUIRED`, a `direction` on every ZM row. New admin spec
`cross-zone-incoming.test.tsx` (1).

Backend, as run: `cross-zone-escalation` + `cross-zone-controller` — 2 files, 31 passed.
Regression on the shared file this slice touched (`notification.service.ts`): `notification-service`,
`notification-outbox-generic`, `business-sweep-scheduler-wiring` — 3 files, 9 passed.
Admin: `cross-zone-incoming` + `cross-zone` — 2 files, 9 passed. `npx tsc --noEmit` (backend) and
`npx tsc -b` (admin) both exit 0.

Two runs before that green one were the documented parallel-run artifact, not regressions: the whole
controller file 401'd at login (the "two suites on one `fsm_test`" symptom the parallel brief names).
The lock script's stale check is the reason — `stat -c %Y` on the lock directory fails under Git Bash
on this box, so `age` computes as ~56 years and **every** waiter breaks the lock it is waiting on.
Worked around by waiting for the lock directory to disappear before invoking the script. Worth fixing
in `.scratch/locks/backend-test.sh` (not this slice's file).

One real failure was found and fixed by those runs: this file's `afterAll` teardown now exceeds the
default 10s hook budget (a second plant, a second SE, and the approve tests' schedules), so it is given
30s explicitly.

## Follow-ups this slice does not own

- **#355** — the Cross-Zone page itself: the approve modal (five `window.prompt`s today), flag-from-
  ticket, re-escalate, deferred resurfacing, history. It should also fold `direction` into
  `api/crossZone.ts`'s `CrossZoneRow` and retire the local type extension.
- **#356** — adopts `recipientsInRoles` for the intraday/stranded-work recipients.
- **#337** — the push exit itself; the outbox still delivers to `NotificationService`.
