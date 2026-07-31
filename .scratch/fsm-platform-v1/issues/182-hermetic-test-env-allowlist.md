# 182 — `test/setup-env.ts` is a deny-list, so the developer's `.env` decides test outcomes — invert it to an allowlist

Status: ready-for-agent
Type: AFK · Backend (test infrastructure)

Filed 2026-07-31. **Second in the repair set, landed together with
[#181](./181-business-sweep-scheduler-arity-and-config-drift.md).** Sequence:
**[#180](./180-test-db-determinism-truncate-reseed.md) → #181 + #182 together → [#183](./183-tier-override-frozen-clock-check-violation.md).**

> **Do not start until #180 is done**, and **read #181 §"Why A and B are one mechanism" before you
> touch this file.** Landing this issue *alone* makes the suite look worse. That is expected — see
> "Read this first".

---

## Read this first — landing #182 alone makes the suite look worse

Making the env hermetic sets `BUSINESS_SWEEPS_ENABLED` to its test default (`"false"`) inside the
suite. Because of #181's arity bug, every spec that constructs the scheduler with `{ enabled: true }`
currently has that argument **silently discarded** and falls back to the ambient env — so with the
flag forced off, those specs start returning `{ ran: false, reason: 'DISABLED' }` where they expect
`{ ran: true }`. **New failures will appear. You did not cause them.** They are #181's failures
becoming visible.

Land #181 and #182 in one change, or land #181 first.

## Why A1 does not make this issue unnecessary

#181's fix reconnects the `config` parameter, so those four spec files stop consulting `process.env`
for `enabled` at all — which incidentally clears every symptom listed below. **This issue is still
required**, for a reason that has nothing to do with the scheduler:

The current harness is a **deny-list**. It neutralises exactly three things
(`test/setup-env.ts:18-27`): keys starting with `AUTOPLANT_MYSQL` (`:18-20`), `DATABASE_URL` (`:22`),
`JWT_ACCESS_SECRET` (`:27`). Every other variable in a developer's `.env` reaches the suite
unmodified. A deny-list guarantees recurrence with the **next** flag anyone adds — this is the second
time it has bitten (the first is recorded in `.env.example:60-63`, below). Inverting it is the only
fix that closes the class rather than the instance.

## The confirmed symptom (direction verified)

The specs assert **dormancy**. They expect `{ ran: false, reason: 'DISABLED' }` and receive
`{ ran: true }`, because `apps/backend/.env:41` sets `BUSINESS_SWEEPS_ENABLED="true"`:

- `test/business-sweep-scheduler.e2e-spec.ts:122-127` (the assertion at `:125-126`)
- `test/business-sweep-scheduler-install.e2e-spec.ts:116`
- `test/business-sweep-scheduler-intraday.e2e-spec.ts:166`

## The second instance, already documented and waiting to fire

`.env.example:60-63` says verbatim:

> Do **NOT** put this in your committed-shape `.env`: the e2e suite asserts the DEFAULT dev identity
> (dev ZM = zone 1), and a persistent value would re-point that identity for the **~59 specs** that
> log in as the dev ZM.

That is `DEV_AUTH_ZONE`. It is read at `src/auth/dev-zone-resolver.ts:52` and, when set, changes the
`zone_id` claim of every zone-scoped dev login. **74 spec files** log in as `zm.north@fsm.test`
(`grep -l 'zm.north@fsm.test' test/*.e2e-spec.ts | wc -l` → 74, higher than the ~59 recorded) and
`test/dispatch-transparency-api.e2e-spec.ts:23` hardcodes `const ZM_ZONE = 1n`. Today `.env` does not
set it, so nothing is red — the repo is one developer's one-off validation run away from 74 files
going red for a reason nobody will connect to their environment. **The allowlist must cover it.**

---

# Resolved facts

## R1 — every environment variable the backend reads

Compiled from `grep -rhon "process\.env\.[A-Z_0-9]*\|\benv\.[A-Z][A-Z_0-9]*" src test --include=*.ts`
plus the two dynamic readers (`envInt` in `src/prisma/prisma.service.ts:7-12`, and
`process.env[key]` in `test/setup-env.ts:18-20`).

### R1.a — MUST be set to a fixed test value (the suite is wrong without it)

| Var | Fixed test value | Why | Citation |
|---|---|---|---|
| `DATABASE_URL` | `testDatabaseUrl()` | Re-points every `PrismaService` at the isolated sibling DB. **Already done.** | `test/setup-env.ts:22`; derivation `test/test-db-url.ts:12-24` |
| `JWT_ACCESS_SECRET` | `'test-jwt-access-secret-000000000000000000'` | #98 boot config rejects the old default and anything under 32 chars. **Already done.** | `test/setup-env.ts:27`; validation `src/config/boot-config.ts:26` |
| `BUSINESS_SWEEPS_ENABLED` | **`'false'`** | The specs assert the default-OFF posture. **This is the new one.** | `src/scheduling/business-sweep-scheduler.service.ts:64` |
| `INGESTION_SCHEDULER_ENABLED` | `'false'` | Same class; matches `.env:18` and `.env.example:43` | `src/ingestion/…` scheduler config |
| `PARTITION_MAINTENANCE_ENABLED` | `'false'` | Same class; matches `.env:24` | `src/…/partition-maintenance` config |
| `DEV_AUTH_ZONE` | **unset (delete)** | 74 specs assert dev ZM = zone 1. `.env.example:60-63` already forbids a persistent value; enforce it instead of documenting it. | `src/auth/dev-zone-resolver.ts:52`; `src/auth/user-store.ts:28,48` |
| `AUTOPLANT_MYSQL_*` (7 vars) | **unset (delete)** | The integration is designed UNSET in dev/test/CI; set values flip `SOURCE_READER` to the real reader and make `source.connected` true. **Already done.** | `test/setup-env.ts:18-20`; rationale `:7-12`; `.env.example:24-29` |

The seven `AUTOPLANT_MYSQL_*` keys are `HOST`, `PORT`, `USER`, `PASSWORD`, `DB_WIDGETS`,
`DB_MASTERS`, `SSL`, plus the legacy fallback `AUTOPLANT_MYSQL_DATABASE` (`.env.example:37`). The
existing `startsWith('AUTOPLANT_MYSQL')` sweep covers all of them; keep that mechanism.

### R1.b — safe to leave UNSET (every one has a code default; none is read by a passing spec)

Leaving these unset is the *desired* hermetic state — the app's own defaults are what the specs are
written against.

| Var | Default | Citation |
|---|---|---|
| `TEST_DATABASE_URL` | derived from `DATABASE_URL` + `_test` | `test/test-db-url.ts:13-14` |
| `ADMIN_ORIGIN` | `'http://localhost:5173'` | `src/app.config.ts:32` |
| `BODY_LIMIT_JSON` | `'1mb'` | `src/app.config.ts:37` |
| `PORT` | `3000` | `src/main.ts:29` |
| `PUBLIC_API_URL` | `'http://localhost:3000'` | `src/ticketing/non-operational.service.ts:44` — **module-scope const**, see R4 |
| `INSTALL_CSV_MAX_ROWS` | code default | `src/ticketing/install.service.ts:70` |
| `AUTOPLANT_SNAPSHOT_CHUNK_SIZE` | `90`, clamped 1–99 | `src/ingestion/autoplant/autoplant-sync.ts:28` — **module-scope const** |
| `AUTOPLANT_SOURCE_UTC_OFFSET_MIN` | unset ⇒ no offset | `src/ingestion/autoplant/autoplant-sync.ts:95-96`; `src/ingestion/ingestion.module.ts:159` |
| `AUTOPLANT_QUERY_TIMEOUT_MS` | code default | `src/ingestion/autoplant/autoplant-mysql.client.ts:69` |
| `AUTOPLANT_CONNECT_TIMEOUT_MS` | code default | `src/ingestion/autoplant/autoplant-mysql.client.ts:75` |
| `INGESTION_RECON_MAX_DRIFT` | `0` | `src/ingestion/autoplant/health.service.ts:97,120` |
| `INGESTION_STALE_RUN_MIN` | `30` (`.env` sets `45`) | `.env:21`, `.env.example:46` |
| `INGESTION_MASTERS_CRON` | `'0 2 * * *'` | `.env.example:44` |
| `INGESTION_TELEMETRY_CRON` | `'*/30 * * * *'` | `.env.example:45` |
| `PARTITION_MAINTENANCE_CRON` | code default | partition-maintenance config |
| `PLANT_ELIGIBILITY_REFRESH_CRON` | `'30 4 * * *'` | `src/org/plant-eligibility-refresh-scheduler.service.ts:10,24` |
| `BUSINESS_SWEEP_DISPATCH_CRON` | `'0 5 * * *'` | `src/scheduling/dispatch-run.service.ts:243-244` |
| `BUSINESS_SWEEP_*_CRON` (11 vars) | the `DEFAULT_*_CRON` consts | `src/scheduling/business-sweep-scheduler.service.ts:31-41,65-75` |
| `DB_POOL_MAX` / `DB_POOL_ACQUIRE_TIMEOUT_MS` / `DB_STATEMENT_TIMEOUT_MS` / `DB_IDLE_IN_TX_TIMEOUT_MS` | `25` / `5000` / `120000` / `60000` | `src/prisma/prisma.service.ts:41-45` |

The eleven `BUSINESS_SWEEP_*_CRON` names are `VERIFICATION`, `INSTALL_VERIFICATION`,
`INTRADAY_TIMEOUT`, `CROSS_ZONE`, `REPEAT_ESCALATION`, `TIER_OVERRIDE_EXPIRY`, `SOFT_INACTIVE`,
`SYSTEM_EFFICIENCY`, `FLEET_UPTIME`, `ROOT_CAUSE`, `ZM_PERFORMANCE`.

### R1.c — read by tests only; **must be passed through untouched**

| Var | Purpose | Citation |
|---|---|---|
| `BOOK8_RUN` | Opt-in gate — the Book8 dataset specs run only when `=== '1'`, so they never slow the normal suite. Deleting it would make `BOOK8_RUN=1 npx vitest run …` silently skip everything. | `test/env/book8/book8-env.e2e-spec.ts:18`, `test/env/book8/book8-recommender.e2e-spec.ts:19` |
| `BOOK_DATASET` | Selects an alternate dataset path for the Book8 harness. | `test/env/book8/book8-dataset.ts:159` |

### R1.d — read by CLI tools only, never by the suite

`USER` / `USERNAME` — `src/build-info/runtime-lock-reset.ts:105`, an actor label for the
`runtime-lock:reset` tool. Not suite-relevant, but do not delete them (R3).

## R2 — every master switch in `apps/backend/.env`, and its test default

The report asked to "find the rest". **There are exactly three, and no more.** The full file is 43
lines; verified line by line.

| Line | Switch | Current `.env` value | Test default | Note |
|---|---|---|---|---|
| `.env:18` | `INGESTION_SCHEDULER_ENABLED` | `"false"` | `'false'` | Already off; pin it so it stays off |
| `.env:24` | `PARTITION_MAINTENANCE_ENABLED` | `"false"` | `'false'` | Already off; pin it |
| **`.env:41`** | **`BUSINESS_SWEEPS_ENABLED`** | **`"true"`** | **`'false'`** | **The one causing the failures.** Shared switch — also gates `DispatchSchedulerService` (`src/scheduling/dispatch-scheduler.service.ts:21`) and `PlantEligibilityRefreshScheduler` (`src/org/plant-eligibility-refresh-scheduler.service.ts:23`) |

`.env:21` `INGESTION_STALE_RUN_MIN="45"` is a threshold, not a switch, and belongs in R1.b.

Two more gates exist in **code but not in `.env`**, and the allowlist must account for them:

- `DEV_AUTH_ZONE` — behaviour-changing opt-in (R1.a: force unset).
- `BOOK8_RUN` — test-side opt-in (R1.c: pass through).

**Stale reference to fix while you are here:** `test/verification-staleness.e2e-spec.ts:9` cites
`` `BUSINESS_SWEEPS_ENABLED="true"` in `.env:38` ``. It is now `.env:41`. Comment only — that spec
calls `VerificationService` directly and is not flag-dependent.

## R3 — what breaks under a *strict* allowlist, and the design that avoids it

**A whole-environment wipe — "delete every key not on the list" — will break the run.** Do not
implement it that way.

- **`PATH` / `PATHEXT` / `ComSpec` / `SystemRoot` / `TEMP` / `windir`** — `test/global-setup.ts:20-25`
  spawns `npx prisma migrate deploy` via `execFileSync(..., { shell: true })`. On Windows (this repo's
  platform) that needs `ComSpec` and `PATHEXT`; on any platform it needs `PATH`. `globalSetup` runs in
  the main vitest process and `setup-env.ts` runs per worker, so this particular spawn happens before
  the wipe — but anything spawning a process from a worker would break, and the failure mode is
  obscure.
- **`NODE_ENV`** — not read anywhere in `src/` or `test/` (grep confirms zero functional reads), but
  vitest, SWC and Node's own module resolution consult it. Do not delete it.
- **`PG*`** (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE`, `PGAPPNAME`, …) — **this is the
  one that cuts both ways.** `node-postgres` (via `@prisma/adapter-pg`) falls back to `PG*` for any
  connection field absent from the URL. A developer with `PGDATABASE` or `PGSSLMODE` set could shift
  the suite's connection. But blanket-deleting them is also wrong on a machine where they are the
  only way `psql`-adjacent tooling works. **Decision: neutralise `PG*` explicitly, as a named family,
  the same way `AUTOPLANT_MYSQL*` is handled today** — the test DB URL at `test/setup-env.ts:22` is
  fully qualified, so nothing legitimate needs them. Record this as a deliberate call, not an
  accident.
- **`CI`** — not read by `src/` or `test/`. Leave it alone; CI providers and tooling read it.
- **`TZ`** — not read by the app. The Postgres *session* timezone is pinned to UTC independently via
  pool startup parameters (`-c timezone=UTC`, `src/prisma/prisma.service.ts:52`) and pinned by
  `test/prisma-session-timezone.spec.ts`, so DB-side time is already TZ-independent. Node-side `TZ`
  still affects `new Date(...)` rendering in specs. **Recommend pinning `TZ = 'UTC'`** — it is cheap,
  it matches ADR-0025, and it removes a whole class of "passes on my machine". Flag it in the PR: if
  pinning `TZ` turns any spec red, that spec had a latent local-time dependency and the finding is
  worth having.

**The design that satisfies both constraints: allowlist the application's namespace, not the whole
environment.** `test/setup-env.ts` should:

1. Build the exact set of app-owned variable names — the R1.a + R1.b + R1.c tables, plus the prefix
   families `AUTOPLANT_`, `BUSINESS_SWEEP`, `INGESTION_`, `PARTITION_`, `PLANT_ELIGIBILITY_`, `DB_`.
2. **Delete every `process.env` key matching that namespace** — this is the inversion: unknown
   app-namespace keys are removed rather than passed through, so the *next* flag someone adds is
   neutralised by default instead of leaking.
3. **Then set the R1.a fixed values explicitly.**
4. Never touch a key outside that namespace. `PATH`, `NODE_ENV`, `CI`, `TEMP`, `USER`, `BOOK8_RUN`,
   `BOOK_DATASET` survive untouched, with `PG*` and `TZ` as the two named, justified exceptions.

Keep the file's existing structure and its explanatory docstring style
(`test/setup-env.ts:3-17`) — that comment is why the current behaviour is understandable at all;
extend it rather than replacing it with a bare list.

## R4 — module-scope env reads: two variables that cannot be changed per-test

Two reads happen at **module load**, not per call:

- `src/ticketing/non-operational.service.ts:44` — `const PUBLIC_API_URL = process.env.PUBLIC_API_URL ?? …`
- `src/ingestion/autoplant/autoplant-sync.ts:28` — `const CHUNK = … Number(process.env.AUTOPLANT_SNAPSHOT_CHUNK_SIZE) …`

`setup-env.ts` is a `setupFile` and runs before any `src/` import, so it controls both correctly.
But **no per-test `process.env` mutation can affect them** — that is a constraint on R5, and on
anyone tempted to reach for `vi.stubEnv` for these two.

## R5 — how specs that need the flag ON should get it (recommendation)

**Recommendation: pass it explicitly through the constructor, never through the environment. Do not
add per-test env mutation.**

Every scheduler in this codebase already accepts an optional config override that beats the env:

- `BusinessSweepSchedulerService(..., config?: Partial<BusinessSweepSchedulerConfig>)` —
  `src/scheduling/business-sweep-scheduler.service.ts:125-127`
- `readDispatchSchedulerConfig(env)` / `readPlantEligibilityRefreshConfig(env)` both take an `env`
  parameter defaulting to `process.env` (`src/scheduling/dispatch-scheduler.service.ts:21`,
  `src/org/plant-eligibility-refresh-scheduler.service.ts:23`), and the specs already exercise them
  by passing a **literal object**: `readBusinessSweepSchedulerConfig({ BUSINESS_SWEEPS_ENABLED: 'true' })`
  (`test/business-sweep-scheduler.e2e-spec.ts:88`), `readDispatchSchedulerConfig({ … })`
  (`test/dispatch-scheduler.e2e-spec.ts:23`), `readPlantEligibilityRefreshConfig({ … })`
  (`test/plant-eligibility-refresh-scheduler.e2e-spec.ts:26`).

So the seam already exists, is already used correctly by three specs, and needs no new mechanism. The
scheduler specs' `{ enabled: true }` argument is exactly this seam — it is only ineffective because of
#181's arity bug, which #181 fixes.

**Rejected: `vi.stubEnv` / `process.env.X = …` inside `beforeEach`.** It is order-dependent (a leaked
stub changes an unrelated later file), it cannot reach the R4 module-scope reads, and it reintroduces
exactly the ambient-environment coupling this issue exists to remove.

**If a future spec genuinely needs the process env flipped** (none does today), it must set it in its
own `beforeAll`, restore it in `afterAll`, and say in a comment why the constructor seam was
insufficient.

---

## Acceptance criteria

- [ ] **AC-1** — `test/setup-env.ts` is an allowlist: it deletes every `process.env` key in the
      application namespace (R3 step 1–2) and then sets the R1.a fixed values. Verified by a new unit
      spec that seeds `process.env` with a junk app-namespace key (e.g. `BUSINESS_SWEEP_FUTURE_FLAG`)
      and asserts it is gone after the harness runs.
- [ ] **AC-2** — `BUSINESS_SWEEPS_ENABLED` is `'false'` inside the suite regardless of `.env`.
      Verified by running the targeted command with `.env:41` set to `"true"` — the three dormancy
      assertions (`business-sweep-scheduler.e2e-spec.ts:125-126`,
      `-install:116`, `-intraday:166`) pass.
- [ ] **AC-3** — `INGESTION_SCHEDULER_ENABLED` and `PARTITION_MAINTENANCE_ENABLED` are pinned to
      `'false'`, and `DEV_AUTH_ZONE` is deleted. Verified by setting `DEV_AUTH_ZONE='EAST'` in `.env`
      and confirming `dispatch-transparency-api.e2e-spec.ts` (which hardcodes `ZM_ZONE = 1n` at `:23`)
      still passes.
- [ ] **AC-4** — `PG*` is neutralised and `TZ` is pinned to `'UTC'`, each with a one-line comment
      recording the decision. If pinning `TZ` reddens any spec, that spec is listed in the completion
      report as a new finding (do **not** silently drop the pin).
- [ ] **AC-5 — nothing outside the app namespace is touched.** `PATH`, `NODE_ENV`, `CI`, `TEMP`,
      `USER`/`USERNAME`, `BOOK8_RUN` and `BOOK_DATASET` are present and unchanged after the harness
      runs (assert in the AC-1 spec). Verified functionally by
      `BOOK8_RUN=1 npx vitest run test/env/book8/book8-env.e2e-spec.ts` still executing rather than
      skipping.
- [ ] **AC-6 — the class is closed, not the instance.** `test/setup-env.ts` carries a comment stating
      that new `BUSINESS_SWEEP*` / `INGESTION_*` / `PARTITION_*` / `*_ENABLED` variables are
      neutralised **by default** and that a spec needing one ON must pass it through the constructor
      seam (R5), not the environment. `.env.example` gains a pointer to that rule next to the master
      switches.
- [ ] **AC-7** — the stale citation at `test/verification-staleness.e2e-spec.ts:9` reads `.env:41`.
- [ ] **AC-8 — the suite is env-independent.** The targeted command below is fully green with
      `.env:41` set to `"true"` **and** with it set to `"false"`, with byte-identical output.

## Out of scope — do not do these here

- **Any change under `src/`.** Not one line. Every default listed in R1.b is correct.
- **Changing `apps/backend/.env`** — it stays `BUSINESS_SWEEPS_ENABLED="true"` for the whole repair
  programme so #181/#183 are measured against the env their specs were written under. Returning it to
  `"false"` before any dev server runs is audit R6 / [#148](./148-verification-stale-telemetry.md).
- **The constructor-arity fix** — that is #181. This issue does not add arguments to any
  `new BusinessSweepSchedulerService(...)` call.
- **`test/global-setup.ts` / truncation** — that is #180 and must already be done.
- **`vi.stubEnv` or per-test `process.env` mutation** anywhere — explicitly rejected in R5.
- **A whole-environment wipe.** Explicitly rejected in R3; it breaks `execFileSync` and Node tooling.
- **Deleting `BOOK8_RUN` / `BOOK_DATASET`** — they are the opt-in gates for the Book8 harness and
  deleting them makes it silently skip.
- **Committing a `.env.test` file.** The suite already derives its DB from `DATABASE_URL`
  (`test/test-db-url.ts:12-24`); a second env file is a second source of truth and a second place to
  forget a flag.

## Targeted test command

From `apps/backend/`:

```bash
npx vitest run \
  test/business-sweep-scheduler.e2e-spec.ts \
  test/business-sweep-scheduler-install.e2e-spec.ts \
  test/business-sweep-scheduler-intraday.e2e-spec.ts \
  test/dispatch-scheduler.e2e-spec.ts \
  test/plant-eligibility-refresh-scheduler.e2e-spec.ts \
  test/verification-staleness.e2e-spec.ts \
  test/dispatch-transparency-api.e2e-spec.ts
```

Run it **three times**: with `.env:41` `="true"`, with `="false"`, and with
`DEV_AUTH_ZONE='EAST'` added. All three must be green and identical — that is AC-8 and AC-3.
**Restore `.env` to `BUSINESS_SWEEPS_ENABLED="true"` with no `DEV_AUTH_ZONE` line when done.**

## UI surfaces

None.

## Reference

`.env.example:8-21` (test DB bootstrap), `:39-47` (ingestion switches), `:49-63` (the `DEV_AUTH_ZONE`
warning this issue turns into an enforced rule).

## Blocked by

- **[#180](./180-test-db-determinism-truncate-reseed.md)** — hard block.
- **Land with [#181](./181-business-sweep-scheduler-arity-and-config-drift.md).** Landing this issue
  first makes the suite look worse — see "Read this first".
