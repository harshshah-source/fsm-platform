# 359 — Expense voucher controls: separation of duties, atomic mark-paid, ticket match
Status: ready-for-agent
Type: AFK
Wave: 3 · Severity: P1 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

Three control gaps on the money path.

- `REVIEW_ROLES` includes OH (`vouchers.controller.ts:26,134-136`) and `markPaid`
  (`vouchers.service.ts:321-330`) checks only `status === 'APPROVED'`, so one OH can clear both
  money gates (approve and pay) alone. Reproduced live.
- `markPaid` loops one `withAudit` transaction per voucher with no outer transaction and no catch
  (`vouchers.service.ts:321-348`). A failure at voucher N leaves 1..N-1 PAID and throws 500. Per §1
  correction VCH-10: the batch commits partially **and throws 500** — there is no `failed[]`
  channel at all (the survey's "reports success" was wrong; the fix is the same).
- `activityCheck` (`vouchers.service.ts:469-484`) proves only that the ticket exists — not that it
  was assigned to the SE, nor that it matches the plant.

## Current code

- `apps/backend/src/vouchers/vouchers.controller.ts:26,134-136` — `REVIEW_ROLES` includes OH.
- `apps/backend/src/vouchers/vouchers.service.ts:312-348` — `markPaid`: status-only check, one
  `withAudit` tx per voucher, no outer tx, no per-row catch, no `failed[]`.
- `apps/backend/src/vouchers/vouchers.service.ts:226-233,469-484` — `activityCheck` is an
  existence check only.
- `apps/admin/src/pages/vouchers/VoucherReviewPage.tsx` — no skip/fail reasons, no ticket-match
  warnings.

## What to build

- `vouchers.service.ts:312-348` — in `markPaid`, skip a voucher with `SAME_APPROVER` when
  `reviewedBy === actor.userId` (audited). Batch handling: per-row catch returning `failed[]`
  (chosen over one `$transaction` for the batch so one bad id does not block a month's batch).
- `MarkPaidOutcome` type — `paid[] / skipped[] / failed[]`.
- `vouchers.service.ts:226-233,469-484` — `activityCheck` joins ticket → assignment SE + plant;
  emits warnings `TICKET_NOT_ASSIGNED_TO_SE` and `TICKET_PLANT_MISMATCH`. Extend
  `VoucherActivityCheck` type accordingly.
- `VoucherReviewPage.tsx` — show skip/fail reasons from the mark-paid outcome and the new warning
  labels in the review queue.
- Tests: `voucher-service`, `voucher-controller` e2e.
- Not built: VCH-08 (un-pay / reversal) — recorded as a decision item below.

## Acceptance criteria
- [ ] AC1 — the reviewer of a voucher cannot mark it paid: it is skipped with reason
      `SAME_APPROVER` and the skip is audited.
- [ ] AC2 — a batch reports every id in exactly one of `paid` / `skipped` / `failed` and never
      returns 500 on a bad id.
- [ ] AC3 — ticket-match warnings (`TICKET_NOT_ASSIGNED_TO_SE`, `TICKET_PLANT_MISMATCH`) appear in
      the review queue.
- [ ] AC4 — the reject-reason gate is unchanged.

## Verification

`voucher-service` and `voucher-controller` e2e covering the same-approver skip, the partial-batch
outcome shape (no 500), and the two warning codes; admin test for the queue labels.

## UI surfaces

Admin: Voucher Review page (modified — skip/fail reasons, warning labels).

## Reference

None in the v2 set for vouchers — the existing Voucher Review page is the authority for its own
layout; extend, do not redraw.

## Blocked by
- #336 — dev seed fixtures.

## Absorbs / supersedes
- survey ids: VCH-02, VCH-06, VCH-10 (AC corrected per §1).
- existing issues: none.

## Decisions recorded

- **VCH-08** — May a PAID voucher be reversed? Default assumed: **no reversal**; a
  `PAYMENT_REVERSED` status is not built in this slice.
- **E-17** — Is a finance/payroll seam wanted beyond the CSV export + mark-paid? Default assumed:
  **no seam**; this slice makes mark-paid safe.
