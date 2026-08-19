# #255 — five specs claimed an exclusivity none of them held

**Done 2026-08-19**, commit `def334b`. Test infrastructure only; no `src/` behaviour changed. The one non-test edit is a
doc comment on `SeCoverage` in `prisma/schema.prisma`.

## What this closes

`se_coverage` carries two uniques and Prisma can only see one of them:

```sql
-- visible: @@unique([seId, plantId]) in the schema
-- invisible: raw SQL, migrations/20260618121101_add_engineer_se_coverage/migration.sql:60
CREATE UNIQUE INDEX "se_coverage_dedicated_se_key" ON "se_coverage"("se_id") WHERE "coverage_type" = 'DEDICATED';
```

A partial predicate is not expressible in the Prisma schema, so the generated client has no idea the
second one exists. `seCoverage.upsert({ where: { seId_plantId } })` therefore resolves its conflict
against `(se_id, plant_id)` alone — and five e2e specs used exactly that call to give the **shared**
auth-fixture SE (`se.north@fsm.test`) a `DEDICATED` coverage row at **their own** plant. Different
plant, no conflict Prisma can see, so it INSERTs; Postgres then rejects it at the index.

It happens in `beforeAll`, which is what made it expensive out of proportion to its size: a
suite-level `beforeAll` throw reports **zero** tests, not a failure. The affected file contributes no
coverage at all and says so quietly, and every red run has to be hand-triaged into "real failure" vs
"two fixtures collided" — the triage cost that made an earlier session wrongly indict its own change,
and something **#107's unattended CI cannot do at all**.

## Two corrections to the issue's own diagnosis

Both are recorded in `.scratch/fsm-platform-v1/issues/255-…md` in place.

**It is not sixteen files, it is five.** Sixteen hardcode the SE id; only `soft-state-controller`,
`ticket-forms-read`, `troubleshoot-controller`, `verification-controller` and `verification-review`
ever write an `se_coverage` row for it. The other eleven use the id for auth identity, ticket
assignment, or `engineer_master` alone — and `engineer_master` is keyed on the id itself, so those
upserts are genuinely idempotent and were never part of this.

