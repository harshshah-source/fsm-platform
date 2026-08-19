# #245 — Vehicle unavailability: one open report, supersession, audited proposal → approval / override

**Done 2026-08-19.** Backend + migration + Admin — one vertical slice. Unblocks #246, which is the
slice that finally *reads* the date this one makes trustworthy.

## What was actually wrong

`vehicle_unavailability_reports` had one date column, `expected_from`, and `confirmDate` rewrote it
in place — no audit row, no history, no memory of what the SE had said. So the moment a manager
touched a report, "the date the person standing at the plant reported" was gone. There was also
nothing stopping a ticket carrying any number of OPEN reports at once, and nothing saying which one
was to be believed; `fileReport` was an unguarded `create`.

None of this mattered while nothing read the column. #246 is about to read it to defer real
dispatch, which is what turns a sloppy column into a correctness problem — and the information the
old writer destroyed is exactly the information an operator needs when a deferral turns out to be
wrong.

The schema and migration comments compounded it by asserting a behaviour that never existed: *"the
Ticket resurfaces at the expected-availability date"*. Nothing read `expected_from` at all (AC7).

## The two authority answers, and what they decided

Both were recorded on the issue before execution and were not re-litigated here.

**Q1(a) — the SE's proposed date takes effect immediately as a provisional deferral.** So
`expected_from` starts *equal to* `proposed_from` rather than sitting null until someone rules on it.
This is the difference between review that can only **change** a wait and review that can **create**
one: if the proposal had no effect until approved, a ticket would keep being dispatched to a plant
whose vehicle is provably absent, every day, until a manager got round to it. Managerial review
adjusts the date; it never un-waits a ticket into a wasted dispatch.

**Q2(a) — the latest valid in-scope managerial action supersedes, regardless of role.** No rank, no
lock. A ZM may overwrite a CSM's decision and a CSM may overwrite a ZM's; the decision columns are
last-writer-wins by design. That is why there is no per-decision history table: the row answers
"what is the return date and who last said so", and the sequence of everyone who ever said anything
is `audit_logs`, written in the same transaction as the change. Accountability comes from the trail,
not from a permission ladder. Both directions are pinned by test, because a rank would only show up
in one of them.

## Data model

Two migrations, not one. Postgres refuses to *use* an enum value added by `ALTER TYPE … ADD VALUE`
inside the transaction that added it, and the second migration both writes and indexes on
`SUPERSEDED`. Same split as `20260810120000_auto_recovery_closure_type`.

- `20260819130000_vu_status_superseded` — the enum member alone.
- `20260819130100_vu_approval_lifecycle` — `proposed_from` (backfilled from `expected_from`, then
  `NOT NULL`), the four decision columns, three CHECKs, the duplicate-OPEN normalisation, and the
  partial unique index `(ticket_id) WHERE status = 'OPEN'`.

`SUPERSEDED` exists because `RESOLVED` cannot express it. The absence did not end — it was
re-described by a newer report — and the two must stay distinguishable in a ticket's history.

The three CHECKs encode things the service could get wrong and the database should not permit: a
decision is *who + when + what* or nothing at all; `decision` is `APPROVED | OVERRIDDEN`; and an
override states a reason. All three were verified to reject their target state, by constraint name,
against a real Postgres instance in a rolled-back throwaway schema **before** the migration entered
the repo — along with the backfill and the dedup, which retired exactly the older of two competing
OPEN rows and left the newer live.

Dedup normalises to the behaviour that was already in effect: `SchedulerPreviewService.placeHold`
and the ZM queue both already picked the newest OPEN report by `createdAt desc`. Measured 0 affected
rows in the dev mirror; written to be correct anywhere rather than to be a no-op here.

## Service

`fileReport` supersedes any live report and creates the new one in one transaction (Decision 16: a
new absence is a new report). The partial unique index makes that an invariant rather than a habit;
a concurrent second filing that interleaves between the supersede and the insert loses on the index
and is replayed once, which is the correct outcome — the later filing was always meant to supersede
whatever now sits there.

