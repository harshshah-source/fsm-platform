# 314 — A failed post-write refetch keeps the last-good console view
Status: ready-for-agent
Type: AFK
Wave: 3 · Severity: P2 · Finding: AR-6, `audit/2026-09-01-scheduler-engine-forensics.md` §7

## Problem

One transient network blip on the refetch **after a successful write** sets `view = null`
(`useConsoleData.ts:87-93`) and `TodaysDispatchPage.tsx:317-327` replaces the entire deck with an
error card — selection, scroll and context lost, and the successful write looks failed.

## Root cause

The error path was justified for the zone-switch case ("the zone is cleared on failure") but
applies equally to routine invalidations.

## Affected files / symbols

- `apps/admin/src/pages/dispatch/console/useConsoleData.ts` — error handling in the fetch/
  invalidate path
- `apps/admin/src/pages/dispatch/TodaysDispatchPage.tsx` — stale-banner rendering

## Intended behavior after fix

- An invalidation/refetch failure over an existing view keeps the last-good view and shows a
  non-blocking stale banner ("couldn't refresh — showing data from HH:MM, retry"), with a manual
  retry affordance.
- A failure with **no** prior view (first load, zone switch) keeps today's error card — that case
  is correct.

## Implementation boundaries

- Presentation of failure only; no polling, no retry loops, no cache redesign (AR-5/#316 is
  separate).

## DB / API / frontend impact

Frontend only.

## Dependencies

Sequence with #312/#316 (same hook family).

## Regression risks

- The stale banner must not mask a genuinely wrong zone (zone switch must still clear —
  pin both paths).

## Tests required

- RTL: successful write → failed refetch → board still renders pre-write data + banner; retry
  refetches; zone-switch failure still shows the error card.

## Acceptance criteria

- [ ] AC1 — no transient refetch failure can blank a previously-rendered deck.
- [ ] AC2 — staleness is stated, with retry; zone-switch semantics unchanged.

## UI surfaces

Admin: Scheduler Console (existing — one banner state added).

## Reference

The built page is the authority.

## Blocked by

— (sequence with 312/316)
