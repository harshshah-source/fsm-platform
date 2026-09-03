# 341 — Acting scope narrows every manager write door
Status: done 2026-09-03 — report `docs/progress/341-acting-scope-write-doors.md`
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

- [x] AC1 — a contract test enumerates every manager write route and asserts a CSM acting in
      zone 2 gets 403/404 for a zone-1 entity — **met as two files, per the design above**: the
      enumeration is `test/acting-scope-route-sweep.spec.ts` (structural, so a route added tomorrow is
      swept without anyone listing it), the 403/404 is `test/acting-scope-write-doors.e2e-spec.ts` on
      the reproduced case (verified red by reverting the one line it fixes). The sweep needed **two**
      checks, not one: a handler can inject `@CurrentActor()` for attribution and still pass a
      claims-built scope, so "injects the decorator" is necessary and not sufficient
- [x] AC2 — the same actor with no header keeps pan-India reach (CSM/OH)
- [x] AC3 — every admin api client sends `X-Acting-As-Zone` via one builder
- [x] AC4 — no behaviour change for ZM/WM/SE

## Verification

Route-enumeration e2e (fails on any new unscoped route); admin header test.

### Finding re-verified 2026-09-03 (before building — standing instruction)

**Confirmed, and the count is exact: 57 `{ role: user.role, zoneId: user.zone_id }` sites across
exactly 20 controllers.** Worst first: `tickets` 6, `reports` 6, `verification` 4,
`vehicle-unavailability` 4, `install` 4, `schedules` 4, `intraday-updates` 4, `se-planner` 4,
`devices` 4, `intraday-insertion` 3, `engineers` 3, then `vouchers`, `component-request`,
`dispatch-runs`, `role-backup`, `warehouse-stock`, `inventory`, `leave-request`, `cross-zone`,
`audit-trail`. #340 left a `// The scope stays the caller's own — #341 owns whether acting narrows a
write door.` comment at each site it passed through; those are an index into the set, not the set.

### AC1's contract test — design decision (recorded so it is not re-derived)

**Do not try to drive 57 routes with a real zone-1 entity each.** AC1 as written ("enumerates every
manager write route and asserts a CSM acting in zone 2 gets 403/404 for a zone-1 entity") needs a
valid, correctly-zoned fixture per route; the fixture set would be larger than the slice, would rot,
and a route whose fixture was wrong would pass by accident.

Build it as the repo's existing route-sweep idiom instead — `global-guard-validation.e2e-spec.ts`'s
"sweeps the full route map" test is the precedent, including its rule that widening the allowlist must
be a *deliberate edit*:

1. **Enumerate at runtime** from the Express route stack
   (`app.getHttpAdapter().getInstance()._router.stack`), so a newly added route appears in the sweep
   without anyone remembering to list it. Normalise the `/api/v1/` dual-serve prefix away exactly as
   that test does, or a future version prefix will smuggle a route past the sweep.
2. **Filter to manager write routes** — `POST`/`PATCH`/`PUT`/`DELETE` whose `@Roles` includes CSM or
   OH (the only roles that can act).
3. **Assert each takes its scope from the proven context**, by reading Nest's `ROUTE_ARGS_METADATA`
   on the handler and checking the custom param factory is `CurrentScope`'s or `CurrentActor`'s. This
   is what actually delivers the Verification line — *fails on any new unscoped route* — and it cannot
   pass by accident the way a fixture-driven case can.
4. **Then prove the behaviour on a representative set**, including the reproduced case
   (`tickets.controller.ts:142`, a CSM acting in zone 2 closing a zone-1 ticket) and one door per
   scope shape. That is where 403/404 is asserted for real.

The static sweep is the regression barrier; the e2e set is the proof the barrier guards something
true. Either alone is weaker than both.

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
