# 91 — Production authentication: Postgres-backed credential store + persistent refresh tokens

Status: needs-triage
Type: HITL
Progress: not started — filed 2026-06-29 from the authentication architecture audit. This is the
single implementation authority for swapping the in-memory auth scaffold to the database-backed
production design the repository already specifies. Requires one schema/architecture decision
(credential-column placement) before GREEN — see "Open decision (decide before coding)".

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
