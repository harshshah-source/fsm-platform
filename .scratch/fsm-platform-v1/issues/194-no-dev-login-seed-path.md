# 194 — No committed path seeds a login for the dev database

Status: done
Type: AFK · Backend · Dev environment

> **Done 2026-08-13** — `npm run seed:dev` (`src/seed-dev.ts` → `src/auth/dev-seed.ts`), gated by a
> default-off `ALLOW_DEV_SEED` and an unconditional refusal under `NODE_ENV=production` that the flag
> cannot override. Reuses the existing fixture list rather than defining the accounts a second time,
> so the eight logins a spec uses and the eight a browser uses are the same rows. `src/seed.ts` is
> untouched — the wall stands; this is the other half. 19 tests (10 pure guard, 4 e2e, +2 on #182's
> allowlist, +3 zone preflight), all three refusal/success paths exercised for real against `fsm`.
> Full record: `docs/progress/194-dev-login-seed-path.md`. Runbook:
> `docs/runbooks/local-development-login.md`.
>
> Two things worth carrying forward: a **zone preflight** the ACs did not ask for (seeding before
> `npm run seed` silently produced ZMs with a null `zone_id` — a login that authenticates then 403s
> everywhere, worse to diagnose than the 401 this issue removed), and a **data-derived third guard
> considered and rejected** with the residual risk stated in `dev-seed.config.ts` rather than hidden.

