# 362 — User administration completion + reference-read hardening

**Done 2026-09-03.** Wave 4 of the module-gaps completion plan
(`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4), absorbing survey ids AC-06, AC-07 and AC-09.
Red-first. No dependencies. Account creation and passwords remain out of scope (#91).

## What it closes

Three gaps, one of which was a live privilege-escalation window:

1. **No role or zone could be changed at all.** `users.service.ts` had `list` / `create` /
   `setStatus`. An Operations Head who needed to move a manager between zones, or promote a WM,
   had to open a database console — with no audit row and no session consequences.
2. **`PATCH /org/users/:id {status}` existed and nothing on screen could reach it.** The Users
   section was a read-only registry; the disable control the backend had been waiting for since
   Issue 02 was never built.
3. **`org/geo/*` was readable by every authenticated principal.** The controller carried `AuthGuard`
   alone. The finding was verified against the working tree before building: it was accurate — there
   was no `RoleGuard` on that controller.

## The part that is not CRUD

**A scope change must end the sessions carrying the old scope.** Role and zone are only half of what
a principal can reach; the other half is the refresh token already in their hand, which goes on
minting access tokens on the **old** claims for up to thirty days (`REFRESH_TTL_MS`). A demotion the
live session ignores is worse than no demotion at all, because the audit log now says it happened.
So `update()` revokes.

**And it revokes inside the same transaction as the change.** `revokeAllForUserOn(tx, …)` takes its
client as a parameter for exactly this reason: if the role update committed and the revocation did
not, the outcome is the failure mode above — recorded, believed, and false. Passing the `tx` from
`AuditService.withAudit` makes the mutation, its audit row and the revocation one atomic fact. This
is the #338 pattern (notices join their escalation transaction) applied to session state.

**The last active Operations Head cannot be demoted or disabled.** OH is the only role that can
administer users, so removing the last one makes the change unreversible from inside the product — a
database-console incident, and the operator who caused it is the one who can no longer fix it. The
guard counts *other active* OHs, so a **disabled** OH does not count as a way back in (pinned by its
own test — that is the case a naive `count({role: 'OPERATIONS_HEAD'})` gets wrong).

## Decisions worth keeping

**1. One PATCH door, not a second `/role` route.** `PATCH /org/users/:id` now takes
`{status?, role?, zoneId?}`; `setStatus` survives as a thin alias over `update` so the old contract
is byte-identical. The reason it is one route: the last-Operations-Head guard has to judge the
**whole proposed end state**. An OH who demotes and re-zones in one breath must not be able to land
half of that, and two routes would let a check that passes on each half fail on the pair.

**2. `undefined` and `null` are different on `zoneId`.** Omitting the key leaves the zone alone;
`null` un-zones the user (the pan-India roles have no zone). Collapsing the two would make every
role-only edit silently strip the zone.

**3. Revocation is keyed on an actual change, not on the route being called.** A PATCH that sets a
user's current role to their current role does not evict a working engineer from the field. Tested
directly — it is the kind of behaviour that is only ever discovered in production.

**4. A status-only edit keeps its old audit verb.** `USER_DISABLED` / `USER_ACTIVATED` still mean
what they meant; anything touching role or zone writes `USER_UPDATED` with `{from, to,
sessionsRevoked}`. A log reader can tell a re-scoping from a parking without reading metadata.

**5. Inline row editing, not the modal the issue text named.** The Companies table two sections up on
the same page already edits in place, with the same Edit → Save/Cancel affordance and its own test.
A modal for the same shape of change on the same page is a second thing to learn for nothing. The
write path is identical either way; recorded here because it is a deliberate deviation from the
brief.

**6. `OrgRequestError` carries the server's own refusal.** `api()` threw
`Error('REQUEST_FAILED_<status>')` with the body discarded, so every failure reached the UI as
"something went wrong". The message string is unchanged (a dozen call sites catch it and show their
own copy), but the error now also carries `code` and `detail`. The Users section shows `detail`
verbatim for one reason: *"this is the only active Operations Head — promote another one first"* is
a refusal the operator can act on, and a generic banner throws away the only useful sentence.

**7. Geography's allow-list is the three manager roles.** ZM/CSM/OH can be handed a territory to
manage; a Warehouse Manager works one warehouse and has no territory selector to fill, and an SE's
handset has no business paging the national footprint. The only consumer, the admin Territory page,
is already OH-only (`AppRoutes.tsx:490`), so nothing on screen loses a read.

## What was tested, and why in that shape

**Revocation is proved end to end, not by inspecting a column.** The subject account is created
through the API, given a credential (`ensureCredential`, the same one-path helper the seeds use),
logged in for a real refresh token, and then — after the role change — `POST /api/auth/refresh`
returns **401**. A test that only asserted `revoked_at IS NOT NULL` would still pass if the auth
path stopped consulting that column.

**The last-OH assertions do not depend on file order.** The suite shares one database and
`fileParallelism: false` only fixes the order *within* a run; whether some earlier spec left a second
OH behind is not something this file can know. `asSoleOpsHead()` parks every other active OH, runs
the assertion, and restores exactly what it parked — a security invariant that only holds under a
particular file order is not pinned at all.

**Geography is swept per role and per route**, not on one endpoint: three routes × five roles, so a
guard applied to the controller but overridden on one handler cannot hide.

## Acceptance criteria

- [x] **AC1** — OH can disable/enable a user and change their role/zone from Settings.
      Backend `AC1 — changes a user role and zone in one PATCH`; admin
      `AC1 — disables a user from their row…`, `AC1 — changes a role and a zone in one PATCH`.
- [x] **AC2** — a changed user's sessions are revoked. Four cases: role change (end to end via
      `/auth/refresh` → 401), zone change (with the reason a support answer can read), disable, and
      the negative — a no-op PATCH does **not** log the user out.
- [x] **AC3** — the last active OH cannot be disabled or demoted. Three cases: demote, disable, and
      a disabled OH not counting as a survivor; plus the positive control (demoting an OH while
      another active one remains succeeds).
- [x] **AC4** — geography reads refuse SE and WM, and still serve ZM/CSM/OH.

## Tests, verbatim

```
$ .scratch/locks/backend-test.sh npx vitest run test/org-users.e2e-spec.ts test/org-geography.e2e-spec.ts
 ✓ test/org-users.e2e-spec.ts (16 tests) 7320ms
 ✓ test/org-geography.e2e-spec.ts (7 tests) 4593ms
 Test Files  2 passed (2)
      Tests  23 passed (23)

$ cd apps/admin && npx vitest run test/settings.test.tsx
 ✓ test/settings.test.tsx (12 tests) 6816ms
 Test Files  1 passed (1)
      Tests  12 passed (12)
```

Regression set, for the two seams this slice touches (the refresh-token store, and the route sweep
that fails a hand-built scope):

```
$ .scratch/locks/backend-test.sh npx vitest run test/acting-scope-route-sweep.spec.ts \
    test/refresh.e2e-spec.ts test/refresh-persistence.e2e-spec.ts test/auth.e2e-spec.ts \
    test/db-backed-login.e2e-spec.ts
 ✓ test/acting-scope-route-sweep.spec.ts (6 tests)
 ✓ test/refresh-persistence.e2e-spec.ts (4 tests)
 ✓ test/db-backed-login.e2e-spec.ts (5 tests)
 ✓ test/refresh.e2e-spec.ts (3 tests)
 ✓ test/auth.e2e-spec.ts (1 test)
      Tests  25 passed (25)

$ cd apps/admin && npx vitest run test/acting-header-builder.test.ts test/territory-page.test.tsx
      Tests  5 passed (5)
```

`global-guard-validation.e2e-spec.ts` was also run and its route-map sweep **timed out at 5s** — the
known-flaky file named in #184, failing on a timeout rather than an assertion. Its other seven cases
pass. Nothing in this slice adds a route; `RoleGuard` runs after `AuthGuard`, so an unauthenticated
request to `org/geo/*` still 401s, which is what that sweep asserts.

## Follow-ups this slice does not own

- **Access tokens outlive the change by their own TTL.** Revocation kills the refresh token, so the
  session cannot be renewed on stale claims, but an access token already minted stays valid until it
  expires. Closing that needs a token-version claim checked in `AuthGuard` — a bigger change than
  this slice, and worth filing if the access TTL is ever raised.
- **The create form still cannot set a zone**, so a newly created Zonal Manager must be edited
  immediately afterwards to be given one. Account creation belongs to #91.
- **No admin-forced-logout control.** `revokeAllForUser` now has a caller, but there is still no
  "sign this user out everywhere" button independent of a role change.
