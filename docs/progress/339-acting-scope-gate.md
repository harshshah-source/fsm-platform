# 339 — Acting-scope gate, manager-unavailability windows, audited enter/exit

**Done 2026-09-03.** Wave 1 of the module-gaps completion plan
(`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4), absorbing survey ids AA-01, AA-05, AA-07, AA-08 and
AA-09. Red-first. One commit: `a1270ad` (marked WIP for the reason under
**"Four files that are deliberately not in the commit"** below — the code is complete).

## What it closes

`X-Acting-As-Zone` was a **parse**, not a gate. `resolveActingContext` granted acting to any Central
Service Manager or Operations Head whose header contained a number, and three things followed from
that:

- **`role_unavailability` was never consulted.** CONTEXT.md §15's entire backup cascade lived in
  `RoleBackupService.currentActingRoleForZone` with **no callers**. A CSM could act as any zone's ZM
  at any time — including a zone whose ZM was sitting at their desk.
- **An unknown zone id was accepted.** `99` scoped a session to a zone that does not exist.
- **A non-numeric zone id read as pan-India.** `Number('abc')` is `NaN`, which became `null`, which
  the scope layer reads as *no zone filter* — the widest scope in the system, reachable by typing
  nonsense into a request header. This is the sharpest defect in the slice: the failure mode of a
  malformed acting claim was **more** access, not less.

And the operational half was missing entirely: `POST /role-unavailability` had existed since Issue 27
with **no screen calling it**, nothing able to read a window back, and nothing able to end one — so
even after the gate exists, nobody could open the window that lets a CSM through. Entering or leaving
acting left no trace at all. The banner printed `Zone 3`, and the sidebar kept offering the CSM's own
destinations while the banner above it said the operator was a Zonal Manager.

## The shape of the fix

**One guard, not three checks.** `acting-context.ts`, `common/manager-scope.ts` and
`common/request-actor.ts` each re-parsed the header independently. A check bolted onto any one of
them would have left the other two open. `ActingContextGuard` resolves the header **once per
request** into `request.acting`; both decorators now read that field.

**A guard rather than a decorator, because the check is async.** It needs two queries (zone
existence, then the cascade) and `@CurrentScope`/`@CurrentActor` are synchronous
`createParamDecorator`s. A global `APP_GUARD` registered after `AuthGuard` (it needs `request.user`)
and before `RoleGuard` is the only point in the lifecycle that can do the work and keep both
decorators intact. This is the architecture decision the issue records; it was raised as Strategic
HITL, went unanswered, and was built on plan §7's default — **recommended, no new framework**. If it
is later answered differently, `common/guards/acting-context.guard.ts` is the one file to change.

## Decisions worth keeping

**1. A CSM is allowed only when the cascade says so — not merely when the ZM is out.** The gate asks
`currentActingRoleForZone(zone)` and requires the answer to be `CENTRAL_SERVICE_MANAGER`. So a CSM
who is *themselves* marked unavailable is refused: the duty has already passed to Operations Head,
and standing in would be acting for a role they no longer hold. Checking only "is the ZM out?" would
have let a CSM act during their own absence window — a hole the cascade already knew how to close,
which is precisely why the gate delegates to it rather than re-implementing the rule.

**2. An Operations Head is allowed unconditionally** (AC2). Pan-India authority is already theirs by
role, so the header can only *narrow* what they see. Gating it would be theatre: refusing the header
would not remove a single row from their reach.

**3. A ZM or WM sending the header is ignored, never refused** (AC7, unchanged behaviour). The admin
shell sends the header whenever acting state is set, and a 4xx would turn a harmless header into a
broken session for the one role that cannot widen anyway. Ignoring costs nothing, because ignoring
*is* the clamp.

**4. The decorators' fallback is the non-acting context, never a re-parse.** Re-deriving acting from
the header inside `@CurrentActor`/`@CurrentScope` would restore exactly the ungated grant the guard
removes — from a path that reads like a safety net and would survive every review as one.
`notActing(role)` in `auth/acting-context.ts` is that fallback, and it is now the only thing left in
that file besides the acting-capable role set and the type.

**5. A window is ENDED, never deleted.** `DELETE /role-unavailability/:id` stamps `window_end`. The
row is the record of *who was covering a zone while decisions were being made in it*: the cascade
reads these by time, and Issue 27's CSM-backup-share report reads the same history. A hard delete
would erase the answer to "who was acting when this was assigned?" for every decision the window
covered.

**6. Zone names are resolved with a second query, not an `include`.** `role_unavailability.zone_id`
has no FK relation in the Prisma schema, so the list does one extra `zone.findMany` rather than
forcing a migration this slice has no other reason to write — and the drift gate cannot run on this
box (the local Postgres role has no `CREATE DATABASE`), so an unverifiable migration is the more
expensive option.

**7. Manager availability is routed at `/manager-availability` for the CSM as well as living in
Settings**, following #238's precedent exactly. Settings is OH-only; widening it to reach one table
would hand the CSM zone, plant, user, company, SLA and scoring CRUD. Both routes render the same
component.

**8. The acting audit calls are fire-and-forget and fire *after* `sessionStorage` is written.**
`authHeaders()` reads the acting zone from session storage, so an exit posted before the clear would
carry the zone it is exiting and an entry posted before the write would carry none. Fire-and-forget
because a failed audit write must not block an operator from entering or leaving acting mode — the
gate, not the audit row, is what enforces the rule.

**9. The banner names the zone; the id survives only as a fallback.** Reference
`02-dashboard-csm-acting-as-zone.png` reads "for West", not "Zone 3". An operator has no reason to
know that zone 3 is West, and the id is the one thing on that banner they cannot independently check.
The id remains the fallback for a session entered through the free-text control.

**10. The sidebar follows the banner.** While acting, `Sidebar` is rendered with `ZONAL_MANAGER`. A
sidebar still offering CSM-only destinations directly contradicts the banner above it, and the two
together tell the operator nothing about what they can actually do right now.

## What was tested, and why in that shape

`test/acting-context.e2e-spec.ts` — **12 tests, 8 of them red before the change.** The four already
green are the AC7 clamp cases, which is the point: the slice had to prove it did not break the
behaviour that was already correct while closing the three that were not.

The gate's tests assert on **the response of a real scoped endpoint**, not on the guard in isolation.
A unit test of `canActivate` would have passed against a guard that resolved correctly and was never
registered — and "registered in the right position" is half of what this slice claims. The `NaN` case
is asserted as a **400 with `ACTING_ZONE_INVALID`**, never merely as "not pan-India": asserting the
absence of the bad scope would pass against a guard that refused everything.

`dashboard-acting-scope.e2e-spec.ts` needed a new `zmOutWindowId` fixture in `beforeAll`/`afterAll`
— its CSM case now requires an **open ZM window**, because the gate refuses without one. That fixture
change is itself evidence the gate is live on the dashboard's six endpoints, not only on the spec
written for it.

Admin: `manager-availability` (4) covers AC4's UI half — open a window, see the list, end one;
`acting-banner` (5) covers AC6 — the banner by name, the ZM sidebar while acting, and enter/exit
recorded, using a `calls[]` fetch-recording stub so the *order* relative to session storage is
observable; `acting-zone-scope` (2) covers the header the client sends.

## Acceptance criteria

- **AC1** — met. CSM + header for a zone with no open window → 403 `ACTING_NOT_PERMITTED`; with an
  open window → scoped exactly as before. `acting-context.e2e-spec.ts`.
- **AC2** — met. OH + header → allowed and attributed. Same file.
- **AC3** — met. Unknown or non-numeric zone → 400 `ACTING_ZONE_INVALID`; pan-India is unreachable
  from the header. Same file.
- **AC4** — met. `GET` list and `DELETE :id` (end) plus the admin **Manager availability** section,
  in Settings for OH and at `/manager-availability` for the CSM. Backend half in
  `acting-context.e2e-spec.ts`, UI half in admin `manager-availability`.
- **AC5** — met. `POST /acting/enter|exit` write `ACTING_STARTED` / `ACTING_ENDED` audit rows
  carrying the zone.
- **AC6** — met. Banner shows the zone **name**; sidebar shows the ZM menu while acting. Admin
  `acting-banner`.
- **AC7** — met, behaviour unchanged. ZM and WM sending the header stay clamped.

## Tests, verbatim

- Backend `acting-context.e2e-spec.ts` → **12 passed** (8 red before the change).
- Backend acting/guard neighbourhood — `dashboard-acting-scope`, `assign-batch-acting-scope`,
  `role-backup-controller`, `role-backup-service`, `global-guard-validation`, `exception-filter`
  and the five other specs that send the header → **12 files, all passing**.
- Admin `manager-availability` 4 + `acting-banner` 5 + `acting-zone-scope` 2 → **3 files, 11 passed**.
- **Full admin suite → 120 files / 838 tests, all passing** (the 1 reported error is the pre-existing
  #335 drawer crash, filed).
- **Full backend suite → 463 files / 2494 tests: 458 files passed, 3 skipped, and 2 files failed —
  both of which this slice fixed.** A global guard touches every route, so the whole suite, not the
  neighbourhood, is the check that matters here, and it earned its keep: **`test/manager-scope.spec.ts`
  still called `resolveManagerScope(user, rawHeader)`**, the pre-#339 signature, and every one of its
  five cases threw on `acting.actingZone` of `undefined`. Nothing in the acting neighbourhood caught it
  because that file is a pure unit spec of a function whose *callers* were all converted. (The second
  failure, `shared-auth-se-fixture-guard`, is #336's and is described below.) Both re-run green;
  neither needed a source change.
- `npx tsc --noEmit` (backend) and `npx tsc -b` (admin) → exit 0.

## What the full suite caught that the neighbourhood could not

`manager-scope.spec.ts` is the file this slice should have updated and did not. It pinned the **old**
contract — `resolveManagerScope(user, rawHeader)`, where the function parsed the header, decided which
roles may act, and decided what to do with nonsense. #339 moved all three decisions into the guard, so
the function now takes an already-proven `ActingContext` and decides nothing about permission.

The rewrite does not just fix the call shape: **three of its five cases were deleted on purpose**, and
the file says where they went. "A ZM's header is ignored", "a non-numeric header does not widen to
pan-India" and "an unknown zone is refused" are now the *guard's* answers, asserted in
`acting-context.e2e-spec.ts` against a real request — and two of them are now **400s**, which is a
stronger guarantee than the old "resolves to the caller's own scope". Re-asserting them here would
have meant feeding the function a context the guard cannot produce, and would have left a file that
reads like a gate long after the gate moved out of it.

The lesson is narrow and worth keeping: **converting every caller of a function does not exercise a
unit spec of the function itself.** Grep for specs naming the symbol, not just for its call sites.

## Four files that are deliberately not in the commit

`a1270ad` is marked WIP because four files this slice needs carry a **parallel scheduler-forensics
run's** uncommitted work in the same hunks; committing them would carry that run's code. They are
listed here so the next reader knows the commit is not the whole slice:

| File | This slice's part of it |
|---|---|
| `apps/admin/src/components/shell/TopBar.tsx` | 3 lines in `enterActing` — passing the picked zone's **name** to `setActingZone` |
| `apps/admin/src/pages/settings/SettingsPage.tsx` | one `GROUPS` entry: `manager-availability` under Field operations |
| `apps/admin/test/acting-banner.test.tsx` | the three `#339` assertions plus the `calls[]` fetch-recording stub |
| `apps/backend/test/dashboard-acting-scope.e2e-spec.ts` | the `zmOutWindowId` fixture (the file itself is the other run's, untracked) |

**The slice's tests do not pass without them.** They must be committed once the parallel run's tree
is clean.

## Follow-ups this slice does not own

- **AA-06** — auto-opening a ZM's unavailability window from a >24 h login gap. **Not built**, per the
  issue's own recorded default: windows are opened by OH or CSM from the Settings section this slice
  adds. Nothing about the gate assumes it.
- **#340** — acting *attribution*: eleven sites still write `actedAsRole: null`. The guard now puts
  the resolved acting context on every request, so those sites have something correct to read; #340
  is the slice that makes them read it.
- **#341** — acting scope on the write doors. Depends on this slice and #340.
