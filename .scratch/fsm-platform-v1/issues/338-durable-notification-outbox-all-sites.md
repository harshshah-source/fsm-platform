# 338 — One durable outbox for every post-commit notify site
Status: ready-for-agent
Type: AFK
Wave: 1 · Severity: P1 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

Only the two day-plan events are outbox-fed. Twelve `notify()` sites fire after commit with no
retry row. A crash or a thrown notify loses the notice, and #325 deliberately kept the intraday
notify outside the transaction. Nothing outside the day-plan path is delivered at-least-once.

## Current code

The twelve post-commit `notify()` sites:

- `cross-zone-escalation.service.ts:300,321,339`
- `intraday-insertion.service.ts:343,465,498`
- `intraday/stranded-work-escalation.service.ts:121`
- `scheduling/bulk-unassign.service.ts:322`
- `ticketing/install-notifier.ts:52,64`
- `ticketing/recovery-notifier.ts:76,93`

Existing outbox machinery:

- `schema.prisma:2906` — `DayPlanNotificationOutbox` (day-plan events only)
- `scheduling/day-plan-notification-outbox.ts` — writer + drain
- `business-sweep-scheduler.service.ts:275-287` — the drain tick
- The #325 `inTransaction` hook on `assignTicket` — the ready-made seam for intraday

## What to build

- `schema.prisma:2906` + migration — generalise `DayPlanNotificationOutbox` → `notification_outbox`
  with `kind`, `recipientUserIds`, `payload`, keeping the existing columns (or add a sibling table
  — prefer one table)
- `scheduling/day-plan-notification-outbox.ts` — helper `queueNotification(tx, …)`; the drain
  dispatches by `kind`
- `business-sweep-scheduler.service.ts:275-287` — same tick drains the generalised table
- The 8 producer files above — each of the 12 sites enqueues inside its mutation transaction
  (intraday via the #325 `inTransaction` hook)
- Tests: `test/day-plan-notification-outbox*.e2e-spec.ts`,
  `test/notifier-adoption-wiring.e2e-spec.ts`, `test/intraday-critical-insertion.e2e-spec.ts`
- Expected behaviour: every notice is written in the same transaction as the change it announces
  and delivered at-least-once by the existing drain

## Acceptance criteria

- [ ] AC1 — each of the 12 sites enqueues inside its mutation tx (intraday via the #325
      `inTransaction` hook)
- [ ] AC2 — a notify that throws no longer aborts or half-commits the mutation
- [ ] AC3 — drain delivers, marks `sent_at`, retries to `MAX_OUTBOX_ATTEMPTS`, prunes at 30 d —
      unchanged policy
- [ ] AC4 — day-plan events keep their exact payload and tests
- [ ] AC5 — the at-most-once claim-then-deliver semantics of #264 are kept and documented

## Verification

Crash-injection e2e per producer (throw inside notify → row exists, mutation committed, next tick
delivers once); existing outbox tests green.

## UI surfaces

n/a (backend only)

## Reference

n/a

## Blocked by

— (none)

## Absorbs / supersedes

- survey ids: NOTIF-02, CZ-02
- existing issues: #140 notify half (closes into this slice when it lands; the atomicity half of
  #140 goes to 354)

## Downstream

354 (cross-zone atomic approve) and 361 (notification producers) depend on this (plan §3).
