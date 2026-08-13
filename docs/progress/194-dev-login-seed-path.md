# 194 — No committed path seeds a login for the dev database

**Completed 2026-08-13.** Backend + dev tooling + docs. Frozen completion record — corrections go to
INDEX / SYSTEM-STATE, not here.

Issue: `.scratch/fsm-platform-v1/issues/194-no-dev-login-seed-path.md`
Runbook produced: `docs/runbooks/local-development-login.md`

---

## What was wrong

Nothing in committed code wrote a `user_credentials` row. `npm run seed` seeds reference data only,
`prisma/seed-mock-engineers.ts` creates users with no credentials, and `seedAuthFixtureUsers` — the
only credential minter — had exactly one caller, `test/global-setup.ts`, which runs against
`fsm_test`. So a clean clone could migrate, seed, build and start the backend successfully and then
401 on every login, for every account and every password, with **no diagnostic**:
`validateCredentials` returns `null` for "no credential row" exactly as it does for "wrong password",
deliberately, so login is not an account-enumeration oracle.

Caused by #91 S4. Before the in-memory-store retirement, `InMemoryUserStore` seeded five `*@fsm.test`
users at process boot, so `npm start` alone produced working dev logins. S4 deleted that file and the
accounts survived only by being re-homed into the **test-only** fixture. The implicit provision was
removed without a replacement, and no test noticed for nine days.

## The design question, and how it was settled

The issue left two judgement calls open.

**Where the entrypoint lives.** `seedAuthFixtureUsers` is walled off from `src/seed.ts` so a seed run
against a real database can never mint `*@fsm.test` credentials. That wall is correct and stays
untouched — `src/seed.ts` is unchanged by this issue. The fix is the *other half*: a second,
separately-gated entrypoint (`src/seed-dev.ts` → `npm run seed:dev`). A door with a lock, not a hole
in the wall.

**What guards it.** Two layers, deliberately asymmetric, following #217's `OPS_EXPLORER_ENABLED`
precedent of default-off in every environment:

| Layer | Behaviour |
|---|---|
| `ALLOW_DEV_SEED` | Default **off** everywhere. Nothing runs without an operator typing it. Unset is the safe value, and unset is what every deployed environment has. |
| `NODE_ENV=production` | **Unconditional** refusal. `ALLOW_DEV_SEED` cannot override it — the flag exists to be set on a dev box, so a copied `.env` carrying it must still be refused where it matters. |

Both refusals print one actionable line and exit 1; neither touches the database.

**Password: the well-known `correct-password` stays the default**, overridable via
`DEV_SEED_PASSWORD`. The alternative — requiring an env var — would have broken AC-4 on its face:
`apps/admin/visual/manifest.mjs` `CREDS` hardcodes that password, so `npm run visual:capture` would
need configuration to work on the clean machine the AC says it must work on. Well-known is acceptable
*because* the guard is what keeps these accounts off any database that matters, and the accounts are
confined to the reserved `.test` TLD. A blank `DEV_SEED_PASSWORD` is **rejected** rather than falling
back, so an operator who believed they had replaced the default is never silently given it back.

**A third, data-derived guard was considered and rejected**, and is worth not re-litigating: refusing
when the target database already holds credentials for non-`@fsm.test` users. It is strictly stronger
than an env check, but the dev database here is an ingested mirror that legitimately looks like
production, and one real-email login created through the admin UI would lock a developer out of the
seeder with no override short of a third flag. The residual risk it would have covered — a box with
`NODE_ENV` unset *and* `ALLOW_DEV_SEED` set — is stated in `dev-seed.config.ts` rather than hidden.

## What changed

| File | Change |
|---|---|
| `src/auth/dev-seed.config.ts` | **new** — `readDevSeedConfig(env)`, the whole refusal contract as a pure function |
| `src/auth/dev-seed.ts` | **new** — `runDevSeed(client, env)` + `missingDevSeedZones` (pure) |
| `src/seed-dev.ts` | **new** — the `npm run seed:dev` entrypoint; echoes host/db, never the password |
| `src/auth/auth-fixture-seed.ts` | optional `password` param; `FIXTURE_EMAILS` exported; client type narrowed to `AuthFixtureSeedClient` |
| `src/auth/credential-seed.ts` | client type narrowed to `Pick<PrismaClient, 'userCredential'>` |
| `src/org/org-seed.ts` | stale docstring corrected (site 2 of 3) |
| `package.json` | `seed:dev` script |
| `test/setup-env.ts` | `ALLOW_DEV_SEED` / `DEV_SEED_PASSWORD` added to #182's app-namespace allowlist |
| `test/dev-seed.spec.ts` | **new** — 10 tests, no database |
| `test/dev-seed.e2e-spec.ts` | **new** — 4 tests against a real database |
| `test/setup-env-allowlist.spec.ts` | +2 assertions for the new keys |

**No migration, no schema change, no auth-architecture change, no route change.** `src/seed.ts` is
untouched.

Two implementation decisions worth not re-litigating:

- **The fixture list is reused, not duplicated.** `runDevSeed` composes `seedAuthFixtureUsers`, so
  the eight accounts a spec logs in as and the eight a browser logs in as are the same rows with the
  same UUIDs. A second definition of "the dev accounts" is how the suite and a developer's browser
  start disagreeing about who exists.
