# 358 — Verification review page completion
Status: ready-for-agent
Type: AFK
Wave: 3 · Severity: P2 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

The admin Verification Review page does not consume what the backend offers and misleads on stalled
windows.

- No admin client calls `fraud-flags` (`api/verification.ts`).
- The countdown prints "overdue" for windows the sweep will never expire
  (`verification-query.service.ts:206-209`; `VerificationReviewPage.tsx:31-34`), with no stall
  indicator — this is #148 slice 3.
- Mark-auto-recovery has no confirm step (`VerificationReviewPage.tsx:228`).
- There is no de-escalate control (the route arrives with #357).

## Current code

- `apps/admin/src/api/verification.ts` — no `fraud-flags` client.
- `apps/backend/src/verification/verification-query.service.ts:206-209` — countdown computed
  without a telemetry watermark / stalled state.
- `apps/admin/src/pages/verification/VerificationReviewPage.tsx:31-34` — prints "overdue";
  `:228` — mark-auto-recovery fires without confirm.

## What to build

- `verification-query.service.ts` — expose `telemetryAsOf` and `stalled` on the review payload.
- `api/verification.ts` — add `apiFraudFlags`, `apiDeescalate`; mark-auto-recovery client sends
  the reason (required by #357).
- `VerificationReviewPage.tsx`:
  - Fraud-flagged filter/tab fed from the scoped `fraud-flags` endpoint.
  - "stalled — telemetry as of …" chip in place of "overdue" when the telemetry watermark has
    not advanced.
  - Reason + confirm modal for mark-auto-recovery.
  - De-escalate action, shown only on ESCALATED rows, with reason + confirm.
- Admin tests for the page.

## Acceptance criteria
- [ ] AC1 — fraud-flagged rows come from the scoped endpoint.
- [ ] AC2 — a window whose telemetry watermark has not advanced shows "stalled", never "overdue".
- [ ] AC3 — both destructive actions (mark-auto-recovery, de-escalate) need a reason and a confirm.
- [ ] AC4 — de-escalate is visible only on ESCALATED rows.

## Verification

Admin component tests for the four ACs against a mocked client; the backend `stalled` /
`telemetryAsOf` fields covered in the verification-query e2e.

## UI surfaces

Admin: Verification Review page (modified).

## Reference

`docs/ui/desktop/v2-reference/14-verification-review.png`

## Blocked by
- #357 — verification integrity (scoped fraud flags, de-escalate route, reason on mark-auto-recovery).

## Absorbs / supersedes
- survey ids: V-03, V-06, V-07 (UI half).
- existing issues: #148 slice 3 (stall indicator) — closes into this slice when it lands.
