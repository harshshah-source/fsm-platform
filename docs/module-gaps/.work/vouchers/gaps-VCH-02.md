# VCH-02 — one Operations Head can approve, then pay (P4 · S3 · DANGEROUS · E4)

Hypothesis H2. Walked 2026-09-02 with `api-walk` only. No browser (parallel-walker collision ban).

## What was measured

| call | as | result | what it proves |
|---|---|---|---|
| `POST /vouchers/<uuid>/review {action:APPROVE}` | OH | **404** `VOUCHER_NOT_FOUND` | RoleGuard PASSED. The service ran its `findUnique` and only then failed on missing data. |
| `POST /vouchers/mark-paid {voucherIds:[<uuid>]}` | OH | **200** `{result:OK,paid:[],skipped:[NOT_FOUND]}` | Same principal, `markPaid()` executed. |
| `POST /vouchers/<uuid>/review` | WM | 403 | The 404 above is not a permissive server. |
| `POST /vouchers/mark-paid` | ZM | 403 | Mark-paid really is OH-only. |

One account — `ops.head@fsm.test`, `user_id 3333…` — holds **both halves of a two-person
financial control** at runtime. That is the guard overlap, and it is now `E4`, not inferred
from `REVIEW_ROLES` at `vouchers.controller.ts:26`.

The hypothesis's strongest alternative — "a guard, interceptor or seeded role policy outside
this module blocks an OH from the review route in practice" — is **dead by measurement**. There
is no such policy: the OH reached the service body.

## What is still E2, and why

The end-to-end breach (same OH approves voucher X, then pays voucher X) could not be walked,
because **no voucher can be created in this environment** — see VCH-01 / `not-walked.json`.
What remains inferred is only the last link: `vouchers.service.ts:312` `markPaid()` loads the
row and never compares `actor.userId` to `voucher.reviewedBy`, though `reviewedBy` is written
by `review()` at `:276` and sits right there on the record. The module's one self-dealing guard
is SE-only (`:252`, `actor.userId === voucher.seId`), which is exactly what you would expect if
approver-vs-payer had simply never been considered.

So: the gate is open (measured), and there is nothing behind it (read). Under policy P9 this is
the module's headline finding.

## Fix shape

Two lines in `markPaid()` — skip (or reject) any voucher whose `reviewedBy` equals the paying
actor — plus a decision the business must make, not the agent: does `OPERATIONS_HEAD` belong in
`REVIEW_ROLES` at all? Dropping it there is cleaner but changes who can clear the ZM queue when
a zone has no manager. Priced with `roles:3` for that reason.

## Residual to settle next run

With the SE fixture in place: create a voucher, approve it as OH, then mark it paid as the same
OH, and assert the second call is refused. One `api-walk` sequence, ~4 calls, ~8k TEQ.