- **The client types were narrowed rather than widened.** `AuthFixtureSeedClient` is
  `Pick<PrismaClient, 'zone' | 'user' | 'userCredential'>`. That is not tidiness: a Prisma
  *transaction* client satisfies it, which is what makes the creation-from-empty test possible
  (below). `ensureCredential` narrowed the same way.

## A guard the issue did not ask for

`seedAuthFixtureUsers` resolves each ZM's zone by **name**. Against a database where `npm run seed`
has not run, that lookup misses *silently* — the upsert still succeeds and writes a `ZONAL_MANAGER`
with a null `zone_id`. That account logs in fine and then 403s on every zone-scoped route: a working
login that cannot do anything, which is a materially harder thing to diagnose than the 401 this issue
exists to remove. So the documented order is enforced, not merely written down — `missingDevSeedZones`
is checked before any write and the error names the missing zones and the command to run.

## How it was tested

Red-green per slice, per-file (the full local suite is not a reliable green/red signal — #156).

**The refusal is what got pinned, not the seeding.** A credential minter with a well-known password
that can be pointed at production is a worse defect than the one it fixes, so the guard is a pure
function over an `env` object — no database, no process state — and carries 7 of the 10 unit tests.
Callers pass env in explicitly, which also means `test/setup-env.ts`'s allowlist scrub can never
change what the seeder does under test.

**Creation-from-empty is proven inside a transaction that is deliberately rolled back.** The suite
shares one long-lived `fsm_test` database that is never truncated between files (#156), so a test
that genuinely deleted the fixture credentials to watch them be recreated would 401 every login in
every file that ran afterwards. The e2e deletes them inside `$transaction`, runs the seeder twice
(idempotency), asserts 8 credentials and that every ZM carries a non-null zone, then throws to roll
the whole thing back. This is the reason the client types were narrowed.

| Lane | Result |
|---|---|
| `test/dev-seed.spec.ts` | 10 passed |
| `test/dev-seed.e2e-spec.ts` | 4 passed |
| `test/setup-env-allowlist.spec.ts` | 5 passed |
| Auth/seed neighbours — `auth`, `login`, `refresh`, `per-zone-zm-logins`, `book-role-logins`, `org-seed`, `org-zones`, `org-users`, `global-guard-validation`, `install-lifecycle-zone-scope` | 42 passed, 10 files |
| `tsc --noEmit` (`tsconfig.json`) | clean |
| `tsc --noEmit -p tsconfig.test.json` | 93 errors — the **unchanged** pre-existing baseline, none in any file this issue touched |

**Also exercised for real, against the live dev database `fsm` @ localhost:5433:**

| Invocation | Result |
|---|---|
| `npm run seed:dev` | refused — "ALLOW_DEV_SEED is not set…", exit 1 |
| `ALLOW_DEV_SEED=true NODE_ENV=production npm run seed:dev` | refused — "NODE_ENV=production… does not override", exit 1 |
| `ALLOW_DEV_SEED=true npm run seed:dev` | `Seeded 8 dev login(s) on localhost:5433/fsm`, all eight listed, existing credentials untouched |

That third run is also the retirement of this machine's one-off workaround: the accounts that existed
here only because a previous session hand-ran the test fixture are now produced by committed code.

## Acceptance criteria

| AC | State |
|---|---|
| Committed entrypoint leaves a dev DB with a login per manager role | met — `npm run seed:dev`, 8 accounts covering OH / CSM / WM / SE / ZM×4 |
| Idempotent; creates only `users` + `user_credentials` | met — asserted twice-run, and by a before/after census over zones, plants, devices, tickets, users, credentials |
| Refuses a non-development database, with a clear error + a test | met — two layers, 7 unit tests + 2 e2e, both refusals exercised for real |
| Password decision recorded | met — default kept, `DEV_SEED_PASSWORD` override, blank rejected; reasoning above and in `dev-seed.config.ts` |
| `visual/manifest.mjs` `CREDS` resolve against a prepared database | met — same accounts, same default password; prerequisite documented in `manifest.mjs` |
| Setup documentation states the sequence and credentials | met — `docs/runbooks/local-development-login.md` + `.env.example` |
| Three stale doc/comment sites corrected | met — SYSTEM-STATE §3j (and the §1.3 "Auth store" row, found stale in passing), `org-seed.ts`, #133's done-note |
| A test asserts a freshly seeded dev DB can authenticate a manager role | met — `dev-seed.e2e-spec.ts` logs in as `ops.head@fsm.test` and asserts `OPERATIONS_HEAD` in the JWT |

## Not done

- **`npm run visual:capture` has not been run.** AC-4 asks that the credentials resolve, which they
  do — same eight accounts, same password, and the harness's login is a form POST against the same
  endpoint `dev-seed.e2e-spec.ts` exercises. But the harness itself was not executed end to end here,
  so "the CREDS now work" is an argument from identical inputs, not an observation. Re-capturing
  `visual/baseline/` was explicitly out of scope (operator-eyeball gate) and remains stale since
  2026-07-28.
- **The two commissioning pages still have not been opened in a browser.** #194 removes the *reason*
  they hadn't been — a dev login is now reproducible on any machine — but the eyeball pass is its own
  task and was not done in this session. SYSTEM-STATE was updated to say exactly that.
- **The residual guard gap is open by decision, not oversight:** a box with `NODE_ENV` unset *and*
  `ALLOW_DEV_SEED` set passes both layers. See the design section above for why the data-derived third
  layer was rejected.
- **`tsconfig.test.json`'s 93 type errors are untouched and unowned.** Baseline identical before and
  after; still worth filing, as the previous session noted.
