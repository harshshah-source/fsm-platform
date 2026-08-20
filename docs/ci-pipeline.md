# CI pipeline

`.github/workflows/ci.yml` — the gate that makes "green" mean something. Owned by
[#107](../.scratch/fsm-platform-v1/issues/107-ci-concurrency-guard-migration-tests.md).

> **Why this file exists at all.** Every "green" claim on this repo used to be a local claim on one
> machine, and both suites were red for weeks without anyone knowing — the backend for 43 commits, the
> admin for 3. The pipeline is the thing that stops that. It has its own failure mode, recorded below.

## What runs, in order

| # | Step | Fails the build when |
|---|---|---|
| 1 | `Install` (`pnpm install --frozen-lockfile`) | the lockfile is out of date |
| 2 | `Provision databases` | Postgres/PostGIS did not come up |
| 3 | `Generate Prisma client` | `schema.prisma` is invalid |
| 4 | `Build (shared + backend + admin)` | any workspace fails to build |
| 5 | `Typecheck (all workspaces)` | `tsc` fails anywhere — backend, admin, mobile or shared |
| 6 | `Migrate from zero` | the committed migration set cannot build a database from empty |
| 7 | `Schema drift gate` | the migrated schema diverges from `schema.prisma` beyond the committed baseline |
| 8 | `Backend suite` (`pnpm test` in `apps/backend`) | any backend spec fails |
| 9 | `Admin suite` | any admin spec fails |
| 10 | `Mobile suite` | any mobile spec fails |
| 11 | `Admin -> backend seam` | the admin's own API client cannot talk to a real booted backend (#107 N3) |

**Steps 8–11 carry `if: '!cancelled()'`.** They are not conditional on the gates above passing, and
that is deliberate — see "The pipeline's own failure mode".

## The three databases

CI provisions three, each with exactly one job, from the `postgis/postgis:16-3.4` service container:

| Database | Used by | Why separate |
|---|---|---|
| `fsm` | nothing directly | the base URL; the suite derives its own name from it |
| `fsm_test` | the backend e2e suite | `test/global-setup.ts` migrates, truncates and seeds it, then specs boot the app against it |
| `fsm_drift` | the drift gate only | **never booted.** `PrismaService.onModuleInit` creates `runtime_lock` at boot (#130); a booted database would report that table as drift, because no migration creates it |

PostGIS is a per-database superuser bootstrap (the app role is not a superuser and `postgis` is not a
trusted extension), so the workflow creates the extension explicitly in each database rather than
relying on a template.

## Running it locally

There is no way to run the whole workflow locally, and it is not worth simulating. Run the pieces:

```bash
# from the repo root
pnpm install
pnpm turbo run build          # packages/shared/dist is gitignored; nothing typechecks without it
pnpm turbo run typecheck      # all workspaces, mobile and shared included

cd apps/backend && pnpm test   # the full backend suite (~10 min); see the note on exit codes below
cd apps/admin   && pnpm test
cd apps/mobile  && pnpm test
```

### The drift gate locally

The gate needs a database built **only** by `prisma migrate deploy` and never booted. Create it once:

```sql
-- as a superuser (the app role deliberately has no CREATEDB)
CREATE DATABASE fsm_drift OWNER fsm;
\c fsm_drift
CREATE EXTENSION IF NOT EXISTS postgis;
```

Then, from `apps/backend`:

```bash
DATABASE_URL='postgresql://fsm:<pw>@localhost:5433/fsm_drift?schema=public' npx prisma migrate deploy
DATABASE_URL='postgresql://fsm:<pw>@localhost:5433/fsm_drift?schema=public' node scripts/check-schema-drift.mjs
```

`--write` regenerates `prisma/drift-baseline.txt`. It is a deliberate act: regenerate only when you
have read the new lines and understood them, and **never against a booted database** — that bakes
`runtime_lock` into the baseline and blinds the gate to the one defect class (#144: a migration applied
to a live database but never committed) it exists to catch.

If you have no superuser and cannot create `fsm_drift`, you can get the same answer from any
migration-built database — including `fsm_test` — remembering that a booted one reports `runtime_lock`
as extra drift that CI will not see.

### Timezone

**GitHub runners are UTC; most developer machines here are IST.** That gap is not cosmetic — it has
already produced a spec that was red for 5½ hours a night and green the rest
([#256](../.scratch/fsm-platform-v1/issues/256-plant-zone-change-impact-utc-ist-day-fixture.md)), and
a cron that fired five hours after the batch it feeds
([#254](../.scratch/fsm-platform-v1/issues/254-plant-eligibility-refresh-cron-unpinned.md)). Before
trusting a green local run as evidence about CI:

```bash
cd apps/backend && TZ=UTC node scripts/run-tests.mjs
```

Any test that asserts a wall-clock day, or a cron's next firing, must be verified under `TZ=UTC` —
on an IST host such a test frequently **cannot** fail.

## Never run anything against `fsm_test` while a suite is running

`test/global-setup.ts` **truncates and reseeds** `fsm_test` at the start of *every* `vitest run`
invocation — including a single-file one. Running one while a full suite is in flight empties the
database underneath it, and the resulting failures look like anything but the cause: timeouts, zone
scoping that suddenly leaks, and `POST /api/auth/login` returning **401** for a seeded fixture user.

That last one is the tell — a fixture credential failing to authenticate is never a logic bug in the
spec that reports it; it means the users table was emptied mid-run. This has now cost two sessions:
once during #230, and again on 2026-08-20 during this issue's own `TZ=UTC` pre-flight, where it
produced 12 phantom failures across 4 files that all passed in isolation.

**Once a verification run starts, freeze the tree and stay off the database until it reports.**

## Never pipe a suite

```bash
npx vitest run … | tail -60      # <-- reports tail's exit code, not vitest's
```

During the 2026-07-22 review this reported "exit code 0" on a suite that was red the whole time. The
workflow's suite steps are bare `pnpm test` with `working-directory` set, and there is no pipe anywhere
in the file. `set -o pipefail` is not a substitute: do not pipe. Locally, if you must page the output,
use `; echo "EXIT=${PIPESTATUS[0]}"`.

## The pipeline's own failure mode (2026-08-20)

CI ran **106 times and failed 106 times**, and **not one of those runs executed a single test.**

The `Schema drift gate` began failing when two cosmetic drift lines appeared after the baseline was
written — a renamed index and a `gen_random_uuid()` column default, both of classes already tolerated
in the baseline. Because the gate sits before the suites and a failed step skips the rest, all three
suite steps were marked *skipped* on every run. The job was red, so nobody read further; the red was
cosmetic, so nobody acted; and the pipeline written to stop "both suites were red and nobody knew" was
itself running no suites, and nobody knew.

Two changes came out of that, and they are the reason the shape above is what it is:

1. **The suites run regardless** (`if: '!cancelled()'`). The gates still fail the job — nothing was
   softened — but the primary signal can no longer be switched off by an unrelated earlier step. A
   pipeline whose test signal one cosmetic line can disable is worth less than the sum of its steps.
2. **A red build has to be read, not just noticed.** A gate that fails for months without anyone
   opening it is not a gate. If CI is red and you are not going to fix it today, say why in the issue
   that owns it — do not leave it to be inferred from a red dot.

## The admin→backend seam (#107 N3)

Every other admin test mocks `fetch`, which is right for component behaviour and useless for "does the
admin actually talk to this backend?". A backend that renames a field, changes a status code or moves a
route stays green on **both** sides and breaks only in a browser.

`apps/admin/test/seam/admin-backend-http.seam.test.ts` closes that, driving the admin's own
`src/api/client.ts` against a real booted backend. It **owns the seam** and is the thing to extend when
a new admin↔backend contract needs covering.

- It is **excluded from `pnpm test`** (`vite.config.ts` `exclude`) and runs via `pnpm test:seam` with
  `vitest.seam.config.ts`. A suite that goes red whenever you have not started a backend gets ignored.
- Run it locally with the backend up on any port:
  `cd apps/admin && VITE_API_URL=http://127.0.0.1:3100/api pnpm test:seam`
- **Set `VITE_API_URL`, and only that.** The spec derives its base URL from the same expression the
  client uses, deliberately: an earlier draft used a separate variable and passed 4/4 while the client
  talked to a stale backend on the default port and the test's own fetches talked to the one under
  test. A seam test measuring two different servers and reporting green.
- `apps/admin/visual/` was the alternative candidate for this AC and was **not** chosen: it needs a
  dev server plus image baselines, and it answers "does it look right", not "do the two halves agree".
