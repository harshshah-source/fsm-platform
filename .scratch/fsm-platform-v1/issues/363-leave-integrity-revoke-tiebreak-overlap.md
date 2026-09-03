# 363 — Leave integrity: revoke, tie-break, overlap guard
Status: done 2026-09-03 — report docs/progress/363-leave-integrity-revoke-tiebreak-overlap.md
Type: AFK
Wave: 4 · Severity: P2 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

- `se-availability.service.ts:60-64, 87-94` order availability windows by `windowStart desc` with
  no tie-break, so a correction written for the same day loses to the older row — while the UI
  shows the correction on top. Reads and the recommender disagree with what the manager sees.
- There is no revoke/cancel route — `leave-request.controller.ts` has submit / list / approve /
  reject only.
- `submit` (`leave-request.service.ts:61-77`) accepts overlapping and duplicate PENDING windows.

## Current code

- `apps/backend/src/engineers/se-availability.service.ts:62,90` — `orderBy: {windowStart:'desc'}`
  with no secondary key.
- `apps/backend/src/engineers/leave-request.service.ts:61-77` — `submit` has no overlap query.
- `apps/backend/src/engineers/leave-request.controller.ts` — no revoke route.
- `apps/admin/src/api/engineers.ts`, `apps/admin/src/pages/engineers/LeaveRequestsPage.tsx` — no
  revoke control, no overlap error state.

## What to build

- `se-availability.service.ts:62,90` — `orderBy: [{windowStart:'desc'},{id:'desc'}]`.
- `leave-request.service.ts` — `revoke(id, actor, reason)` on an APPROVED request: writes an
  AVAILABLE window and audits `LEAVE_REVOKED`; overlap query against PENDING/APPROVED on submit →
  409 `OVERLAP`.
- `leave-request.controller.ts` — revoke route.
- `api/engineers.ts` — revoke client.
- `LeaveRequestsPage.tsx` — Revoke with reason; overlap error state.
- Tests: `se-availability-service`, `recommender-availability`, `leave-request-*` e2e; admin
  test.

## Acceptance criteria
- [x] AC1 — the latest write for a day wins, in both the availability reads and the recommender.
- [x] AC2 — revoke returns the day to the recommender within one run.
- [x] AC3 — an overlapping submit → 409 `OVERLAP`.
- [x] AC4 — all of the above are audited.

## Premise corrections (2026-09-03)

- The admin leave client is `apps/admin/src/api/leaveRequests.ts`, **not** `api/engineers.ts`; the
  revoke client went there and `api/engineers.ts` was not edited.
- All **three** availability reads lacked the tie-break (`listWindows` too — the one the manager sees).
- `leave_request_status` has no `REVOKED` member and the schema is #357's this round, so revoked is a
  derived status (`APPROVED` + `decision_reason`). Follow-up: add the enum member.

## Verification

`se-availability-service` and `recommender-availability` e2e for the tie-break; `leave-request-*`
e2e for revoke, overlap and audit rows; admin test for the Revoke control and error state.

## UI surfaces

Admin: Leave Requests page (modified — Revoke action, overlap error).

## Reference

`docs/ui/desktop/v2-reference/15-se-activity.png`

## Blocked by
- #343 — audit writers (`LEAVE_APPROVED` / `LEAVE_REJECTED` rows this slice's `LEAVE_REVOKED`
  sits beside).

## Absorbs / supersedes
- survey ids: ENG-G4, ENG-G6.
- existing issues: none.
