# 316 — Scoped invalidation: a write refetches what it touched, not the national dry-run
Status: ready-for-agent
Type: AFK
Wave: 3 · Severity: P2 · Finding: AR-5, `audit/2026-09-01-scheduler-engine-forensics.md` §7

## Problem

Every mutation's `invalidate()` bumps `version`, which drops the **whole** `useDayContext` cache
(`useDayContext.ts:90-119`): up to six `GET /schedules?date=&detail=stops` reads (pan-India
payloads for CSM/OH — the backend builds list scope from claims,
`schedules.controller.ts:533-535`) plus, whenever a future day is focused,
`GET /schedules/preview?date=` — the real recommender dry-run for **every active zone**
(`schedules.controller.ts:333-346`). Ten overrides on a focused future day run the national
dry-run ten times.

## Root cause

Invalidation has one granularity (everything) because the cache is keyed only by
`(zone, version, day)` with a global version.

## Affected files / symbols

- `apps/admin/src/pages/dispatch/console/useDayContext.ts` — per-day (and per-kind: counts vs
  projection vs summaries) invalidation keys
- `apps/admin/src/pages/dispatch/TodaysDispatchPage.tsx` — `onWriteCommitted` passing affected
  days (it already knows `movedToDate` for moves)

## Intended behavior after fix

A write invalidates: today's lifted payload (as now), plus the specific day columns it touched
(source day + target day for a move; today only for same-day actions). Untouched days keep their
cache. The projection refetches only when the focused future day was itself affected — an
explicit "Refresh projection" affordance covers operator doubt.

## Implementation boundaries

- Cache-key granularity + the affected-day plumbing only. No query-library migration, no backend
  change, no change to what any endpoint returns.
- Correctness beats economy: when the affected-day set is uncertain for an action, fall back to
  full invalidation for that action rather than guessing.

## DB / API / frontend impact

Frontend only (request volume drops; payloads unchanged).

## Dependencies

After #312 (same file — its effect-guard fix first, so this doesn't rebase over a known bug).

## Regression risks

- Stale column after an action whose affected days were under-computed — mitigate with the
  per-action fallback and RTL pins per action type.

## Tests required

- RTL per action: same-day override refetches today only; MOVE_TICKET refetches source+target
  columns; other columns render from cache (spy on fetch counts).
- Pin: focused-future projection does not refire on a today-only write.

## Acceptance criteria

- [ ] AC1 — a today-only write triggers zero non-today column reads and zero preview runs.
- [ ] AC2 — a cross-day move refreshes exactly its two columns (+ today's payload).
- [ ] AC3 — no action can leave an affected column stale (per-action pins).

## UI surfaces

Admin: Scheduler Console (existing — network behavior only).

## Reference

n/a.

## Blocked by

312