Filed 2026-08-04, hit while starting the backend after [#193](./193-zone-drilldown-enrichment.md).
Not a duplicate of [#91](./91-production-auth-postgres-backed-credential-store.md) — see
"Relationship to #91" below; #91 *caused* this and does not own it.

## The defect

**Nothing in committed code creates a `user_credentials` row on the dev database.** Login therefore
401s for every account and every password, with no diagnostic that says so —
`PrismaUserStore.validateCredentials` returns `null` for "user has no credential row" exactly as it
does for "wrong password" (`prisma-user-store.ts:38-41`, deliberately, to avoid an enumeration
oracle), and `AuthService.login` turns that into a bare `UnauthorizedException`. The operator-visible
symptom is a wall of identical 401s:

```
[Nest] WARN [UnhandledException] POST /api/auth/login → 401 [81cb7349-…] Unauthorized
```

Measured on the dev DB (`fsm` @ localhost:5433) before the workaround below:

| | |
|---|---|
| `users` rows | 80 (5 × `ZONAL_MANAGER`, 75 × `SERVICE_ENGINEER`) |
| `user_credentials` rows | **0 — the whole table** |
| `OPERATIONS_HEAD` / `CENTRAL_SERVICE_MANAGER` / `WAREHOUSE_MANAGER` users | **none exist at all** |
| `device_states` rows | 25,538 (the dev data itself is fine) |

## Why — the three seeding paths and what each actually does

| Path | Runnable against dev? | Creates users? | Creates credentials? |
|---|---|---|---|
| `src/seed.ts` (`npm run seed`) → `seedOrgReferenceData` | yes | **no** | **no** — zones, plants, tiers, companies, SLA/priority config, components, regions |
| `prisma/seed-mock-engineers.ts` | yes | yes (ZM + SE rows) | **no** — no `ensureCredential` call anywhere in the file |
| `seedAuthFixtureUsers` (`src/auth/auth-fixture-seed.ts`) | **no** | yes, 8 accounts | yes | 

The third is the only thing that mints credentials, and its single caller is
`test/global-setup.ts:42` — which runs against **`fsm_test`**, never `fsm`. Its own docstring makes
that deliberate:

> *Test/dev fixture only — never wired into the production `src/seed.ts` entrypoint, so a `pnpm seed`
> run against a real database can never mint `*@fsm.test` credentials there.*

So the walling-off is intentional and correct. What is missing is the **other half** — a dev-safe way
to get a login — which was never built.

## What it blocks

The admin app and the SE mobile app cannot be signed into against the dev database at all. Concretely:

- No manual QA of anything behind auth, on real dev data (25.5k devices, 130 company×plant rows in
  West alone) rather than fixtures.
- `apps/admin/visual/capture.mjs` — the visual-parity harness (FE-00) logs in through the form using
  `CREDS` in `visual/manifest.mjs` (`zm.north@fsm.test` / `csm@fsm.test` / `ops.head@fsm.test` /
  `wm@fsm.test`, password `correct-password`). **Those accounts do not exist on dev**, so
  `npm run visual:capture` cannot work on a clean machine. This is very likely why
  `visual/baseline/` has been recorded as stale since 2026-07-28 without anyone re-capturing.
- Even with credentials minted for the 5 existing mock ZMs, the cross-zone surfaces stay unreachable:
  the Zone Performance Scorecard lives on the CSM/OH dashboards, and **neither role has a user row**.

## Reproduces on a clean clone — yes

Nothing here depends on this machine's history. From a fresh clone against an empty database:

1. `prisma migrate deploy` → schema, no rows
2. `npm run build && npm run seed` → org reference data; `users` and `user_credentials` both empty
3. (optional) mock-engineer seed → `users` populated, `user_credentials` still empty
4. `npm start` → boots fine, and **every login 401s**

The one prerequisite that is *not* reproducible from the repo is the dev dataset itself (ingestion +
zone application + the 2026-07-20 mock-workforce reseed), but that is orthogonal — the credential
table is empty regardless of whether any devices exist.

## Relationship to #91 (the cause) and #190 (unrelated)

**#91 caused this, and its remaining scope does not cover it.** #91 Slice 4 is
"in-memory-store retirement". Before it, `InMemoryUserStore` (`src/auth/user-store.ts`) seeded five
hardcoded `*@fsm.test` users **at process boot**, so `npm start` alone produced working dev logins with
no database seeding at all. S4 deleted that file — verified: `src/auth/user-store.ts` no longer exists,
and `auth.module.ts:10` provides only `PrismaUserStore`. The accounts survived only by being re-homed
into the **test-only** fixture. The implicit dev-login provision was removed without a replacement.

#91's own `Progress:` line scopes its remainder to "central full-suite verification" plus an optional
cookie fast-follow — dev seeding is not among its ACs, and #91 is `ready-for-human`/HITL, so parking
this there would block a mechanical fix behind an unrelated human gate. Hence a separate issue.

**Not related to [#190](./190-184-deliverables-uncommitted.md).** #190 owns #184's uncommitted
test-infra bundle (`run-tests.mjs`, `vitest.config.ts`, `test/crash-diagnostics.ts`,
`patches/tinypool@1.1.1.patch`, `pnpm-workspace.yaml`, `audit/verify-run1.txt`). None of those touch
seeding, and `test/global-setup.ts` — the thing that *does* seed credentials for the test DB — is
committed. Committing #190's bundle would not produce a single dev login. The two share only a theme:
a clean clone cannot reach a working state. Neither blocks the other.

## Stale documentation this exposes (fix with the code)

- **`docs/SYSTEM-STATE-2026-07.md` §3j is wrong on two counts** and was corrected when this issue was
  filed: it stated that both auth stores are in-memory and that "DB-seeded users cannot log in (#91)"
  (the opposite of current reality — login is Postgres-only), and that *"The dev seed now carries one
  ZM per operational zone … plus the OH/CSM/WM/SE accounts (#133)"*, which is **false for every
  dev-runnable path** — those accounts exist only in the test fixture.
- `src/org/org-seed.ts:8` — *"Login accounts stay in the in-memory auth store until that is swapped to
  Postgres, so this seeds reference data, not credentials."* The swap happened. The comment now
  describes a world that no longer exists and should say what replaces it.
- #133's done-note says `InMemoryUserStore` "now seeds `zm.south`/`zm.east`/`zm.west`". That store is
  deleted; the note should point at wherever those accounts live after this issue.

## Current workaround (applied to this machine only — NOT a fix) — *retired 2026-08-13*

> The accounts described below now exist on this machine because **committed code** put them there
> (`ALLOW_DEV_SEED=true npm run seed:dev`), not because a session hand-ran the test fixture. Kept as
> the record of what the gap looked like. Note `ensureCredential` never rotates, so the rows are the
> originals — the seeder confirmed them rather than replacing them.


`seedAuthFixtureUsers` was run against `fsm` via a one-off script (not committed, nothing in the repo
changed), creating the 8 `*@fsm.test` accounts with password `correct-password`. Verified: login →
200, `GET /api/dashboard/zone-operations?zoneId=4&status=INACTIVE` → `{"openTickets":625,
"assigned":234,"unassigned":391,"liveBatches":37,"overriddenBatches":0,"engineersEngaged":15}`.
This does not survive a database reset and exists on no other machine.

## Acceptance criteria

- [x] A committed, documented entrypoint (e.g. `npm run seed:dev`) leaves the dev database with at
      least one working login per manager role — `OPERATIONS_HEAD`, `CENTRAL_SERVICE_MANAGER`,
      `ZONAL_MANAGER` (one per operational zone), `WAREHOUSE_MANAGER`, `SERVICE_ENGINEER`.
      *All eight fixture accounts; run for real against `fsm` → `Seeded 8 dev login(s)`.*
- [x] It is **idempotent** (re-runnable after a partial run, like `seedAuthFixtureUsers` already is)
      and creates only `users` + `user_credentials` rows — no reference data, no device/ticket rows.
      *Asserted twice-run, plus a before/after census over zones/plants/devices/tickets/users/creds.*
- [x] It **refuses to run against a non-development database.** *Two layers: default-off
      `ALLOW_DEV_SEED`, and an unconditional `NODE_ENV=production` refusal the flag cannot override.
      7 unit tests + 2 e2e; both refusals also exercised for real (exit 1, database untouched). A
      third, data-derived layer was **considered and rejected** — reasoning and residual risk in
      `src/auth/dev-seed.config.ts`.* **Password decision: the well-known `correct-password` is
      kept as the default**, overridable via `DEV_SEED_PASSWORD`, blank rejected rather than falling
      back. Requiring an env var would have broken the AC below on its face, since `manifest.mjs`
      hardcodes that password and the AC asks for a clean machine to work unconfigured.
- [x] `apps/admin/visual/manifest.mjs`'s `CREDS` resolve against a database prepared by this script,
      so `npm run visual:capture` works on a clean machine. (Re-capturing the stale
      `visual/baseline/` is **not** in scope — that is an operator-eyeball gate.)
      *Same accounts, same default password, prerequisite documented in `manifest.mjs`. Note the
      harness itself was not run end to end — see the progress report's "Not done".*
- [x] Setup documentation states the sequence — migrate → seed → seed:dev → start — and the resulting
      credentials. *`docs/runbooks/local-development-login.md` + an `.env.example` section.*
- [x] The three stale doc/comment sites above are corrected to match. *Plus a fourth found in
      passing: SYSTEM-STATE §1.3's "Auth store" row still described the deleted in-memory stores.*
- [x] A test asserts that a freshly seeded dev database can authenticate at least one manager role,
      so this cannot silently regress the way #91 S4 regressed it.
      *`test/dev-seed.e2e-spec.ts` — logs in as `ops.head@fsm.test`, asserts `OPERATIONS_HEAD`.*

## Enforced beyond the ACs — the zone preflight

`seedAuthFixtureUsers` resolves each ZM's zone by **name**. On a database where `npm run seed` has
not run, that lookup misses *silently*: the upsert succeeds and writes a `ZONAL_MANAGER` with a null
`zone_id` — an account that logs in and then 403s on every zone-scoped route. That is harder to
diagnose than the 401 this issue removes, so `seed:dev` refuses when the operational zones are absent
and names them plus the command to run. The documented order is enforced, not merely written down.

## Explicit non-goals

- Not a change to the auth architecture, the guard chain, hashing, or the login contract — #91 owns
  all of that and its design stands.
- Not production user provisioning (`POST /api/org/users` + admin CRUD already exist).
- Not seeding devices, tickets or telemetry — a dev dataset is a separate concern.