`confirmDate` is gone, replaced by `approve` (authoritative date := the untouched proposal) and
`override` (authoritative date := the manager's, reason required). Both go through
`AuditService.withAudit`, so the audit row and the change commit or roll back together. Both refuse a
report that is no longer OPEN — deciding a resumed or superseded report would move a date nothing
reads any more while looking to the manager like it took effect, so that is a business 409, not a
404.

`historyForTicket` / `historyForReport` expose the supersession chain; the latter is zone-scoped like
every other manager leg, so knowing a report id is not a way around zone scope.

**AC5** wires resolution into `TroubleshootSubmissionService`: an SE submitting the form ends the
absence, on the component-unavailable path too — the SE reached the vehicle either way. The paused
SLA is deliberately **not** resumed there; pause-reason-aware resumption is #247, and guessing at it
from this writer would resume clocks paused for an entirely different reason.

## Admin

`docs/ui/desktop/v2-reference/11-vehicle-unavailability.png` is authoritative, and the issue's
Reference section was wrong to say no image existed — the second such mis-filing in this block after
#251's. The issue file has been corrected in place.

The reference had already anticipated this slice in two places, which decided the design:

- its STATUS column shows **`CONFIRMED`** beside `OPEN` and `RESUMED`, so the decision state belongs
  in the column that already exists, with who/when on its second line — not in a new column;
- `EXPECTED BACK` is a two-line cell like the rest of the table, so the authoritative date sits on
  top and the SE's original proposal beneath it whenever a manager moved it. Keeping `proposed_from`
  immutable is pointless if the disagreement is not visible.

Also built to the reference: the four KPI cards (Open / SLA Paused / Vehicle On-Trip / Resumed), the
search box, the STATUS filter, and the `N / N results` counter.

Two deliberate deviations, both recorded rather than hidden:

- **The secondary SLA clock** has no column in reference 11, but the dual clock is an Issue-28
  requirement and is manager-only. It rides as the second line of the PRIMARY SLA cell — the
  reference's own two-line idiom — rather than being dropped or given a column the reference lacks.
- **An Actions column** the reference does not show. Reference 11 is a static demo; AC8 requires
  role-scoped approve / override / resume / history. Row expansion was tried first and rejected:
  with action buttons in the row, `DataTable`'s row-level click toggle fires on every button press.

`confirm-date` answers **410 Gone**, not 404 and not a silent alias. A stale client that reads 404 as
"wrong id" retries forever; one that silently got the old unaudited behaviour would defeat the slice.
The admin client is updated in the same slice — verified no other consumer exists.

## Queue scope — a bounded display cap

The manager queue now returns every OPEN report plus the **100 most recently resolved**, because
reference 11 shows RESUMED rows and a STATUS filter defaulting to "All statuses", which an OPEN-only
query cannot express. The cap is a display bound, not a business rule, and is documented as such at
the constant: without it that tail grows without limit for the life of the zone. SUPERSEDED reports
are deliberately absent from the queue — they are history for one ticket, not work — and live in the
per-ticket history instead.

## Tests

`test/vu-approval-lifecycle.e2e-spec.ts` (9) pins AC1–AC6: supersession and the one-OPEN invariant
read back from the database, proposal/authoritative equality on arrival, both decision legs stamping
all four columns plus their audit rows, the required override reason, cross-role supersession **in
both directions**, ZM zone-clamping vs CSM global, an SE refused on their own report, submission
resolving the report, and a decision on a non-OPEN report refused.

RED was proven first: all 9 failed before the service existed. The migration could not precede its
own test, so redness for the schema came from the same run — `fileReport` failed on the new NOT NULL
column until it wrote it.

Sensitivity was then checked rather than assumed, by breaking three things one at a time and
confirming exactly one test went red each time and that 9/9 returned on restore: removing the
supersession `updateMany`; making `override` also rewrite `proposed_from`; and removing the
submission-side resolution. On the admin side the same was done for the required-reason guard and the
`CONFIRMED` derivation.

Existing specs were updated rather than left behind: the service spec's `confirmDate` test became an
override test that also asserts the proposal survives, and the controller spec now covers the 410,
the 400 on a blank reason, approve, history, resume, and the 409 on deciding a resumed report.
`scheduler-preview.e2e-spec.ts` (#251) needed `proposedFrom` in its hand-built fixture — the expected
consequence of a new NOT NULL column.

## Limitations

- Acting-as-zone is not honoured for *scope* on this surface, consistent with #251 and the rest of
  `vehicle-unavailability.controller.ts`; scope comes from claims `zone_id`. Acting attribution *does*
  reach the audit row via `@CurrentActor`, so an acted-as decision is attributable even though it is
  not separately scoped.
- The SLA is not auto-resumed when a report resolves — #247 owns that.
- Mobile is unchanged this slice; the SE's date entry and return-date read land in #246.