**The trigger is not concurrency.** `vitest.config.ts` sets `fileParallelism: false`; spec files run
serially, two of the five are never in flight together, and each drops its own row in `afterAll`. What
leaks a row is a file whose `afterAll` **never runs** — the #184 Windows worker crash kills it
mid-flight and its `DEDICATED` row survives, so the next of the five to seed is rejected. That is
exactly the observed run: `verification-review` was one of the two files the crash dropped, and three
of the remaining four then threw in `beforeAll`. (INDEX's own 2026-08-19 suite-noise triage row had
already read it that way: *"they depend on each other's `afterAll` — which the #184 Windows worker
crash skips."*)

This distinction decided the fix. A concurrency bug would be closed by serialising — which the suite
already does, and which did not help. The real defect is that five files each **assert an exclusivity
none of them holds**, so any leak at all is fatal.

## What was built

| Piece | File | Substance |
|---|---|---|
| The fixture seam | `test/fixtures/shared-auth-se.ts` | `SHARED_AUTH_SE_ID`, `ensureSharedSeCoversPlant()`, `releaseSharedSePlantCoverage()` — one place that writes coverage for the shared SE, carrying the full explanation of the invisible index |
| The five call sites | the five specs above | ~15 lines of copied fixture each → one helper call; teardown → `releaseSharedSePlantCoverage()` |
| Static guard (AC1) | `test/shared-auth-se-fixture-guard.spec.ts` | no spec may write a `DEDICATED` coverage row for the shared SE, however the id is spelled |
| Static guard (AC3) | same file | every `afterAll` clearing both tables deletes `se_coverage` before `engineer_master` |
| Behavioural pin (AC4) | `test/se-coverage-dedicated-unique.e2e-spec.ts` | the index rejects a second DEDICATED row at a different plant; an `(se_id, plant_id)` upsert does **not** protect against it; MULTI_PLANT at several plants is accepted |
| The trap, documented (AC4) | `prisma/schema.prisma` | a "WRITING AN UPSERT AGAINST THIS MODEL? READ THIS FIRST" block on `model SeCoverage` |

### The shape chosen, and the two the issue proposed

Neither listed option survives contact.

*Give each file its own SE* is ruled out by the login: these specs authenticate as `se.north@fsm.test`
over real HTTP, and the SE the token names is the SE whose coverage the #162 floor is checked against.
A per-file SE would have to be minted **and** logged in as — a rewrite of the auth fixture, not a
fixture fix.

*Seed the coverage once in global setup* is ruled out by ordering: each spec creates **its own plant at
run time**, and an `se_coverage` row is an `(se, plant)` pair. There is no plant for a global row to
point at; global setup would have to invent one the specs then don't use.

So the row stays per-spec, and what goes is the claim of exclusivity: the coverage is written
**`MULTI_PLANT`**. This keeps the issue's principle intact — the partial index is right, the fixtures
were wrong — and sharpens it. The mistake was not "five files each assert a DEDICATED row"; it was
"five files describe as *dedicated* an SE that demonstrably covers five different plants".
`MULTI_PLANT` is simply the truthful classification, and it makes the collision **unconstructible**
rather than unlikely. Nothing is given up: the predicate these specs exercise,
`SeCoverageService.coveredPlantIds` (#162), is a plain plant-set union that never reads
`coverage_type`.

`engineer_master.coverage_type` is deliberately left `DEDICATED`. It carries no partial unique, eleven
other specs already upsert it, and `component-request-controller` exercises
`computeResubmitOwnership()`, which reads it — changing it would be an unrelated behavioural change
smuggled in under a test-infrastructure fix.

### The second bug was worse than "wrong order"

The issue records `afterAll` deleting `engineer_master` before `se_coverage`, violating
`se_coverage_se_id_fkey`. The delete it names is
`engineerMaster.deleteMany({ where: { engineerId: otherSeId } })` — and `otherSeId` is assigned near
the **end** of `beforeAll`, after the upsert that throws. So on exactly the runs where this fires,
`otherSeId` is still `undefined`; Prisma drops undefined filter fields, the call becomes
`deleteMany({ where: {} })`, and the teardown tries to delete **every row in `engineer_master`**. The
FK error in the log is not this spec's own coverage row objecting — it is every *other* SE's, and the
FK is the only reason no data was lost. Fixed by guarding on `otherSeId` as well as re-ordering, in
all three files carrying the pattern.

## Relationship to #215 — found, and deliberately not folded in

[#215](../../.scratch/fsm-platform-v1/issues/215-shared-fixture-se-zone-leak.md) is the same fixture,
a different column: nine specs `engineerMaster.upsert` the shared SE into a throwaway zone of their own
with `update: {}`, so the first file to run decides the shared SE's zone for the rest of the suite —
which is what `voucher-controller` (#187) trips over. Its nine are this issue's five plus
`component-blocked`, `component-request`, `media`, `shadow-use`.

The new helper is the obvious single place to fix that, and five of the nine now route through it. It
was **not** fixed here: #215's own filing records an ordering trap — fixing the zone leak alone makes
`voucher-controller` fail *harder* (2 → 3), "so the voucher fixture comes first or both land together".
Springing that inside a fix whose whole purpose is to make the suite's verdict legible would have been
self-defeating. The helper therefore preserves today's zone semantics exactly: same `update: {}`, same
create-only payload, same first-writer-wins outcome. #215 is neither better nor worse than it was —
just a one-file change now instead of a nine-file one.

## Verification

**Measured as a rate, not a run** — the #184 lesson. Two full backend suites on this tree, run
sequentially (never concurrently: both truncate the same `fsm_test`, and overlapping them is what
produced an earlier session's false "15 failed files" reading).

| | Run 1 | Run 2 |
|---|---|---|
| Started (IST) | 18:03 | 23:33 |
| Files | **388 accounted for** (1 crash-triggered retry) | **388 accounted for** (1 crash-triggered retry) |
| Tests | 1890 passed / 2 failed / 5 skipped | 1889 passed / 3 failed / 5 skipped |
| Duration | 704 s | 558 s |
| **`beforeAll` collisions** | **0** | **0** |

**Both runs: zero suite-level `beforeAll` failures.** That is the number this issue exists to move —
it was **3** on the run that filed it. All five migrated specs reported real test counts in both runs
(`soft-state` 6, `ticket-forms-read` 4, `troubleshoot` 5, `verification-controller` 9,
`verification-review` 4), as did both new specs (guard 3, constraint pin 3).

### The known-pre-existing failure list, restated (AC5)

The old statement — "2, both `voucher-controller`" — was true only on a run where the shared-fixture
collision did not fire. It is now unconditionally true of that collision, and **one further condition
was discovered by run 2 and is not this issue's**:

- **`voucher-controller.e2e-spec.ts` — 2 tests, every run.** #187 / #215; unchanged.
- **`plant-zone-change-impact.e2e-spec.ts` — 1 test, only between 00:00 and 05:30 IST.** Filed as
  **#256**. Its fixture stamps a `work_schedules` row with `setUTCHours(0,0,0,0)` — a **UTC** day —
  while `zone-mapping.service.ts:209` reads `istDate(new Date())`, an **IST** day. For the 5.5 hours a
  night when those name different dates the schedule filter misses and `dispatchedTodayCount` is 0
  instead of 1. Run 1 (18:03 IST) passed it; run 2 crossed into the window. **Reproduced in
  isolation**, so it is neither a collision nor #184 — and it is untouched by this change (the spec
  neither uses the shared SE nor writes `se_coverage` for it).

So: **2 failures at any hour, 3 between 00:00 and 05:30 IST**, and none of them a fixture collision.

### Sensitivity, not just green

Two probes, each reverted and the revert diff-verified:

- Flip the helper's coverage back to `DEDICATED` → the AC1 guard turns red, naming the helper. Revert
  → green.
- Make the duplicate row same-plant instead of cross-plant → the AC4 constraint pin **fails**, because
  it asserts the violated constraint's own column list (`['se_id']`, the partial index) rather than
  merely `P2002`. A same-plant duplicate reports `['se_id','plant_id']` — the declared unique — so the
  test cannot pass for the wrong reason. Revert → green.

The AC3 ordering guard needed no synthetic probe: it was red on exactly the three offending files
before the teardown fix and green after.

### Static checks

`npx prisma validate` clean. `tsc -p tsconfig.test.json --noEmit` reports nothing for any of the eight
touched or added test files (the test project has pre-existing errors elsewhere, by design — `pnpm
typecheck` is `src`-only). `prisma format` was deliberately **not** committed: it reflows unrelated
models (100 insertions / 87 deletions of pure alignment in `DispatchRun` and others), so the schema
change here is the 13-line doc comment and nothing else.

## Not done, on purpose

- **The other eleven files keep their hardcoded literal.** Migrating them to `SHARED_AUTH_SE_ID` is
  cosmetic here and actively misleading in three cases, where the same uuid is reused for a *different*
  actor (`recovery-lifecycle`'s `OTHER_SE`, `root-cause-report`'s `SE_B`, and
  `removal-reason-cancellation`, which uses it as an **OPERATIONS_HEAD**). The AC1 guard resolves the
  raw literal as well as the constant, so all sixteen are protected regardless.
- **The migration file is untouched.** Its comment already names the index; editing an applied
  migration changes its checksum in `_prisma_migrations` and would break `migrate deploy`. The
  cross-reference lives in the schema and the helper instead.
