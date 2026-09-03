# 359 — Expense voucher controls: separation of duties, atomic mark-paid, ticket match

**Done 2026-09-03.** Wave 3 of the module-gaps completion plan
(`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4), absorbing survey ids VCH-02, VCH-06 and VCH-10.
Red-first, backend and admin.

## What it closes

Three gaps on the money path, all in `vouchers.service.ts`.

**One person could clear both money gates.** `REVIEW_ROLES` includes the Operations Head, and
`markPaid` checked only `status === 'APPROVED'`. So the OH who approved a voucher could pay it, alone,
with nothing in the record saying a second pair of eyes never saw it. Reproduced live by the survey and
re-reproduced here through the HTTP surface before the fix.

**A mark-PAID batch could end half-applied and report nothing.** The loop ran one `withAudit`
transaction per voucher with no outer transaction and no catch, so a failure at voucher N left 1..N-1
PAID and threw a 500. The caller was told "the request failed"; the truth was "seventeen of your
thirty vouchers are paid and you cannot tell which".

**The activity check proved only that a ticket existed.** It never asked whether the ticket was the
claiming SE's work, or whether it was at the plant claimed — the two questions a reviewer actually
needs answered to tell a real claim from a mis-keyed or invented one.

### Where the issue's premise was wrong

The issue file (and §1 correction VCH-10) says there is "no `failed[]` channel at all". True — but it
also implies `skipped[]` did not exist. It did: `markPaid` already skipped `NOT_FOUND` and
non-APPROVED ids and returned them. What was missing was (a) the `SAME_APPROVER` case, (b) a *reason*
on each skip — the caller got `{voucherId, status}` and had to infer why — and (c) the `failed[]`
channel. The fix is the same one the plan describes; the shape is `skipped` extended, not invented.

Cited `file:line` otherwise matched the tree.

## The shape of the fix

**Separation of duties lives on the voucher, not on the role.** `markPaid` skips with `SAME_APPROVER`
when `voucher.reviewedBy === actor.userId`. The alternative — dropping `OPERATIONS_HEAD` from
`REVIEW_ROLES` — was rejected: an OH reviewing a voucher is legitimate and sometimes necessary (a ZM
is away; the queue is theirs to clear). What is not legitimate is one person clearing *both gates on
the same voucher*, and that is exactly the rule enforced, at the only place that can see both facts.
It also means the controller needed no change at all, which keeps this slice off `#343`'s ground.

**Per-row catch, deliberately, not one `$transaction` for the batch.** Each voucher is looked up,
checked, and paid inside its own audited transaction inside its own `try`/`catch`; a row that throws
lands in `failed[]` and the loop continues. Wrapping the batch in a single `$transaction` was the
other option in the plan and is the wrong trade here: this is a month's reimbursement run, and one
unpayable id — a mis-pasted uuid, a row locked by a concurrent write — must not hold back every other
engineer's money. The batch is therefore *knowingly* non-atomic, which is precisely why the outcome
had to become total: `MarkPaidOutcome` is now `{ paid[], skipped[], failed[] }` and every submitted id
appears in exactly one of them. Nothing is left to be inferred from a 500.

**The notifier is outside the failure channel.** Once the PAID row and its audit have committed, a
notifier that throws must not re-report the row as failed — the money moved either way. So the SE
notice runs after `paid.push`, in its own swallowing `try`, with a comment saying why.

**Ticket match warns; it never refuses.** `activityCheck` now joins the linked ticket to its live
assignment (`batch_assignment_tickets` rows with `removed_at IS NULL`, plus the ticket's own
`assignedSeId`, which is how RECOVERY work is assigned without a batch) and to its plant, and emits
`TICKET_NOT_ASSIGNED_TO_SE` / `TICKET_PLANT_MISMATCH`. These are review signals. Blocking submission on
them would be wrong twice over: a mis-keyed ticket id is a clerical slip, not fraud, and a claim
refused by the system does not disappear — it moves onto an untracked channel where nobody reviews it
at all. The ZM is the one who can tell the two apart, so the ZM is who gets told.

## Decisions worth keeping

**1. Only the `SAME_APPROVER` skip is audited.** `NOT_FOUND` and `NOT_APPROVED` are ordinary batch
noise — an operator pasted a stale id, or a voucher had not cleared review yet — and auditing them
would bury the one row that matters. A self-payment attempt is a *control event*: it leaves an
`VOUCHER_MARK_PAID_SKIPPED` row with `{reason: 'SAME_APPROVER', reviewedBy, paidBatchRef}` even though
nothing changed, because "who tried" is the question this control exists to answer.

**2. `warnings[]` was added beside `warning`, not instead of it.** The queue has always rendered a
single headline code. Two of the four warnings can now fire on the same row (a ticket that is neither
this SE's nor at this plant), so the list is the real answer — but `warning` stays as
`warnings[0] ?? null` so nothing that reads the old field breaks, and the admin page falls back to it
when `warnings` is absent. `ticketAssignedSeId` and `ticketPlantId` are returned alongside so the
reviewer sees *what* it was checked against, not just that a check failed.

**3. `ticketAssignedSeId` prefers the claiming SE when they are on the ticket.** A plant stop can carry
more than one assignee; showing an arbitrary co-assignee would read as "not this SE" when the SE is in
fact assigned. So the claimant wins the slot when present, and only otherwise is the first other
assignee shown.

**4. One batched ticket read per queue page.** The match needs each linked ticket's plant and live
assignment; doing that per row would turn a screenful of vouchers into N+1 round trips. The queue
gathers ids once and builds a `Map<ticketId, TicketMatchFacts>` — the same posture the old
`foundTickets` set had, widened.

**5. `failed[].reason` keeps Prisma's *last* line, not its first.** Prisma frames a message with the
failing invocation and puts the actual cause at the end. The first line is `Invalid
\`this.prisma.expenseVoucher.findUnique()\` invocation in …` — useless to an Operations Head. The last
is `invalid input syntax for type uuid: "not-a-uuid"`, which is actionable. Prefixed with the error
code when there is one, truncated to 200 chars, and never the raw error object.

**6. The admin page widens the client's types locally rather than editing `api/vouchers.ts`.**
`apps/admin/src/api/vouchers.ts` is outside this slice's file ownership for this parallel cycle. The
page therefore declares a local `MarkPaidOutcome` with `reason` and `failed[]` optional — which the
client's declared return type is assignable to, so no cast is needed — and reads `warnings` through a
widened view of `activityCheck`. Tidying the client's own types is a follow-up, listed below.

**7. Skipped and failed vouchers stay selected after a batch.** Only the ids that actually moved leave
the selection. A `SAME_APPROVER` row needs handing to a second approver and a `failed` row needs a
retry; clearing the whole selection would make the operator rebuild it from a banner.

## What was tested, and why in that shape

**The 500 was reproduced before it was removed.** The batch-safety case puts the malformed id **first**
in the list, and the pre-fix run failed with the real `PrismaClientKnownRequestError` out of
`vouchers.service.ts:322` — not with a mocked throw. That is the defect verbatim: the id blew up the
whole call, and the vouchers behind it never got paid.

**"Exactly one of three" is asserted as a set identity, not as three separate contains.** The test
collects `paid ∪ skipped ∪ failed`, sorts it against the submitted ids, and checks the union has no
duplicates. A totality claim checked one array at a time would pass a bug that reported an id twice.

**Separation of duties is asserted from both sides.** The same OH approving and paying is skipped; a
*different* OH paying the same voucher succeeds. The skip alone would be satisfied by a rule that
refused everything. The test also asserts the voucher is still `APPROVED` with a null `paidAt`, and
that no SE paid-notice fired — a skip that nonetheless notified the SE they had been paid would be the
worse bug.

**Ticket match is tested against real assignment rows.** The spec seeds a second ticket with a real
`WorkSchedule` → `PlantBatchAssignment` → `BatchAssignmentTicket` chain for the claiming SE, so the
"assigned" case proves the join and not a stub. Two tickets rather than one, so the assigned and
unassigned cases do not depend on test ordering.

**AC4 is pinned explicitly.** The reject-reason gate is the control this slice sits next to and did not
touch, so `voucher-controller` asserts it directly rather than trusting that nothing moved.

**The admin leg was verified red against the pre-change page**, not merely written after it: the three
new cases fail on `HEAD`'s `VoucherReviewPage.tsx` (the `voucher-activity-warning-*` and
`voucher-markpaid-outcome` selectors do not exist there). The fourth — no warning on a matching row —
passes trivially on the old page, which is honest: it is a guard against over-flagging, not a new
surface.

## Acceptance criteria

- **AC1** — met. The reviewer of a voucher is skipped with `SAME_APPROVER`, the voucher stays
  `APPROVED`, and an `VOUCHER_MARK_PAID_SKIPPED` audit row records the attempt with its actor.
  (`voucher-service`: "skips SAME_APPROVER…"; `voucher-controller`: "separation of duties…").
- **AC2** — met. Every id lands in exactly one of `paid` / `skipped` / `failed`; a malformed id placed
  first in the batch returns 200 and does not stop the good ids being paid.
- **AC3** — met. `TICKET_NOT_ASSIGNED_TO_SE` and `TICKET_PLANT_MISMATCH` are emitted by the queue and
  rendered as flags on the row in the review queue, with the row still fully reviewable.
- **AC4** — met, and unchanged. `REJECT` / `NEEDS_CLARIFICATION` without a reason is still
  400 `REASON_REQUIRED`.

## Tests, verbatim

Backend, through the shared-DB lock:

```
/c/fsm-platform-backup/.scratch/locks/backend-test.sh npx vitest run \
  test/voucher-service.e2e-spec.ts test/voucher-controller.e2e-spec.ts test/me-vouchers-controller.e2e-spec.ts
```

- **Red first:** `voucher-service.e2e-spec.ts` → 20 tests, **7 failed | 13 passed**, including the
  raw `PrismaClientKnownRequestError` from the malformed id.
- **Green:** `voucher-service.e2e-spec.ts` (20) + `voucher-controller.e2e-spec.ts` (9) +
  `me-vouchers-controller.e2e-spec.ts` (3, unmodified — the SE-facing read, run to prove the queue
  rework did not disturb it) → **3 files / 32 tests, all passing.**

Admin (no lock needed):

```
cd apps/admin && npx vitest run test/vouchers-controls.test.tsx test/vouchers-review.test.tsx
```

- **Red first:** `vouchers-controls.test.tsx` against `HEAD`'s page → **3 failed | 1 passed**.
- **Green:** `vouchers-controls.test.tsx` (4, new) + `vouchers-review.test.tsx` (5, Issue 38,
  unmodified) → **2 files / 9 tests, all passing.**

Typecheck: `npx tsc --noEmit` (backend) and `npx tsc -b` (admin) report **no error in any file this
slice touched**. Both trees carry one pre-existing error from another slice in flight this cycle
(`scheduling/day-plan-notification-outbox.ts` and `pages/dispatch/console/AttentionBand.tsx`); neither
is voucher code.

No migration was needed, so the Prisma drift gate is not in question for this slice.

## What this slice deliberately did not build

- **VCH-08 — un-pay / payment reversal.** An open operator decision in plan §7, not an implementation
  gap. Default assumed and left in force: **no reversal**; a `PAYMENT_REVERSED` status does not exist,
  and a voucher marked PAID in error must today be handled outside the system. Building a reversal
  before the operator has said what it means for a batch already sent to Finance would be inventing a
  business rule.
- **E-17 — a finance/payroll integration seam** beyond the CSV export + mark-paid. Default assumed:
  **no seam.** This slice's job was to make mark-paid safe, not to automate it.
- **`exports.controller.ts` voucher-export audit** — owned by **#343**, untouched here.

## Follow-ups this slice does not own

- **`apps/admin/src/api/vouchers.ts` types lag the backend contract.** `apiMarkVouchersPaid` still
  declares `{paid, skipped: {voucherId, status}[]}` and `VoucherActivityCheck` still lacks `warnings`,
  `ticketAssignedSeId` and `ticketPlantId`. The page compensates locally (decision 6). Worth folding
  into whichever slice next owns that file — no behaviour depends on it.
- **The skip/fail banner is transient.** A mark-PAID batch's outcome lives in component state and is
  gone on reload. If Finance needs the record of a batch after the fact, that is a report over the
  `VOUCHER_MARKED_PAID` / `VOUCHER_MARK_PAID_SKIPPED` audit rows — which this slice makes possible but
  does not build.
- **`LoggingVoucherNotifier` is still what `vouchers.module.ts` binds** (VCH-07), so the "the SE is
  notified" copy on the review page remains aspirational. Owned by **#361**.
