# 331 — Silent-degradation hygiene: ZM-notify fallback + bounded list reads
Status: done 2026-09-03 (closed into #356) - report docs/progress/356-intraday-queue-hygiene.md
Type: AFK
Wave: 4 · Severity: P3 · Findings: AR-14a/b + A4,
`audit/2026-09-01-scheduler-engine-forensics.md` §7

## Problem
1. A zone with a null/stale `zonalManagerUserId` silently kills escalation alerts —
   `intraday-insertion.service.ts:476-478` returns without alerting anyone, so "ZM notified" can
   be false with no trace (the un-FK'd reference class the report catalogs).
2. Two mutation-adjacent list reads are unbounded: `same-day-update.service.ts:104-107` loads
   every `MANUAL_ZM_UPDATE` audit row and `intraday-insertion.service.ts:462-466` every
   insertion for scope — both grow without bound.

## Root cause
Silent-return on a missing recipient; missing `take`/paging on append-only reads.

## Affected files / symbols
`apps/backend/src/intraday/intraday-insertion.service.ts` (`escalateToZm`, `listForScope`),
`apps/backend/src/scheduling/same-day-update.service.ts` (`listIntradayUpdates`).

## Intended behavior after fix
1. A missing ZM recipient is logged loudly with the zone named and falls back to the next rung
   the code can already reach (CSM/OH recipients if a fallback exists in the notification spine;
   otherwise the loud log + a counted metric is the floor — do not invent a new routing policy,
   record what exists).
2. Both reads take a bounded window (recent-first `take` with the limit stated in the response or
   a paging param) — additive, defaults preserving current consumers' expectations.

## Implementation boundaries
No FK migrations (the un-FK'd references stay a documented deferral); no new notification
channels; no UI change beyond consuming an unchanged-shape response.

## DB / API / frontend impact
API: additive paging/limit params; response shapes unchanged by default. Frontend: none
initially.

## Dependencies
None.

## Regression risks
A too-small default window hiding rows a page relies on — check both consumers' usage before
picking the default.

## Tests required
Notify: null-ZM zone → loud log + fallback/counter, never a silent return; lists: bounded query
asserted (take present), consumers' suites green.

## Acceptance criteria
- [x] AC1 — a missing ZM can no longer silently swallow an escalation alert.
- [x] AC2 — no mutation-adjacent list read is unbounded.

## UI surfaces
n/a.

## Reference
n/a.

## Blocked by
— (independent)
