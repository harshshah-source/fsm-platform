# 312 — Day navigation no longer strands console columns in "loading"
Status: ready-for-agent
Type: AFK
Wave: 3 · Severity: P2 · Finding: CB-6, `audit/2026-09-01-scheduler-engine-forensics.md` §6

## Problem

Clicking Prev/Next while a day column's `GET /schedules?date=` is in flight discards the response
and never re-issues it: the cell shows "…" (and the projection cell "projecting…") until a write
bumps `version` or the zone changes.

## Root cause

`apps/admin/src/pages/dispatch/console/useDayContext.ts:121-184` — the counts/projection effect
keeps a per-run `let live = true` cleared on **any** dependency change (day navigation changes
`daysKey`), while the `requested` set keyed by `(gen, day)` survives those re-runs — so the
in-flight response is discarded (`if (!live…) return` at :135) and the re-run skips the day
(`requested.current.has(key)`). The summaries effect in the same file (:236-248) documents this
exact bug class and already removed its flag.

## Affected files / symbols

- `apps/admin/src/pages/dispatch/console/useDayContext.ts` — the counts/projection effect only

## Intended behavior after fix

The counts/projection effect adopts the summaries effect's own documented pattern: rely on the
`generation` + `requested` guards and drop `live` from the response guard (or clear `requested`
for keys whose responses were discarded). A response that is still for the current generation
lands regardless of intervening day navigation.

## Implementation boundaries

- One effect in one file. Do not restructure the hook, change query shapes, or touch
  invalidation semantics (AR-5/#316 owns that).

## DB / API / frontend impact

Frontend only.

## Dependencies

Sequence before/after #314/#316 (same file family) — not concurrent. No semantic dependency.

## Regression risks

- The stale-response discard for *zone* changes and `version` bumps must survive — the
  generation guard covers those; pin it.

## Tests required

- RTL: response resolving after a day-navigation still populates its column (the mid-flight
  navigation case the suites lack).
- RTL: a response from a previous zone/generation is still discarded.

## Acceptance criteria

- [ ] AC1 — no sequence of day navigation can leave a visible column permanently loading.
- [ ] AC2 — cross-zone/stale-generation responses never render.

## UI surfaces

Admin: Scheduler Console day columns (existing — behavior only).

## Reference

n/a (no layout change).

## Blocked by

— (sequence with 314/316 on the same hooks)
