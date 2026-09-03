# 357 — Verification integrity: zone-scoped fraud flags, run verdict, de-escalate, reasons

**Done 2026-09-03.** Wave 3 of the module-gaps completion plan
(`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4), absorbing survey ids V-01, V-02, V-04, V-05 (narrowed
per §1) and V-07's API half. Red-first. Depends on #336 (the seeded verification runs), closed. The
page half is **#358**, next round.

Backend-only. This slice owned `apps/backend/prisma/schema.prisma` for the round — it is the only
schema change of Round 3, held alone on purpose so no other agent's type-check saw the client swap
underneath it.

## What it closes

Verification is where the platform decides whether work actually happened. It disagreed with itself
in four ways, and every one of them was a place where two of its own records said different things
about the same event.

**1. The fraud queue had no zone.** `fraudFlags()` took no scope parameter at all, while its two
siblings in the same file — `review()` and `forTicket()` — have clamped a ZONAL_MANAGER to their own
zone since Issue 19 and #162. So a ZM opening their own fraud list was served every zone's flags.
That is a privacy leak (fraud suspicion recorded against engineers they do not manage) and, just as
badly, a queue nobody owns: the rows a ZM could see out of zone are exactly the rows `escalateFraud`
and `markAutoRecovery` 404 on, so the list showed work it then refused to let them do.

**2. A recovered failure left two permanent, contradictory ledgers.** `markAutoRecovery` stamped the
run with `updateMany({ where: { ticketId, outcome: null } })`. Once the sweep had concluded the run —
the normal case for a window that expired FAILED_VERIFICATION — that WHERE matched nothing and the
write silently did nothing. The ticket became CLOSED_AUTO_RECOVERY; the run kept saying
FAILED_VERIFICATION; both are the platform's own record of the same decision. And because
`/reports/verification-outcomes` aggregates `verification_runs`, the report published the failure.

**3. ESCALATED was a one-way door.** Nothing in the module could move a ticket back. A manager who
escalated the wrong ticket, or escalated on an anchor GPS that later turned out to be the faulty
reading, left it permanently parked in a state no sweep and no other door ever picks up — it stops
being work anyone is accountable for finishing.

**4. The one column a reviewer needs was the one place the report cannot read.** The escalation
reason went only into `audit_logs.metadata`. §1's V-05 correction is right that Ops Explorer can read
it — but the outcomes report and the review queue both aggregate `verification_runs` and neither
joins `audit_logs` by entity id, so the report could count escalations and never explain one.

**5. Mark-auto-recovery recorded no why at all.** Its sibling door `escalateFraud` has demanded a
mandatory reason since Issue 19. This one — a manager overruling the platform's verdict on whether
the work happened, which is precisely the decision an auditor comes back to — asked for nothing.

## The shape of the fix

`fraudFlags(scope)` takes `VerificationReviewScope` and clamps with the **same expression `review()`
already uses**, so "which zones may I see" has one definition in the file rather than three. The row
gained `zoneId` / `zoneName` (load-bearing now that the endpoint is scoped: a CSM reading every zone
needs to know which zone a row came from, and a ZM can be *shown* the clamp rather than asked to
trust it) and `escalationReason`.

`markAutoRecovery` now reads the latest run **before** its transaction and stamps it under
`stampOnceOrLose`, guarded on the outcome that read saw. `deescalate` is new, and guarded the same
way from the day it lands rather than retrofitted. `escalateFraud` writes the reason to
`verification_runs.escalation_reason` inside its existing transaction, beside the audit row.

`verificationOutcomes` gained an `escalations` detail array built from the same window, the same scope
filter and the same join shape as the counts beside it — so a ZM's escalation list is clamped by
construction and cannot drift from the distribution it sits next to.

## Decisions worth keeping

**1. `escalation_reason` is the LIVE verdict, not the history.** `escalate` sets it; `deescalate`
clears it. This is the decision the rest of the column's behaviour falls out of: NULL means "this
run's ticket is not under escalation" and never "escalated for an unrecorded reason", which is exactly
what a report can filter on and what makes `escalations` a work queue rather than a growing archive.
The alternative — an append-only reason kept forever — would have made the report list every ticket
ever escalated, including ones de-escalated as raised in error, and would have needed a second
predicate (a join back to ticket status) to be readable at all. The full history of both transitions
stays in `audit_logs` + `ticket_events`, where history belongs; this column is the one a reader can
reach.

**2. De-escalate returns the ticket to the state it was escalated FROM, read off `ticket_events`.**
Not to a hardcoded VERIFICATION_PENDING. The two are genuinely different: a fraud escalation is
normally raised against a run that has already concluded FAILED_VERIFICATION (that is the path
`verification-guarded-transitions` exercises), and sending that ticket back to VERIFICATION_PENDING
would invent a verification window the sweep would then re-expire — turning "undo an escalation" into
"schedule a second failure". The escalation wrote the event; the event carries the truth; the reversal
reads it. VERIFICATION_PENDING is the fallback **only** when no escalation event exists, because that
is the review state a TROUBLESHOOT ticket sits in while it is somebody's to decide.

**3. A closed ticket is refused, and refused by ONE check.** `if (ticket.status !== 'ESCALATED')` →
`NOT_ESCALATED` → 409 covers the closed ticket as a special case of "not currently escalated", rather
than a status allowlist that needs editing every time the ladder grows. Reversing *into* a closure
would have to unwind a cycle close, an inventory leg and a retired assignment — a different operation
from undoing an escalation, and one that does not get to hide inside this one.

**4. Auto-recovery restamps a `null` or `FAILED_VERIFICATION` run and nothing else.** A `CLOSED` run
is left exactly as it is: auto-recovery must never un-verify a run that genuinely passed, and
re-stamping an already-`CLOSED_AUTO_RECOVERY` run would move its `outcome_at` for no event. The
narrow set is asserted directly ("never overwrites a CLOSED verdict"), because a blanket restamp is
the obvious and wrong way to make the two ledgers agree.

**5. The run stamp needed #301's guard, not just a wider WHERE.** Widening `outcome: null` to include
FAILED would have made the two ledgers agree in the common case and start disagreeing in the raced
one instead: the run now moves on a path the 5-minute sweep also writes, so an unguarded update by
primary key lets this close overwrite a verdict the sweep reached in between. A loss rolls the whole
transaction back — better no close at all than a ticket closed against a run that says something
else, which is the exact failure this slice exists to end.

**6. The escalation detail list is capped at 200 and says so in a named constant.** A window with
hundreds of live escalations is a staffing emergency, not a paging problem, and an uncapped detail
array inside an aggregate payload is how a report becomes the slowest endpoint in the product. The cap
is named rather than buried in the SQL so the day it starts truncating is a legible fact.

## What was tested, and why in that shape

`verification-integrity.e2e-spec.ts` is new and seeds its runs **directly** rather than driving them
through the sweep. Every AC here is about what the read and transition surfaces do with a run in a
given state, not about how the run reached it — `verification-run` and `verification-staleness`
already own the sweep's arithmetic. Seeding directly is also the only way to put a fraud-flagged run
in a zone the ZM does **not** own, which is the whole of AC1: the leak cannot be demonstrated with a
same-zone row. `dev-fixture-seed.ts:250` makes the identical argument for the #336 fixtures.

The spec reads `zm.north`'s zone off the fixture user instead of assuming zone 1. The auth fixture
pins that ZM to the zone *named* "North", and which id that is depends on seed order.

AC1 is asserted twice per caller: the specific foreign row is absent, **and** every row returned
carries the caller's own zone. The first alone would pass against a list that leaked a different
zone's rows.

The ledger-agreement case lives in `verification-staleness` as well as in the new spec, starting from
the real FAILED state case (b) produces rather than a seeded one — "auto-recovery after an expiry" is
the only way the contradiction actually arises in production, so the regression is pinned where it is
born.

`verification-guarded-transitions` gained the two new race windows (the run stamp losing to a sweep
that concluded it; de-escalate losing to a ticket that moved) beside the four it already pins.

**Red was verified, not assumed.** With the two substantive fixes temporarily reverted in place —
`fraudFlags` unscoped, `restampable` back to `outcome === null` — the new spec fails exactly 3 of 17:
the ZM clamp, the FAILED restamp, and the report's auto-recovery count. AC3/AC4/AC5 are red by
construction (the route did not exist; the column did not exist).

## Where the issue's premise was right, and one place the line numbers had moved

All five findings reproduced. The cited `file:line` for the reports edit had moved — the plan says
`reports.service.ts:545-556`, and #347 landed there this morning, putting `verificationOutcomes` at
`:600-624`. The region was verified before editing and the edit stayed inside that report.

## Acceptance criteria

- [x] **AC1** — ZM gets own-zone fraud flags only; CSM/OH get all zones.
- [x] **AC2** — after mark-auto-recovery the run and the ticket agree, and the outcomes report counts
      it as auto-recovery.
- [x] **AC3** — de-escalate exists for ZM/CSM/OH, requires a reason, is audited, and is refused on a
      closed ticket.
- [x] **AC4** — the escalation reason is persisted on the run and returned by the outcomes report.
- [x] **AC5** — mark-auto-recovery without a reason → 400.

## Tests, verbatim

```
✓ test/verification-integrity.e2e-spec.ts (17 tests)
✓ test/verification-guarded-transitions.e2e-spec.ts (10 tests)
✓ test/closure-clears-assignment.e2e-spec.ts (8 tests)
✓ test/verification-run.e2e-spec.ts (8 tests)
✓ test/verification-controller.e2e-spec.ts (10 tests)
✓ test/report-mix-outcomes.e2e-spec.ts (7 tests)
✓ test/verification-staleness.e2e-spec.ts (4 tests)
✓ test/verification-review.e2e-spec.ts (4 tests)
✓ test/verification-runs-schema.e2e-spec.ts (2 tests)

 Test Files  9 passed (9)
      Tests  70 passed (70)
```

Route/contract sweeps, run separately to prove the new door complies with the acting chain:

```
✓ test/acting-scope-route-sweep.spec.ts (6 tests)
✓ test/acting-scope-write-doors.e2e-spec.ts (4 tests)
✓ test/acting-attribution.e2e-spec.ts (3 tests)
✓ test/shared-contract.e2e-spec.ts (3 tests)
✓ test/install-verification.e2e-spec.ts (9 tests)
✓ test/work-type-status-invariant.e2e-spec.ts (4 tests)
```

The red run, for the record:

```
× AC1 … a ZM sees their own zone’s fraud flag and NOT another zone’s
× AC2 … stamps the run CLOSED_AUTO_RECOVERY even when it had already FAILED
    → expected 'FAILED_VERIFICATION' to be 'CLOSED_AUTO_RECOVERY'
× AC2 … the outcomes report counts the recovered run as auto-recovery, not as a failure
 Tests  3 failed | 14 passed (17)
```

**The Prisma drift gate was not run** — it cannot run on this box (the local `fsm` role cannot
`CREATE DATABASE`). Standing operator decision: the migration is hand-written and the suite is the
gate. `prisma/drift-baseline.txt` was deliberately **not** regenerated.

## Follow-ups this slice does not own

- **#358 must send a reason with mark-auto-recovery.** `apps/admin/src/api/verification.ts:87` posts
  no body, so the admin button now gets a 400 until #358 lands. This is already inside #358's scope
  ("+`apiFraudFlags`, `apiDeescalate`, **reason on mark**") and is the deliberate, owned deferral the
  parity gate allows — the admin file is not this slice's to edit under the round's file-disjointness
  rule. #358 also consumes `fraud-flags` (now scoped, and carrying `zoneId`/`zoneName`/
  `escalationReason`), the new `POST /verification/:ticketId/deescalate`, and the report's
  `escalations` array.
- **The mark-auto-recovery reason is in `audit_logs.metadata` only**, not on the run. That matches §1's
  V-05 ruling (Ops Explorer readability is the bar for the audit path) and the AC, which asks only for
  the *escalation* reason as a column. If a future report needs to explain an auto-recovery the way it
  now explains an escalation, that is a second column and a second slice — `escalation_reason` must
  not quietly become a general-purpose verdict-reason field.
- **`apps/admin/src/api/reports.ts`'s `VerificationOutcomesReport` does not yet declare `escalations`.**
  Additive, so nothing breaks; the admin type gains it when a page reads it.
