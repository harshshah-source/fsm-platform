# 341 — Acting scope narrows every manager write door

**Done 2026-09-03.** Wave 2 of the module-gaps completion plan
(`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4), absorbing survey id AA-11 and **closing #239**, which
covered the read half of the same defect. Red-first. Depends on #339 (the gate) and #340 (the
attribution), both closed.

## What it closes

Acting was gated (#339) and recorded (#340) and still did not narrow anything a manager could **do**.
Five read controllers and the Scheduler Console's writes honoured it; **57 hand-built
`{ role: user.role, zoneId: user.zone_id }` scopes across 20 controllers** did not. And a CSM's claims
*are* pan-India, so for them that expression is not a clamp at all — it is the absence of one.

The reproduced case, from the survey: **a CSM acting in zone 2 closed a zone-1 ticket for real**
(`ticketing/tickets.controller.ts`). Every layer of the request said "acting". The one layer that
decided reach never asked.

Three admin clients made it worse from the other end: `dispatch-runs.ts`, `intradayInsertions.ts` and
`intradayUpdates.ts` hand-rolled bearer-only headers, so the acting header never reached those routes
at all. The operator saw the banner; the backend saw an ordinary pan-India CSM; nothing disagreed out
loud.

## The shape of the fix

Every one of the 57 sites now takes `@CurrentScope()` (reads and scoped writes) or `@CurrentActor()`
(writes whose service wants the actor). `resolveManagerScope` — which #339 already made the single
resolver — collapses an acting caller to `{ role: 'ZONAL_MANAGER', zoneId: actingZone }` and hands a
non-acting caller the old claims expression **verbatim**.

That verbatim fallback is what makes the conversion safe rather than merely intended: it is the reason
AC2 (a non-acting CSM keeps pan-India) and AC4 (a ZM is unchanged) hold by construction and not by
sixty careful edits.

Two local duplicates of the resolver were deleted rather than left agreeing with it:
`schedules.controller.ts`'s `scopeFor` (12 call sites — kept local by #239's author precisely because
the shared decorator had not landed) and `dispatch-runs.controller.ts`'s private `scope()`.

## Decisions worth keeping

**1. AC1 is two structural checks and one behavioural set, not sixty cases.** As written the AC asks
for "a CSM acting in zone 2 gets 403/404 for a zone-1 entity" on every manager write route. Driven
literally that needs a valid, correctly-zoned fixture per route: a fixture set larger than the slice,
which rots, and in which a route whose fixture is subtly wrong passes for the wrong reason. Worse, it
says nothing about route sixty-one — and the defect being fixed is *"somebody hand-built a scope"*,
which will happen again. So:

- `acting-scope-route-sweep.spec.ts` (structural) — no manager write route builds its scope from
  claims. Fails the moment a new one does.
- `acting-scope-write-doors.e2e-spec.ts` (behavioural) — the 403/404 actually happens, on the
  reproduced case and the two guarantees that make narrowing safe.

The sweep says nothing escapes the rule; the e2e says the rule is real. Neither alone is worth much.

**2. The sweep needed *two* independent checks, and the second one is the load-bearing half.** The
reflection sweep asks whether a handler *injects* `@CurrentScope()`/`@CurrentActor()`. That catches a
route that scopes nothing at all — and after #340 it is **not sufficient**, because a handler can
inject `@CurrentActor()` for attribution and still hand its service a claims-built scope. The
injection is real, the reach is still pan-India, and a reflection-only sweep waves it through. So the
second check pins the defect itself: **no controller contains `zoneId: user.zone_id`**, matched over
comment-stripped source. Either check alone has a blind spot the other covers, and this was found by
running the first one against the tree — not by reasoning about it.

**3. The two param-decorator factories are named functions now.** A `createParamDecorator` leaves
exactly one trace on a method — an entry in Nest's `ROUTE_ARGS_METADATA` carrying the factory itself.
Anonymous arrows are indistinguishable there, so `currentScopeFactory` / `currentActorFactory` are
named, and both decorators say why in a comment. It also improves stack traces.

**4. `intraday-insertion.fire` gained a clamp it never had.** It picked its zone as
`user.role === 'ZONAL_MANAGER' ? user.zone_id : body.zoneId` — so a CSM or Operations Head named the
zone in the body, and acting could not stop them naming a different one. It is now
`scope.zoneId ?? body.zoneId`: a caller who is clamped sweeps their own zone whatever the body says,
which was already true for a ZM and is now equally true for anyone acting. An unclamped manager still
names the zone, because that is the only way they could.

**5. Thirteen routes are allowlisted, each with a reason, and the allowlist is checked from both
ends.** Pan-India jobs (AutoPlant sync, snapshots), the five report recomputes (a zone-scoped
recompute leaves the table half-current, which is worse than not running it), the cross-zone sweep
(narrowing it would defeat the escalation it exists to find), OH-only bulk unassign (its target is the
body's D-gated `scope`/`zoneId` pair), Ops Explorer's `query` (a read expressed as POST, scoped by its
own dataset layer) and `confirmDate` (retired by #245 — throws 410 before reaching a service). All but
one are `@Roles('OPERATIONS_HEAD')`, a role that cannot gain reach by acting.

Two further assertions keep the list honest: **every entry must still name a real route**, and **every
entry must name a route that is still unscoped**. A stale entry is a suppression nobody is reading,
and it would silently cover the next route that takes the same name.

**6. AC3 pins the builder, not the call sites — and it pins two ways round it.** Eleven admin clients
defined their *own* local `authHeaders()` (several of which shadowed the shared import when it was
added), and others hand-rolled the bearer inline. The pin fails a client that writes
``Authorization: `Bearer ${…}` `` **or** reads `'fsm.accessToken'` directly, because catching only the
first leaves the second as the obvious way round the rule. `tokens.ts` (the store, which owns the
keys) and `client.ts` (login and `/me`, where the token is the request's subject and there is no zone
to act in) are the two named exceptions.

**7. `http.ts` needs no exception, and that is worth stating.** Its `withBearer` replaces only the
Authorization header on a 401 refresh-retry; `new Headers(init.headers)` carries `X-Acting-As-Zone`
through untouched, so a retried request is still an acting request. An implementation that rebuilt the
header set there would silently drop acting on every retry — a bug this slice would otherwise depend
on not existing.

## What was tested, and why in that shape

**The reproduced case was verified red before it was fixed**, not assumed: reverting
`tickets.controller.ts` to the claims-built scope turns the first e2e case from 404 to 200 while the
other three stay green. That is the whole defect in one assertion.

**The refusal is asserted together with the write.** A test that only checked the 404 would pass
against a door that refused everything, so the acting CSM must also *succeed* on the zone-B ticket.
And the 404 case additionally asserts the zone-A ticket is still `OPEN` — a 404 that nonetheless wrote
would be the worse bug.

**404, not 403.** The ticket is outside the caller's scope, so the door cannot see it at all. That is
the same answer a ZM has always received for another zone's ticket, and it leaks nothing about whether
the id exists.

**AC4 is asserted twice for the same reason it exists.** A ZM gets 404 for a foreign-zone ticket
with no header, and the same 404 with a header they may not use. Unchanged in both directions is the
claim; "no wider" alone would be satisfied by a regression that clamped them further.

## Acceptance criteria

- **AC1** — met. `acting-scope-route-sweep.spec.ts` (6 assertions: no unscoped manager write route, no
  claims-built scope anywhere, and four allowlist-integrity checks) plus
  `acting-scope-write-doors.e2e-spec.ts` (the reproduced zone-1/zone-2 case, red first).
- **AC2** — met. The same CSM with no header still closes a ticket in another zone.
- **AC3** — met. Every admin client authenticates through `authHeaders()`; pinned by
  `apps/admin/test/acting-header-builder.test.ts`, which fails both ways round the rule.
- **AC4** — met. A ZM's reach is identical before and after, with and without a header.

## Tests, verbatim

New: `test/acting-scope-route-sweep.spec.ts` (6), `test/acting-scope-write-doors.e2e-spec.ts` (4),
`apps/admin/test/acting-header-builder.test.ts` (3) — **13 tests**. The sweep was red first with the
full target set (21 write routes, 20 controller files); the e2e's first case was verified red by
reverting the single line it fixes.

**Full backend suite → 465 files / 2503 tests: 460 passed, 3 skipped, ZERO failures** — a clean run
covering #339, #340 and #341 together, on a conversion that touched twenty controllers. Worth stating
plainly, because the risk of a mechanical change at that spread is a silent scope regression in a door
nobody wrote a case for, and the existing per-door specs are what would have caught it.
**Full admin suite → 121 files / 841 tests, all passing.** `npx tsc -b` (admin) and
`npx tsc --noEmit` (backend) → exit 0.

## Follow-ups this slice does not own

- **#239** closes into this slice: its read half was already done, and the write half is what this
  slice built.
- **`authHeaders.ts` still reads the token key directly rather than through `tokens.ts`**, which owns
  it. Consolidating the two is a tidy-up the AC3 pin now makes visible (it is why `tokens.ts` needs a
  named exception at all), not a defect this slice created.
