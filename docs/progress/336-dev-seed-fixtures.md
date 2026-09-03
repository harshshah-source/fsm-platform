# 336 — Walkable dev fixtures for SE, verification, inventory and a Platinum case

**Done 2026-09-03.** Wave 0 of the module-gaps completion plan
(`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4). Red-first throughout; nine tests, all passing;
`tsc --noEmit` clean. No existing file's behaviour was changed — the slice is four new files plus one
line in `apps/backend/package.json`.

## What it closes

17 findings in the 2026-09-02 module-gap survey were `needs-verify` for want of test data rather than
for want of looking. The one Service-Engineer login could authenticate and then do nothing: no
`engineer_master` row, so every SE-facing route 404s; `verification_runs` empty in every environment
surveyed; van stock, component requests and shadow use empty; no Platinum ticket anywhere. This slice
makes that state reproducible from a command instead of from a walker hand-writing rows.

## The two ways the issue was wrong, and what was built instead

Both were found by reading the code before writing any, which is the rule the plan's §1 exists to
enforce. **The issue file has been corrected in place rather than left to mislead the next reader.**

**1. Its test half was already built, and has been since #215/#187.**
`test/fixtures/shared-auth-se.ts` `seedSharedAuthSeEngineer` writes the shared SE's `engineer_master`
row from `test/global-setup.ts`, before any spec runs, pinned by
`test/shared-auth-se-canonical-seed.e2e-spec.ts`. The issue's "absorbs #187 (test side)" was wrong —
#187 is closed. Nothing was rebuilt, and `global-setup.ts` was not touched.

**2. Its dev half asked for something two files explicitly decided against.** The issue said to extend
`runDevSeed`. But `shared-auth-se.ts` records *"a fixture engineer row has no business appearing in a
development database's engineer directory"*, and `global-setup.ts:46-47` repeats it. That reasoning is
sound: the dev database is an ingested mirror of production, and an operator reading its engineer
directory must not find rows a seeder invented.

**Resolution: a second, separate opt-in rather than a reversal.** `ALLOW_DEV_SEED` keeps its exact
meaning (mint the `*@fsm.test` logins) and `SEED_DEV_WALK_FIXTURES` answers a different question
(write operational rows). Setting the login flag is deliberately *not* enough — that is the first
thing the unit spec pins. Both flags are refused under `NODE_ENV=production`, unconditionally and
before the opt-in is even read. `seedAuthFixtureUsers`, `runDevSeed` and `global-setup.ts` are all
unmodified.

## Decisions worth keeping

- **The Platinum case is a scoped, expiring tier override (#157), not a re-tiered company.** Operator's
  call, taken 2026-09-03 from three options. `companies.company_tier` is Operations-Head-owned and
  global: re-tiering there would change how every zone and every report treats a real company in order
  to manufacture one fixture. A `company_tier_overrides` row is zone-scoped, carries a reason, expires
  on its own in 30 days (inside #157's two-month ceiling) and can be cancelled — the mechanism the
  product already has for exactly this.
- **The ticket's `companyTier` snapshot is re-stamped to match the override.** Found while building:
  `sweepAutoEscalations` filters on `tickets.company_tier`
  (`cross-zone/cross-zone-escalation.service.ts:77`), **not** on the effective tier. An override alone
  would have produced a Platinum case the Platinum sweep cannot see. A ticket raised while an override
  is in force would carry `PLATINUM` anyway, so stamping it is what consistency looks like, not a
  workaround. **This is not a defect in #157**: the column is a snapshot of the tier at the time work
  was raised, and a later override legitimately does not rewrite history.
- **There is no `FAILED_NO_PINGS` outcome in this schema.** The issue's AC2 used vocabulary the code
  does not have. "Failed for want of pings" is `outcome: FAILED_VERIFICATION` with
  `pingsReceivedCount: 0` — which is exactly the row V-01's stale-verdict bug acts on, so the fixture
  is the right shape under the right name.
- **The fraud row carries pings, and lands out of zone where the database offers a second one.** A
  fraud flag is raised when the first ping lands far from the engineer's submitted GPS, so a
  fraud row with zero pings would be incoherent — there would be nothing to be suspicious of. Its zone
  is load-bearing in a way the other two runs' are not: the fraud-flag read declares no zone scope at
  all (V-02), and a same-zone row cannot demonstrate that.
- **Van stock is the common kit minus exactly one item.** An empty `se_van_stock` reads as *complete*,
  because `commonKitStatus` compares against nothing — which is why the survey found the Common-Kit
  hard filter untestable. Carrying everything but the highest-id component is the smallest state in
  which "kit short" is a reachable answer, and it is the same item every time.

## The idempotence bug this slice created and then caught

The verification block first guarded on *"tickets that have no run yet"*. That predicate is true of a
**different** ticket on every pass, so a second run would have created three more rows. It was fixed to
guard on the module being empty — this fixture exists to populate a module that holds zero rows, and
once it holds any, it is not the seeder's business.

The idempotence test was **vacuous** when that was found: `fsm_test` is truncated and org-seeded, so it
holds no tickets, and "created 0 runs twice" was true whatever the guard did. The test now creates four
tickets first, and was verified to bite by temporarily weakening the guard —
`expected { verificationRuns: 3 } to deeply equal { verificationRuns: 0 }` — then restoring it. It
asserts over *every* counter by iterating the summary object, so a block added later cannot quietly
escape the contract.

## Files

| file | what |
|---|---|
| `apps/backend/src/auth/dev-fixture-seed.config.ts` | the guard — `SEED_DEV_WALK_FIXTURES`, production refusal |
| `apps/backend/src/auth/dev-fixture-seed.ts` | `seedDevWalkFixtures` + `DevWalkFixtureSummary` |
| `apps/backend/src/seed-dev-fixtures.ts` | the `seed:dev-fixtures` entrypoint |
| `apps/backend/package.json` | one script line |
| `apps/backend/test/dev-fixture-seed.spec.ts` | 2 unit tests, no database |
| `apps/backend/test/dev-fixture-seed.e2e-spec.ts` | 7 e2e, every one inside a rolled-back transaction |

Sequence is now `migrate deploy` → `seed` → `seed:dev` → `seed:dev-fixtures`.

## Acceptance criteria

| AC | state |
|---|---|
| AC1 engineer + coverage | **met** — DEDICATED, capacity 5, active, in the SE's own zone; coverage on an in-zone plant, asserted to agree with the engineer's zone |
| AC2 three verification runs | **met**, under corrected vocabulary — no-pings failure, fraud (out of zone where available), CLOSED control |
| AC3 van stock = kit minus one | **met** — every carried item at or above `minQty`, exactly one absent |
| AC4 Platinum ticket | **met** via the tier override + matching ticket snapshot; company tier untouched |
| AC5 pending leave request | **met** — forward-dated, undecided |
| AC6 second run changes nothing | **met**, and the assertion was proven to bite |

`GET /me/tickets` returning rows for `se.north` is a property of the dev database once this has run;
it is not asserted here because `fsm_test` holds no tickets to return.

## Not done, deliberately

- **Component requests and shadow-use rows.** The survey lists the inventory surface as empty, but
  those rows can only be created through the paths #352 repairs — the component-request door returns
  HTTP 500 today. Seeding them directly would fabricate a state the application cannot itself reach,
  and would make #352's own tests lie. They arrive with #352.
- **The dev database was not seeded by this session.** The slice ships the command; running it against
  `fsm` is an operator action, and the dev backend is mid-run for another session.
