# 91 — Production authentication: Postgres-backed credential store + persistent refresh tokens

Status: ready-for-human
Type: HITL
Progress: S1–S4 landed (2026-08-03). Schema (S1), DB-backed login (S2), persistent refresh + device
binding + logout (S3), and in-memory-store retirement (S4) are all implemented and scoped-test green.
The credential-column-placement HITL is closed (Slice 1, `user_credentials` table). Remaining:
central full-suite verification (a shared-DB collision with a parallel slice interrupted the one
unattended full-suite run this session attempted — see the 2026-08-03 comment) and the optional
admin httpOnly-cookie fast-follow (still deliberately deferred, not required for this issue's ACs).

> **This issue does not redesign authentication. It implements the design the repository already
> defines** in [ADR-0025](../../../docs/adr/0025-foundation-skeleton-infra.md),
> [`docs/backend/fsm-backend-low-level-design.md`](../../../docs/backend/fsm-backend-low-level-design.md) §8,
> [`docs/backend/fsm-database-schema-blueprint.md`](../../../docs/backend/fsm-database-schema-blueprint.md) D1,
> and `CONTEXT.md`. Every existing architectural decision (self-managed HS256 JWT, `{user_id, role, zone_id}`
> claims, 15-min/30-day TTLs, single-use refresh rotation, scrypt hashing, the
> `AuthGuard → RoleGuard → ZoneScopeGuard` chain, the 5-role no-`ADMIN` RBAC model) is **preserved
> unchanged**. The work is to move the *source of truth* from process memory to Postgres.

## Background — why the in-memory implementation exists

Issue 01 (Foundation skeleton) deliberately built the authentication **seam** before Docker/Postgres
were provisioned, so the rest of the platform could build against a working login + guard chain. The
scaffold is explicitly marked temporary in the code itself:

- `apps/backend/src/auth/user-store.ts` — `InMemoryUserStore`: *"Dev-seed user store. Replaced by the
  Postgres-backed store once Docker/DB is available (TB9+). Passwords are scrypt-hashed even in the
  seed — no plaintext."* Holds five hardcoded `*@fsm.test` users.
- `apps/backend/src/auth/refresh-token-store.ts` — `InMemoryRefreshTokenStore`: *"Replace with the
  persistent (Postgres) store when DB-backed auth lands — see ADR-0025 and TB6+."*
- `apps/backend/prisma/schema.prisma` (User model, ~L75–77) — *"Credentials are intentionally NOT
  stored here (the login path keeps its own store for now); this is the account registry Operations
  Head manages."*
- `apps/backend/src/org/org-seed.ts` (L8) — *"Login accounts stay in the in-memory auth store until
  that is swapped to Postgres, so this seeds reference data, not credentials."*
- `docs/progress/01-foundation-skeleton-infra.md` (L47) — *"In-memory auth stores not yet swapped to
  Postgres — DB + Prisma now exist, but `InMemoryUserStore`/`InMemoryRefreshTokenStore` are still in
  use; `users`/`refresh_tokens` tables not yet modelled. **Next persistence slice.**"*

The scaffold was always intended to be replaced. No backlog issue currently owns that replacement —
the authentication architecture audit (2026-06-29) confirmed it is tracked only as Issue 01 technical
debt, never promoted to an issue. This issue fills that gap.

## Problem statement

**Current implementation.** Login validates against `InMemoryUserStore` (5 hardcoded users), and
refresh tokens live in `InMemoryRefreshTokenStore` (a process-local `Map`). The JWT issuance
(`token.service.ts`, custom HS256, claims `{user_id, role, zone_id}`, 15-min access), password hashing
(scrypt + 16-byte salt + `timingSafeEqual`), and the guard chain (`auth.guard.ts`, `role.guard.ts`,
`zone-scope.guard.ts`) are all real and correct — but they sit on top of an in-memory identity source.

**Intended implementation.** The same login flow, JWT, and guards, but credentials and refresh tokens
read from Postgres. A login resolves any row in the real `users` table; refresh tokens persist in a
`refresh_tokens` table (named — not yet modelled — in the Issue 01 progress note,
`docs/progress/01-foundation-skeleton-infra.md` L47: *"`users`/`refresh_tokens` tables not yet
modelled. Next persistence slice."*) and survive restart / horizontal scale, with a denylist for
forced logout (ADR-0025 L65). The intent to persist + rotate + denylist refresh tokens is decided
(ADR-0025); the table's exact columns are not specified anywhere in the design docs — see the Open
decision below.

**Current limitations.**
1. Only the 5 `*@fsm.test` users can authenticate. Every other DB user is invisible to login.
2. Refresh tokens are lost on restart and not shared across instances (`refresh-token-store.ts`).
3. The admin refresh token is returned in the JSON body, not the httpOnly secure cookie ADR-0025
   mandates (`docs/progress/01-foundation-skeleton-infra.md` L43) — tracked here as the cookie cutover.

**Why Book dataset users cannot authenticate.** The Book harness
(`apps/backend/test/env/book8/book8-se-org.ts`) seeds **real `users` rows** with production roles
(`OPERATIONS_HEAD`, `CENTRAL_SERVICE_MANAGER`, `ZONAL_MANAGER`, `WAREHOUSE_MANAGER`, `SERVICE_ENGINEER`)
and correct zone assignment (e.g. `ops-head@book8.test`, `csm@book8.test`, `wm@book8.test`,
`zm-<zone>@book8.test`). But login never reads the `users` table — it reads `InMemoryUserStore`, which
does not contain them. So a fully-provisioned Book user is rejected at `/auth/login` purely because the
credential source is in-memory.

**Why this is not a Book issue.** The defect is generic: the same wall blocks *any* `users` row created
by `POST /api/org/users` (`users.service.ts`, Issue 02 / 45 / 46), not just Book rows. Operations Head
can create a Zonal Manager today who then cannot log in. Book datasets merely make the gap visible
because they populate the `users` table at scale. Fixing it requires **zero** Book-specific logic — only
that login reads the database.

**Why this also affects future production.** Real production users will be created through the same
`POST /api/org/users` path Book and seeds use. Until login is database-backed, no production user can
authenticate, the system cannot scale beyond one process (refresh tokens are process-local), and forced
logout (denylist) is impossible. This is a launch blocker, not a test convenience.

## Open decision (decide before coding) — HITL

The schema deliberately omits credential columns from `users`
(`schema.prisma` *"Credentials are intentionally NOT stored here"*). Before GREEN, one decision must be
ratified (architecture/schema → Strategic HITL per `CLAUDE.md` workflow):

- **Where the password hash + salt live:** a `password_hash`/`password_salt` (+ algorithm/params)
  column set **on `users`**, *or* a separate `user_credentials` table keyed by `user_id`.
  Recommendation: a dedicated `user_credentials` table, to keep the `users` registry (the
  Operations-Head-managed account list) free of secret material and to isolate credential rotation.
- The `refresh_tokens` table itself is **already decided in intent** — ADR-0025 ratifies refresh
  rotation + a forced-logout denylist (L65), and the Issue 01 progress note names the table
  (`docs/progress/01-foundation-skeleton-infra.md` L47). But **no design doc specifies its columns**
  (the schema blueprint and LLD describe "JWT access + refresh" conceptually only — they do not model a
  `refresh_tokens` table). Its columns (token hash, `user_id`, `expires_at`, `revoked_at`, rotation
  lineage) are therefore an **architectural gap to finalize in this issue**, not a pre-existing spec to
  follow.

Hashing algorithm (scrypt), TTLs (15-min / 30-day), rotation (single-use), claims
(`{user_id, role, zone_id}`), and the 5-role model are **already decided** by the repository and are
**not** reopened here.

## Scope

Implement, preserving every existing decision:

1. **Database-backed user lookup** — login resolves the credential + user record from Postgres for any
   `users` row (replacing `InMemoryUserStore.validateCredentials`).
2. **Password verification** — keep scrypt + per-user salt + `timingSafeEqual` exactly as in
   `user-store.ts`; read the stored hash/salt from the DB instead of the in-memory seed.
3. **JWT generation** — unchanged `token.service.ts` HS256 with claims `{user_id, role, zone_id}`,
   15-min access TTL; issued from the DB-resolved user.
4. **Refresh-token persistence** — a Postgres-backed store implementing the same `issue`/`consume`
   single-use rotation contract as `refresh-token-store.ts`, plus a revocation/denylist path for forced
   logout (ADR-0025 L65), surviving restart and shared across instances.
5. **Loading role** — from the `users.role` column on the resolved row.
6. **Loading zone** — from `users.zone_id` (NULL for fleet-wide roles), carried into the `zone_id` claim
   exactly as today.
7. **Loading company assignment** — load whatever company linkage exists in the current schema for the
   user. **Note (preserve decision):** the `users` table has no `company_id`; `company_tier` lives on
   `company_master` and drives prioritization, not auth. There is therefore **no per-user company claim**
   to add — this item is satisfied by loading existing relationships only. Adding a company column or
   claim is **out of scope** (would be a new schema decision).
8. **Loading warehouse assignment** — derive a Warehouse Manager's warehouse via the existing
   `warehouses.manager_user_id` FK (schema blueprint D1). No new column or token claim is introduced.
9. **Preserving existing authorization** — `AuthGuard → RoleGuard → ZoneScopeGuard` and the
   `@Roles(...)` decorator behave identically; `ZONE_SCOPE_VIOLATION` semantics unchanged.

> **Claim-shape invariant:** the access-token payload stays exactly `{user_id, role, zone_id, iat, exp}`.
> Company/warehouse are loaded server-side from DB relationships where needed; they are **not** added to
> the JWT. This keeps every existing token consumer (guards, `/api/me`, mobile, admin) compatible.

## Explicitly out of scope

Do **not** include: SSO · OAuth · LDAP · MFA · password reset / forgot-password · user administration
(creation/activation/disable already exist via `POST /api/org/users`, Issue 02/45/46) · RBAC redesign ·
dashboard / UI redesign · CSV-specific or Book-specific behaviour · any new role · adding a
`company_id` column or company/warehouse JWT claim · external notification adapters.

## Acceptance criteria

- [ ] **Admin login** — `POST /auth/login` with a valid email/password for any `users` row returns a
      `{accessToken, refreshToken}` pair; invalid credentials return 401 (unchanged contract).
- [ ] **JWT compatibility** — issued access tokens are byte-compatible with the current
      `token.service.ts` format: HS256, payload `{user_id, role, zone_id, iat, exp}`, 15-min TTL. No
      existing token consumer changes.
- [ ] **Existing guards unchanged** — `AuthGuard` accepts the new tokens; `RoleGuard` enforces
      `@Roles(...)`; `ZoneScopeGuard` still raises `ZONE_SCOPE_VIOLATION` for a ZM crossing zones.
      Existing guard tests pass without modification.
- [ ] **Existing API compatibility** — `/auth/login`, `/auth/refresh`, and `/api/me` request/response
      shapes are unchanged; no breaking change to any caller.
- [ ] **Refresh persistence** — a refresh token issued before a backend restart still rotates
      successfully after restart; a consumed (rotated) token is rejected; a denylisted token is rejected
      (forced logout).
- [ ] **Operations Head** — `ops-head@book8.test` (role `OPERATIONS_HEAD`, `zone_id` NULL) logs in;
      token carries `zone_id: null`; fleet-wide endpoints accessible.
- [ ] **CSM** — `csm@book8.test` (role `CENTRAL_SERVICE_MANAGER`, `zone_id` NULL) logs in; acting-zone
      flow (`X-Acting-As-Zone`, Issue 27/47) continues to work unchanged.
- [ ] **Zone Manager** — `zm-<zone>@book8.test` (role `ZONAL_MANAGER`, `zone_id` set) logs in; token
      carries the correct `zone_id`; cross-zone access denied by `ZoneScopeGuard`.
- [ ] **Warehouse Manager** — `wm@book8.test` (role `WAREHOUSE_MANAGER`) logs in; warehouse assignment
      resolvable via `warehouses.manager_user_id`.
- [ ] **Book-imported users** — any user seeded by `book8-se-org.ts` authenticates with **no
      Book-specific code path** (same login as everyone else), once a credential row exists for them.
- [ ] **Organization-seeded users** — a user created via `POST /api/org/users` (and given a credential)
      can immediately log in; the "DB user exists but cannot authenticate" gap is closed.
- [ ] **Future production users** — authentication authenticates any valid database user **regardless of
      how the row was created** (seed, Book harness, admin CRUD, future provisioning). No origin-specific
      branching.
- [ ] **Future Mobile login compatibility** — the same `/auth/login` + `/auth/refresh` contract serves
      mobile (`apps/mobile/src/auth/tokenStore.ts` keychain storage unchanged); no separate mobile auth
      path is introduced.
- [ ] **In-memory stores retired** — `InMemoryUserStore` / `InMemoryRefreshTokenStore` are removed (or
      reduced to a clearly-marked test double), and production login no longer depends on hardcoded
      credentials.
- [ ] **(If included in this slice) Admin httpOnly cookie** — admin refresh token transported via
      httpOnly secure cookie per ADR-0025 (may be split to a fast-follow if scope demands; record the
      decision in the progress doc).

> **Authentication principle (AC framing):** authentication simply authenticates valid database users.
> It must not know or care whether a user came from a seed, the Book harness, admin CRUD, or future
> provisioning.

## Dependencies

**Depends on (blocked by):**
- **01 — Foundation skeleton & infrastructure** — owns the auth seam, JWT, guards, and the Prisma/DB
  toolchain this issue extends. The `users` table and guard chain must exist (they do).
- **02 — Org / reference config + Settings** — owns `POST /api/org/users` (`users.service.ts`), the
  DB-backed account registry whose rows this issue makes loginable.

**Depended on by (this unblocks):**
- **Production launch** of any role-scoped surface that requires real users to log in.
- **Book-dataset end-to-end validation** of role-scoped dashboards (Operations Head / CSM / Zone
  Manager / Warehouse) — these need their seeded users to authenticate.
- **Mobile Foundation (54)** and the M-series — *"session + auth wiring (reuse Issue 01 auth shell)"*;
  mobile login becomes real once this lands (no new dependency edge required, but mobile validation
  benefits).
- Any horizontal-scale / multi-instance deployment (refresh tokens stop being process-local).

**Does not change** Issues 27/47 (acting attribution) or 03 (audit spine) — they consume the same
claims and continue to work.

## TDD plan (RED → GREEN → REFACTOR)

Follow `/tdd`. Integration tests over the real Nest app + Postgres (the repo's e2e style).

**RED**
- Write a failing e2e: a user inserted directly into the `users` table (+ credential row) can log in via
  `POST /auth/login`. Fails today because login reads `InMemoryUserStore`.
- Failing e2e: a refresh token issued, then the app/module re-instantiated, still rotates. Fails today
  (process-local `Map`).
- Failing e2e: each Book-seeded role (`ops-head`/`csm`/`zm-<zone>`/`wm`/`se-*@book8.test`) logs in and
  receives the correct `{role, zone_id}` claims.
- Failing unit test: DB-backed credential verification rejects wrong password (scrypt + `timingSafeEqual`
  semantics preserved).

**GREEN**
- Add the credential storage (per the ratified Open Decision) + `refresh_tokens` table via Prisma
  migration.
- Implement a `PrismaUserStore` satisfying the existing `validateCredentials` contract; implement a
  `PrismaRefreshTokenStore` satisfying the existing `issue`/`consume` contract + denylist.
- Bind `AuthService` to the Postgres-backed stores (DI swap; no change to `auth.controller.ts` / token
  shape / guards).
- Seed credentials for the `*@fsm.test` and Book users so existing/seed flows keep working.

**REFACTOR**
- Remove `InMemoryUserStore` / `InMemoryRefreshTokenStore` from the production graph (keep a test double
  only if a test needs it).
- De-duplicate scrypt hashing/verification into one shared helper used by both seed and runtime.
- Confirm guard/`/api/me`/acting-context tests still pass untouched; tidy module wiring.

**Required tests (targets):** login success/failure (DB) · refresh rotate + reuse-rejected +
restart-survival + denylist · per-role claim correctness (all 5 roles) · Book-user login (no special
path) · org-CRUD user login · guard chain regression (Auth/Role/ZoneScope) · `/api/me` regression ·
acting-zone (27/47) regression.

## Migration plan (InMemoryUserStore → database-backed)

Goal: zero change to API contracts or token shape; the swap is internal (DI + data source).

1. **Additive schema first** — add the credential storage + `refresh_tokens` table by Prisma migration.
   No drop of existing columns. Migrations must show no drift.
2. **Seed parity** — populate credentials for the existing 5 `*@fsm.test` users (same passwords) and for
   Book users via the existing seed/harness path, so current tests and demos keep passing through the
   cutover.
3. **DI swap behind the existing interfaces** — `AuthService` already depends on a user store + refresh
   store abstraction (`validateCredentials`, `issue`/`consume`). Implement Postgres versions and bind
   them in the auth module. `auth.controller.ts`, `token.service.ts`, and all guards are untouched.
4. **Cut over** — switch the module providers from in-memory to Prisma-backed; run the full e2e suite.
   Because the token format and endpoint contracts are identical, admin and mobile clients need no
   change.
5. **Retire** — delete the in-memory production providers once green (keep as test doubles only if used).
   Also delete the **dev-only zone-resolution scaffold** added 2026-06-30 to keep the in-memory dev
   login usable across datasets (it becomes redundant once `zone_id` is loaded from `users.zone_id`):
   `apps/backend/src/auth/dev-zone-resolver.ts`, its provider in `auth.module.ts`, the `DevZoneResolver`
   injection + `resolveZoneId` call in `auth.service.ts`, `test/dev-zone-resolver.e2e-spec.ts`, and the
   `DEV_AUTH_ZONE` block in `.env.example`. (`AuthService.login/refresh` may revert to sync.) The
   `DEV_AUTH_ZONE` override is a per-run dev convenience only — it is never set in `.env`, so the test
   suite is unaffected and there is no test-bootstrap shim to remove.
6. **(Optional same-slice) cookie cutover** — move the admin refresh token to an httpOnly secure cookie
   (ADR-0025); this is the one client-visible change and may be deferred to a fast-follow if it widens
   scope — record the decision in `docs/progress/`.

## Validation plan

- **Seeded organization users** — log in as each `*@fsm.test` user; confirm role/zone claims and that a
  user created live via `POST /api/org/users` (given a credential) can authenticate.
- **Book datasets** — run the book8 seed, then authenticate `ops-head@book8.test`, `csm@book8.test`,
  `zm-<zone>@book8.test`, `wm@book8.test`, and an `se-*@book8.test`; confirm each lands on its correct
  role/zone with no Book-specific code in the auth path.
- **Admin Web** — log in through the existing admin login UI (FE-01 `useAuth().login`, untouched); the
  session carries role + zone; role-scoped dashboards render for the logged-in role.
- **Mobile (future)** — confirm the same `/auth/login` + `/auth/refresh` works against
  `apps/mobile/src/auth/tokenStore.ts` (keychain) with no separate mobile flow.
- **Role-scoped dashboards** — verify a Zone Manager sees only their zone (ZoneScopeGuard) and a
  cross-zone request is denied; Operations Head sees fleet-wide.
- **Resilience** — restart the backend mid-session; confirm refresh still rotates (persistence) and a
  denylisted token is rejected (forced logout).

## Priority

- **Issue type:** HITL (one schema/architecture decision — credential-column placement — needs
  ratification before GREEN; thereafter the implementation is AFK-executable).
- **Priority:** **High / launch-blocking.** No real user — production, seeded, or Book — can authenticate
  until this lands.
- **Milestone / tracer-bullet placement:** the **"next persistence slice"** the Issue 01 progress doc
  names (TB6+/TB9+). It belongs immediately after Foundation (01) and Org (02) in the build order, ahead
  of broad role-specific UI **validation** (it does not block UI *construction*, which already proceeds
  against the 5 seed users).

## Should this gate role-specific UI validation (e.g. Zone Manager dashboards)?

**It should gate end-to-end role-specific *validation*, but not UI *construction*.**

- **Construction can proceed without it.** The FE-series dashboards are already being built and tested
  against the 5 in-memory seed users (one per role), and the guard chain already enforces role/zone from
  the JWT. Nothing about building a Zone Manager dashboard requires DB-backed login.
- **Validation with real/Book users is gated by it.** Confirming a Zone Manager dashboard behaves
  correctly for the *actual* `zm-<zone>@book8.test` users — or any organization-seeded ZM — is
  impossible until login reads the `users` table, because those users cannot currently authenticate.
  Any "log in as the Book Zone Manager and verify their dashboard" step is blocked until this issue
  ships.

**Recommendation:** implement this **before** the validation phase that uses Book or org-seeded users to
exercise role-scoped dashboards, and before any multi-instance/staging deployment (process-local refresh
tokens). It is safe to defer only as long as validation stays on the 5 hardcoded seed users — which is
not a basis for production sign-off.

## Blocked by

- 01 — Foundation skeleton & infrastructure (auth seam, JWT, guards, Prisma/DB)
- 02 — Org / reference config + Settings (`POST /api/org/users` account registry)

## Comments

### 2026-07-28 — mobile-readiness extension (docs/status/backend-mobile-readiness-plan-2026-07-28.md §C)

Re-verified 2026-07-28: zero auth commits since 07-22; every §2 finding of the 07-22 mobile
assessment stands. Five additions **within this issue's scope** (the swap), none reopening its
frozen decisions:

1. **Async hashing must be explicit.** Scope 2 says keep scrypt "exactly as in `user-store.ts`" —
   which as written preserves `scryptSync` (`user-store.ts:78`), the event-loop stall that makes a
   1,000-device login burst a process-wide outage. Amend: same algorithm/salt/`timingSafeEqual`,
   but promisified `crypto.scrypt`. Also hash a dummy on unknown email (`user-store.ts:75-76`
   timing enumeration).
2. **`revokeAllForUser` AC.** The store exposes only `issue`/`consume`; device-loss and
   force-logout need user-keyed revocation. Add to the `refresh_tokens` design + one AC.
3. **Reserve `device_id` on `refresh_tokens` before the table freezes.** One-device-vs-many
   (HITL D4, plan doc §D) decides its semantics; adding the column later is a migration + fleet
   re-login. Decide D4 first, then code the table.
4. **Rotation self-lockout on lossy networks (new finding N1).** `consume()` revokes before the
   response reaches the client (`refresh-token-store.ts:35`); a dropped response strands the device
   — retry looks like token-theft reuse → 401 → password re-login mid-shift. Routine on rural 2G.
   Design a rotation grace window or per-device token families into the table (the rotation-lineage
   column already contemplated here is the natural hook).
5. **Native contract invariant.** If the optional admin httpOnly-cookie cutover lands, the JSON-body
   `/auth/refresh` contract must remain for mobile (ADR-0025 keychain path) — additive per-client,
   never a replacement.

Out of scope, tracked elsewhere: mobile access TTL (HITL D3 — this issue's 15-min freeze stands
until the operator reopens it), `jti`/`kid` claims (would break this issue's byte-compat AC — own
decision if ever needed), push/device-token registry (#76). Sequencing: **#162 (SE authz floor)
must land no later than this issue's credential rollout** — 75 SEs gaining login today would each
be able to write against all 13,941 OPEN troubleshoot tickets (measured 07-28).

### 2026-07-28 — logout and revocation do not exist at all (freeze plan §1.1, F3.4)

Sharper than the 07-28 extension's "no `revokeAllForUser`": **there is no logout endpoint.**
`auth.controller.ts:16-26` exposes exactly two routes, `login` and `refresh`; a repo-wide grep for
`logout|revoke|revocation|blacklist|denylist` across `apps/backend/src` hits only `auth.service.ts:27`
and the store. `InMemoryRefreshTokenStore` has exactly `issue` and `consume` (`:19-38`) — `consume`
revokes only the single token it rotates.

Consequences: mobile's `logout()` clears the local keychain while the refresh token stays valid
server-side for up to 30 days, and **a lost or stolen handset cannot be revoked by anyone**. For a
field workforce with device turnover that is a security gap, not a papercut.

+1 AC: **`POST /api/auth/logout`** revoking the presented refresh token, plus the `revokeAllForUser`
path for device loss. Both belong in this issue's `refresh_tokens` design, and the **device-model
decision (D-2) must be made before that table is written** — retrofitting `device_id` later is a
migration plus a fleet-wide re-login.

### 2026-07-28 — D-2 SETTLED: one active device, replace-on-login

**Field reality confirmed by the operator:** an SE uses one phone with the app at a time; a second
handset exists only as a **backup swapped in when the primary is unavailable**. There is no
two-devices-live-at-once workflow.

**Launch policy: one-active.** Logging in on a device revokes the previous device's session.
Consequences that fall out for free and should not be rebuilt later:
- **"Log out my other device" is implicit** — logging in anywhere does it. No endpoint needed.
- A **stolen or lost handset is deauthorised the moment the SE logs in on a replacement**, with no
  admin intervention — which is the common field case, and it is why this policy suits a fleet with
  device turnover.
- The broken-phone-mid-shift case is the one this handles best: pick up the spare, log in, done. No
  device-limit wall at a plant gate.

**Not in v1:** no device-list endpoint, no per-device logout route, no Profile → Devices screen.
(That screen would be a *third* surface absent from the PRD's 17-screen inventory, alongside Profile
and Daily Status.)

#### `refresh_tokens` shape — carry `device_id` regardless of the policy

```
refresh_tokens
  id · user_id · token_hash
  device_id      NOT NULL   -- opaque install id sent by the client
  device_label   NULL       -- e.g. "Rahul's Nokia", for a future logout UI
  issued_at · expires_at · revoked_at · last_seen_at
  rotated_from              -- rotation lineage / reuse detection; also the hook for the N1 grace window
```

> **The column is not the decision — it is what makes the decision reversible.**
> **Going to 2 or N devices later is a CONFIG CHANGE, not a migration**, because the max-devices rule
> is a count-at-login query, not a table shape. Nobody is logged out. **A future session must not
> rebuild this table to add multi-device** — add the count rule, then the two additive routes
> (`GET /api/me/devices`, `POST /api/me/devices/:id/logout`) and a screen, none of which break a
> shipped client.
>
> Shipping *without* `device_id` — enforcing one-active by deleting the user's other rows — is what
> would force a migration plus a **fleet-wide re-login**, because existing rows would carry no device
> attribution and could only be resolved by invalidating them.

#### ⚠ The one non-additive piece is on the client, not here

The app must generate and send a **stable install id** (`X-Device-Id`) **from its very first build**.
If v1 ships without it the server cannot attribute sessions to devices at all, and retrofitting needs
an OTA channel that does not exist (**#170**). **Recorded as an AC on #54**, because that is where
the mobile team will actually see it.

#### Not this issue: the SE's phone number

`User.phone` already exists (`String @unique`, non-null, `schema.prisma:136`) and `EngineerMaster`
defers to it explicitly — *"SE identity + contact (name/phone/email) live on `users`"*. It is a
**human contact datum, unrelated to session binding**. No new issue: its consumers are **#161**
(expose on `/api/me` for the Profile screen) and **#76** (WhatsApp delivery address).

### 2026-07-29 — Slice 1 LANDED: schema + migration ✅

Migration `20260729120000_production_auth_credentials_refresh_tokens` creates both tables.
The open HITL (credential-column placement) is **closed** — operator chose the dedicated
`user_credentials` table; `users` is untouched and its doc comment now points at the new table
instead of saying "the login path keeps its own store for now".

**`user_credentials`** — `user_id` PK/FK (ON DELETE CASCADE), `password_hash`, `password_salt`,
`password_algo` default `'scrypt'`, `password_params` JSONB, timestamps. Algo + params are per-row so
a future scrypt-cost bump re-hashes lazily on next successful login rather than forcing a big-bang
re-credential; **#110's brute-force counters belong here too** and can widen this table without ever
touching the account registry.

**`refresh_tokens`** — hash-only storage (`token_hash` UNIQUE; plaintext is returned once and never
persisted, so a DB read cannot yield a usable token), `device_id` NOT NULL per D-2, `device_label`,
`issued_at`/`expires_at`/`revoked_at`/`revoked_reason`/`last_seen_at`, and `rotated_from` for
rotation lineage. Indexes: `(user_id, revoked_at)` for the one-active revoke-previous write, and
`(expires_at)` for reclamation — the in-memory store never reclaimed anything, which was the leak.

Verified: `prisma generate` clean · migration applies to `fsm_test` · both tables and all five
indexes confirmed present via information_schema · backend `tsc` exit 0 · `auth`,
`per-zone-zm-logins`, `zone-scope`, `prisma-session-timezone` and `api-versioning` **14/14 green**
(the timezone spec matters here — it proves the UTC session option survived Wave 0's pool-options
refactor).

**Not verified locally: the from-zero migrate.** The local `fsm` role lacks CREATEDB so `fsm_drift`
could not be built. The DDL is purely additive (two CREATE TABLEs plus indexes and FKs, depending
only on `users` already existing), so the risk is minimal — but **CI's drift gate is the actual
check** and this claim rests on it, not on a local run.

**Slices remaining:** S2 DB-backed login (`PostgresUserStore`, async scrypt, credential seeding for
existing accounts) · S3 persistent refresh with device binding + one-active replace-on-login · S4
retire `InMemoryUserStore`/`InMemoryRefreshTokenStore`/`DevZoneResolver`, add logout +
`revokeAllForUser`. The admin httpOnly-cookie leg is **split to a fast-follow** (agent call, permitted
by this issue's last AC) — #91 was already the largest Wave 1 item before D-2 added device binding.

### 2026-08-03 — S2 + S3 + S4 LANDED: DB-backed login, persistent refresh + device binding, in-memory retirement

**S2 — DB-backed login.** New `PrismaUserStore` (`apps/backend/src/auth/prisma-user-store.ts`) reads
`users` JOINed with `user_credentials` and satisfies the exact `validateCredentials`/`findById` shape
`InMemoryUserStore` exposed. Password hashing moved to **async** `crypto.scrypt` (never `scryptSync`)
in a new shared helper, `apps/backend/src/auth/password-hasher.ts` (`hashPassword`/`verifyPassword`/
`hashDummyPassword`) — the 2026-07-28 amendment. An unknown email, or a `users` row with no credential
row yet, still runs `hashDummyPassword` before returning null, so response timing carries no
email-enumeration signal. `apps/backend/src/auth/credential-seed.ts` (`ensureCredential`) is the ONE
credential-writing path, idempotent, shared by every seed/harness — org fixtures
(`auth-fixture-seed.ts`) and the Book harness (`book8-se-org.ts`'s `ensureUser`) both call it, so login
has no origin-specific branching, satisfying the issue's "any DB user" AC framing directly.

The `*@fsm.test` dev/test fixture users (same emails/UUIDs/password as the retired
`InMemoryUserStore`) are now real `users` + `user_credentials` rows, seeded by
`apps/backend/src/auth/auth-fixture-seed.ts` and wired into `test/global-setup.ts` (test/dev only —
deliberately NOT wired into `src/seed.ts`, so a `pnpm seed` run against a real database can never mint
`*@fsm.test` credentials there — see judgment call below). `book8-se-org.ts`'s `ensureUser` now also
calls `ensureCredential` for every Book user it creates/finds, with the same well-known test password
every other spec uses.

**S3 — persistent refresh + device binding.** New `PrismaRefreshTokenStore`
(`apps/backend/src/auth/prisma-refresh-token-store.ts`) stores only a SHA-256 hash of the token
(never plaintext), implements the same single-use `issue`/`consume` rotation contract, and adds:
- **D-2 one-active-device, replace-on-login** — every `issue()` call revokes whatever was still
  active for that `userId` first (`revokedReason: 'REPLACED_BY_NEW_DEVICE'`). On login this ends the
  previous device's session; on a plain refresh it is a no-op, since `consume()` already revoked the
  one row that was active (the one being rotated) — so "at most one active refresh token per user"
  holds after every call, not just at login.
- **`revoke(token, reason)`** — revokes the presented token without rotating it, backing the new
  `POST /api/auth/logout` route (`auth.controller.ts`, `auth.service.ts#logout`). Idempotent and
  side-channel-safe: logout always returns 200, whether the token was valid, already revoked, or
  garbage — it must not become an oracle for token validity.
- **`revokeAllForUser(userId, reason)`** — the future admin-forced-logout hook the issue's ACs call
  for; no route calls it yet (no admin UI for this exists, per the issue's own "Not in v1" list).

`AuthService.refresh()` now returns `{userId, tokenId, deviceId}` from `consume()` so the newly
issued row can carry `rotatedFrom` (rotation lineage) and inherit the consumed token's `deviceId` when
the caller sends no `X-Device-Id` on the refresh call (see judgment call below).

**S4 — retired the in-memory graph.** Deleted `apps/backend/src/auth/user-store.ts`,
`refresh-token-store.ts`, `dev-zone-resolver.ts`, and `test/dev-zone-resolver.e2e-spec.ts`. Removed
the `DEV_AUTH_ZONE` documentation block from `.env.example` (the `test/setup-env.ts` allowlist entry
and its own regression spec were deliberately left alone — that entry is a no-op deletion of a var
nobody sets anymore, and removing it would require also editing `setup-env-allowlist.spec.ts`, which
is explicitly out of this issue's touch-list). `auth.module.ts` now provides only `PrismaUserStore` +
`PrismaRefreshTokenStore` + `TokenService` + `AuthController`/`AuthService`. `AuthService.login`/
`refresh`/`issueTokens` stay `async` (the Prisma-backed stores are themselves async), but the
now-dead `DevZoneResolver` dependency and its `resolveZoneId` await are gone; `zone_id` loads directly
from `users.zone_id` via `PrismaUserStore`.

**Judgment calls:**
1. **`X-Device-Id` pragmatic default.** No client (mobile or admin) sends a stable device id yet
   (tracked on #54, per the issue's own note). `auth.controller.ts#login` reads `X-Device-Id` if
   present, else generates a `randomUUID()` server-side so the `device_id NOT NULL` constraint is
   satisfied. This means one-active-device enforcement only meaningfully activates once a client
   sends a real stable id per install — an accepted, documented limitation of this slice, not a bug.
   `refresh()` falls back to the *consumed token's own* `deviceId` (not a fresh random one) when the
   caller sends no header, so a routine token rotation never masquerades as a new-device login.
2. **Logout route shape.** `POST /api/auth/logout` lives on the same `@Public()` `AuthController` as
   `login`/`refresh` (added to the route-guard sweep's allowlist in
   `test/global-guard-validation.e2e-spec.ts`) — the presented refresh token IS the credential, same
   as `/refresh`, so no `Authorization` bearer token is required. Body is `{ refreshToken }`; response
   is always `{ success: true }` / 200, deliberately never a distinct status for "unknown token" vs
   "already revoked" vs "never existed", so logout cannot be used to probe token validity.
3. **`*@fsm.test` fixture seeding scope.** Wired into `test/global-setup.ts` only, not
   `src/seed.ts` — seeding well-known dev/test credentials into whatever database `pnpm seed` targets
   felt like an unacceptable production hazard for a convenience that only the test suite needs.
4. **No status/DISABLED gating added to login.** `PrismaUserStore` does not check `users.status`;
   this preserves scope (the issue's AC list does not mention account-disable interacting with login)
   rather than introducing new behavior. Flagging in case a future issue expects a `DISABLED` account
   to be rejected at `/auth/login` — today it is not.

**Tests added** (all under `apps/backend/test/`, TDD style — see each file's own doc comment):
`db-backed-login.e2e-spec.ts` (DB login success/failure, unknown email, no-credential-yet, org-CRUD
user login once credentialed) · `refresh-persistence.e2e-spec.ts` (restart-survival via a
brand-new `PrismaService` instance reading the row by hash, one-active-device replace-on-login,
revoked-token rejection, device-id inheritance on refresh) · `logout.e2e-spec.ts` (revocation,
tokenless, no-oracle, idempotent) · `book-role-logins.e2e-spec.ts` (all 5 roles, Book email
convention, no Book-specific code path) · `password-hasher.spec.ts` (unit: hash/verify round-trip,
wrong-password rejection, salt uniqueness, dummy-hash-is-real-work). Existing
`login.e2e-spec.ts`/`refresh.e2e-spec.ts`/`per-zone-zm-logins.e2e-spec.ts`/`auth.e2e-spec.ts` were
left byte-unmodified as the regression baseline (they now exercise the DB-backed path transparently)
and still pass.

**Scoped test results (green):** `db-backed-login`, `refresh-persistence`, `logout`,
`book-role-logins`, `password-hasher`, `login`, `refresh`, `auth`, `per-zone-zm-logins`,
`global-guard-validation`, `org-users`, `me`, `acting-context`, `zone-scope` — all green.
`tsc --noEmit` on `apps/backend`: clean.

**Full-suite run:** NOT completed this session. This worktree and the parallel #161 (`ticket_no`)
slice's worktree share one physical Postgres `fsm_test` database with no per-worktree isolation (the
`fsm` role lacks `CREATEDB`, confirmed directly — same constraint the 2026-07-29 comment already
hit). One unattended full-suite attempt was started and stopped mid-run at the coordinating session's
request once a concurrent collision surfaced on the other slice's side (a `truncateTestDatabase`
deadlock, P2010/40P01); the coordinator is running full-suite verification centrally, one slice at a
time, to avoid further collisions. Transient symptom observed and confirmed environmental (not an
auth regression): `login.e2e-spec.ts`/`per-zone-zm-logins.e2e-spec.ts` briefly asserted the wrong
zone-id when a concurrent session's own truncate+reseed interleaved with this session's — the extra
zone rows observed (timestamp-named) were never created by this issue's code, and both specs went
green again once rerun without the interleaving. This is the same "DB-state-bleed" flake class the
task brief already calls out as pre-existing and out of scope to chase.
