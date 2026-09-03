# 297 — Work-history chart: count completions from closure events, not live batch rows
Status: **done** (2026-09-02) — report [`docs/progress/297-work-history-counts-closure-retired-rows.md`](../../../docs/progress/297-work-history-counts-closure-retired-rows.md)
Type: AFK
Wave: 1 · Severity: P1 · Finding: CB-1, `audit/2026-09-01-scheduler-engine-forensics.md` §6

## Problem

The SE mobile Home "Assigned vs Completed" work history shows completed ≈ 0 and assigned
*shrinking* as work completes — the exact inverse of reality. Every ticket the SE finishes drops
out of both series, retroactively (the #178 backfill stamped historical rows too).

## Root cause

Since #178, **every** terminal closure stamps the assignment row inside the closing transaction:
`scheduling/close-assignment.ts:42-45` sets `removedAt` + `removalReason: TICKET_RESOLVED` (called
from verification close/fail, auto-recovery, install lifecycle, recovery, non-op). The history
read (`me-tickets/me-work-history.service.ts:87`) builds `assigned(D)` from
`tickets: { where: { removedAt: null } }` and `completed(D)` (line 124) only counts a closure
event whose ticket is in that day's assigned set — so a resolved ticket is excluded from both.
The sibling live read (`me-tickets/me-tickets-query.service.ts:67`) was updated to compensate
(`removedAt: { gte: istDayStartInstant(now) }`); the history read never was.

## Affected files / symbols

- `apps/backend/src/me-tickets/me-work-history.service.ts` — `getWorkHistory` (`assigned` predicate
  :87, `completed` gate :124)
- `apps/backend/test/me-work-history.e2e-spec.ts` — the fixture at :88-89 fabricates closures with
  a bare `ticketEvent.create`, a state production can no longer produce (this is what masked the bug)
- Read-only reference (do not modify): `scheduling/close-assignment.ts`, `scheduling/removal-reason.ts`

## Intended behavior after fix

- `assigned(D)` includes rows whose `removalReason` marks **finished work**
  (`TICKET_RESOLVED`, auto-recovery's signature) — excluding only human withdrawals
  (ZM_WITHDRAWN / ZM_DEFERRED / REASSIGNED-away / PLAN_EXPIRED per the `removal-reason.ts`
  vocabulary; the module's own docblock states this split).
- `completed(D)` counts the closure event regardless of the batch row's `removedAt` state.
- Historical days render correctly without any backfill (read-side fix only).

## Implementation boundaries

- Read-side only: change the two predicates in `me-work-history.service.ts`. Do **not** touch
  `close-assignment.ts`, the recycler, or any writer. Do not add columns or migrations.
- Do not change the live day-plan read (`me-tickets-query.service.ts`) — it is already correct.

## DB / API / frontend impact

- DB: none. API: same shape, corrected numbers on `GET /me/work-history`. Frontend/mobile: no code
  change; the chart starts showing true values (numbers will jump — expected, not a regression).

## Dependencies

None. Independent; safe to land first.

## Regression risks

- Misclassifying a removal reason flips the error direction (counting withdrawn work as assigned).
  Pin each `removalReason` member's bucket explicitly in the test.
- The `removedBy IS NULL` auto-recovery signature must not be generalized to "system" (per
  SYSTEM-STATE §2.4's warning).

## Tests required

- Rewrite `me-work-history.e2e-spec.ts` to close tickets through the **real** closure writer
  (`VerificationService.finalize` or the auto-recovery path), not `ticketEvent.create`.
- New cases: resolved ticket appears in both assigned(D) and completed(D); ZM-withdrawn row
  appears in neither; PLAN_EXPIRED recycled row appears in neither; a pre-existing
  `removedAt: null` row still counts (belt and braces).

## Acceptance criteria

- [x] AC1 — an SE who is dispatched N tickets and completes M of them via troubleshoot→verification
      shows assigned = N, completed = M for that day, verified through the real closure path.
- [x] AC2 — human-withdrawn and plan-expired rows count in neither series.
- [x] AC3 — no spec in the file creates closure state with a bare `ticketEvent.create`.

## UI surfaces

Mobile: SE Home work-history chart (existing — numbers correct themselves; no layout change).
Admin: n/a.

## Reference

n/a (no layout change).

## Blocked by

— (independent)
