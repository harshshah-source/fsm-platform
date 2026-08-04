# 194 — No committed path seeds a login for the dev database

Status: ready-for-agent
Type: AFK · Backend · Dev environment

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

## Current workaround (applied to this machine only — NOT a fix)

`seedAuthFixtureUsers` was run against `fsm` via a one-off script (not committed, nothing in the repo
changed), creating the 8 `*@fsm.test` accounts with password `correct-password`. Verified: login →
200, `GET /api/dashboard/zone-operations?zoneId=4&status=INACTIVE` → `{"openTickets":625,
"assigned":234,"unassigned":391,"liveBatches":37,"overriddenBatches":0,"engineersEngaged":15}`.
This does not survive a database reset and exists on no other machine.

## Acceptance criteria

- [ ] A committed, documented entrypoint (e.g. `npm run seed:dev`) leaves the dev database with at
      least one working login per manager role — `OPERATIONS_HEAD`, `CENTRAL_SERVICE_MANAGER`,
      `ZONAL_MANAGER` (one per operational zone), `WAREHOUSE_MANAGER`, `SERVICE_ENGINEER`.
- [ ] It is **idempotent** (re-runnable after a partial run, like `seedAuthFixtureUsers` already is)
      and creates only `users` + `user_credentials` rows — no reference data, no device/ticket rows.
- [ ] It **refuses to run against a non-development database.** This is the property that let the
      fixture be walled off in the first place, and it must not be lost: an explicit opt-in
      (`ALLOW_DEV_SEED=true`, or refusing when `NODE_ENV=production`) with a clear error, plus a test
      asserting the refusal. Decide and record whether the accounts keep the well-known
      `correct-password` or take it from an env var.
- [ ] `apps/admin/visual/manifest.mjs`'s `CREDS` resolve against a database prepared by this script,
      so `npm run visual:capture` works on a clean machine. (Re-capturing the stale
      `visual/baseline/` is **not** in scope — that is an operator-eyeball gate.)
- [ ] Setup documentation states the sequence — migrate → seed → seed:dev → start — and the resulting
      credentials.
- [ ] The three stale doc/comment sites above are corrected to match.
- [ ] A test asserts that a freshly seeded dev database can authenticate at least one manager role,
      so this cannot silently regress the way #91 S4 regressed it.

## Explicit non-goals

- Not a change to the auth architecture, the guard chain, hashing, or the login contract — #91 owns
  all of that and its design stands.
- Not production user provisioning (`POST /api/org/users` + admin CRUD already exist).
- Not seeding devices, tickets or telemetry — a dev dataset is a separate concern.
