# Runbook — from a clean clone to a login that works

Owner issue: [#194](../../.scratch/fsm-platform-v1/issues/194-no-dev-login-seed-path.md) ·
First written 2026-08-13

This is the path from a checkout to a browser session on the admin dashboard against your own
development database. It exists because that path had a hole in it: **no committed code created a
`user_credentials` row**, so a clean clone could migrate, seed, build and start the backend
successfully — and then 401 on every login, for every account and every password.

The 401 carries no diagnostic, and that is deliberate rather than an oversight:
`PrismaUserStore.validateCredentials` returns `null` for *"this user has no credential row"* exactly
as it does for *"wrong password"*, so login cannot be used as an account-enumeration oracle. The
symptom is therefore a wall of identical `POST /api/auth/login → 401 Unauthorized`, with nothing
anywhere saying "the credential table is empty".

---

## The sequence

From `apps/backend/`, with `DATABASE_URL` set in `.env` (see `.env.example`):

```bash
npx prisma migrate deploy   # 1. schema
npm run build               # 2. the seed entrypoints are compiled JS, so build precedes both seeds
npm run seed                # 3. reference/org data: zones, plants, tiers, SLA + priority config
npm run seed:dev            # 4. the eight dev logins        ← needs ALLOW_DEV_SEED, see below
npm start                   # 5. :3000, prefix /api
```

Then `apps/admin/`: `npm run dev` → <http://localhost:5173>.

**Steps 3 and 4 are not interchangeable, and the order is enforced.** Zonal-manager accounts are
scoped by zone *name*, resolved against the `zones` table. Against an unseeded database that lookup
misses silently and the upsert still succeeds — producing a `ZONAL_MANAGER` with a null `zone_id`,
an account that logs in and then 403s on every zone-scoped route. That is a materially harder thing
to diagnose than the 401 this runbook removes, so `seed:dev` refuses when the operational zones are
absent and tells you to run `npm run seed` first.

Every step is idempotent. Re-running `seed:dev` after a partial run is safe, and it **never rotates
an existing password** — so it cannot change a credential out from under a live session.

## Step 4 needs an explicit opt-in

`npm run seed:dev` refuses by default, in every environment:

```
Refusing to seed dev logins: ALLOW_DEV_SEED is not set. …
```

Set `ALLOW_DEV_SEED=true` in `apps/backend/.env` once you have confirmed `DATABASE_URL` points at
your development database. The command echoes the host and database name it wrote to (never the
password) so you can see where the accounts landed.

It is refused outright under `NODE_ENV=production`, and `ALLOW_DEV_SEED` does not override that.
Real accounts are provisioned through `POST /api/org/users` and the admin user CRUD, never this.

## The accounts

Password `correct-password` unless you set `DEV_SEED_PASSWORD` (see `.env.example` — doing so means
the visual harness below needs its `CREDS` changed to match).

| Email | Role | Zone |
|---|---|---|
| `ops.head@fsm.test` | `OPERATIONS_HEAD` | all |
| `csm@fsm.test` | `CENTRAL_SERVICE_MANAGER` | all (acting-as-zone) |
| `wm@fsm.test` | `WAREHOUSE_MANAGER` | all |
| `zm.north@fsm.test` | `ZONAL_MANAGER` | North (1) |
| `zm.south@fsm.test` | `ZONAL_MANAGER` | South (2) |
| `zm.east@fsm.test` | `ZONAL_MANAGER` | East (3) |
| `zm.west@fsm.test` | `ZONAL_MANAGER` | West (4) |
| `se.north@fsm.test` | `SERVICE_ENGINEER` | North (1) |

These are the same eight accounts the e2e suite logs in as (`test/global-setup.ts` seeds them into
`fsm_test` through the same function), so a behaviour you see in the browser and a behaviour a spec
asserts are talking about the same user. They are also exactly what `apps/admin/visual/manifest.mjs`
`CREDS` expects, so `npm run visual:capture` (FE-00) works on a clean machine once step 4 has run.

`prisma/seed-mock-engineers.ts` is a separate, optional dataset — 5 ZM + 75 SE rows for planner and
workload surfaces. It creates **users without credentials**; none of them can log in, by design.

## Why this is a seed and not something the app does at boot

Until #91 S4 (2026-08-03) it *was* something the app did at boot: `InMemoryUserStore` seeded five
`*@fsm.test` users at process start, so `npm start` alone produced working dev logins with no
database involved at all. Retiring that store for the Postgres-backed one was correct — sessions now
survive a restart — but the accounts survived only by being re-homed into the **test-only** fixture,
and the implicit dev-login provision was removed without a replacement. #194 is that replacement.

The fixture's walling-off from `src/seed.ts` stays: a `npm run seed` against a real database must
never be able to mint `*@fsm.test` credentials. `seed:dev` is a separate gated entrypoint rather
than a relaxation of that wall — the reasoning, including a residual risk that is stated rather than
hidden, is in `src/auth/dev-seed.config.ts`.

## If a login still 401s

1. **Did step 4 actually run?** It prints `Seeded 8 dev login(s) on <host>/<db>`. A refusal prints a
   one-line reason and exits 1.
2. **Right database?** The `seed:dev` output names the host and database. Compare it with the
   backend's own `DATABASE_URL` — seeding `fsm` and starting against `fsm_test` (or vice versa) is
   the easy mistake here.
3. **Changed `DEV_SEED_PASSWORD` after a first run?** The seeder never rotates an existing hash, so
   the accounts still carry the *original* password. Delete the `user_credentials` rows for the
   `*@fsm.test` users and re-run.
4. **`ops.head@fsm.test`, not `ops@fsm.test`.** The exact strings are in the table above.
