# 341 — Acting scope narrows every manager write door
Status: ready-for-agent
Type: AFK
Wave: 2 · Severity: P1 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

Acting narrows five read controllers and the Scheduler Console writes
(`schedules.controller.ts:81-85 scopeFor`, `batches.controller.ts:113`), but ~60 hand-built
`{ role: user.role, zoneId: user.zone_id }` sites across 20 controllers stay pan-India — a CSM
acting in zone 2 closed a zone-1 ticket for real (`ticketing/tickets.controller.ts:142`). Admin
clients `dispatch-runs.ts`, `intradayInsertions.ts`, `intradayUpdates.ts` build bearer-only headers,
so the acting header never reaches those routes.

## Current code

- `schedules.controller.ts:81-85` (`scopeFor`) and `batches.controller.ts:113` — the only writes
  that honour acting today
- ~60 hand-built `{ role: user.role, zoneId: user.zone_id }` sites across 20 controllers — pan-India
  regardless of the acting header
- `ticketing/tickets.controller.ts:142` — the reproduced case (CSM acting in zone 2 closed a zone-1
  ticket)
- Admin `apps/admin/src/api/dispatch-runs.ts`, `intradayInsertions.ts`, `intradayUpdates.ts` —
  bearer-only headers, no `X-Acting-As-Zone`

## What to build

- Each of the 20 controllers (ticketing, intraday, engineers/leave, install,
  vehicle-unavailability, verification, vouchers, planner, cross-zone, devices) → `@CurrentScope()`
  for reads / `@CurrentActor()` for writes
- `apps/admin/src/api/*` → one `authHeaders()` builder that sends `X-Acting-As-Zone`
- Tests per controller + `apps/admin/test/acting-zone-scope.test.tsx`
- Expected behaviour: acting narrows; narrowing a write can only reduce reach (the rule already
  recorded on #239)

## Acceptance criteria

- [ ] AC1 — a contract test enumerates every manager write route and asserts a CSM acting in
      zone 2 gets 403/404 for a zone-1 entity
- [ ] AC2 — the same actor with no header keeps pan-India reach (CSM/OH)
- [ ] AC3 — every admin api client sends `X-Acting-As-Zone` via one builder
- [ ] AC4 — no behaviour change for ZM/WM/SE

## Verification

Route-enumeration e2e (fails on any new unscoped route); admin header test.

## UI surfaces

n/a (admin API clients only; no page layout changes)

## Reference

n/a

## Blocked by

- #339 (acting-scope gate — `request.acting` is the source the decorators read)
- #340 (acting attribution — the 11 null sites move to `@CurrentActor()` first)

## Absorbs / supersedes

- survey ids: AA-11
- existing issues: **#239** — this slice widens #239 (which covered reads) to every manager write
  door; close #239 into this slice when it lands
