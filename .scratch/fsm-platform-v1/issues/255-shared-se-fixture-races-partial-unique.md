# 255 — 16 e2e files share one hardcoded SE id and race on a partial unique Prisma cannot see

Status: done (2026-08-19)
Type: AFK · Backend (test infrastructure)

Filed 2026-08-19 from the #247/#248/#249 full-suite verification run. Not a product defect — a
test-infrastructure defect that makes the suite non-deterministic, and that **#107 (CI) will hit on
every run** once the suite runs unattended.

## What happened

The full backend suite reported `Test Files 4 failed`, of which only `voucher-controller` (2 tests) is
the known pre-existing pair. The other three were **suite-level** failures — `beforeAll` threw, so zero
tests ran:

```
FAIL test/soft-state-controller.e2e-spec.ts   > SE soft-state controller (e2e)
FAIL test/ticket-forms-read.e2e-spec.ts       > Ticket forms read (Issue 70, e2e)
FAIL test/troubleshoot-controller.e2e-spec.ts > SE troubleshoot controller (e2e)

PrismaClientKnownRequestError: Invalid `prisma.seCoverage.upsert()` invocation
Unique constraint failed on the fields: (`se_id`)
```

All three pass **3/3 in isolation** when run together as their own invocation. The failure needs full
suite concurrency.

## Root cause — precise

**Sixteen** e2e files hardcode the same SE:

```ts
const SE_ID = '22222222-2222-2222-2222-222222222222'; // se.north@fsm.test (in-memory auth seed)
```

(`component-blocked-controller`, `component-request-controller`, `install-lifecycle-controller`,
`media-controller`, `non-operational-confirm`, `notifications-controller`, `recovery-lifecycle`,
`removal-reason-cancellation`, `root-cause-report`, `schedules-route-conflicts`,
`shadow-use-controller`, `soft-state-controller`, `ticket-forms-read`, `troubleshoot-controller`,
`verification-controller`, `verification-review`.)

> **Correction (2026-08-19, during the fix).** Sixteen files hardcode the id, but only **five** ever
> write an `se_coverage` row for it: `soft-state-controller`, `ticket-forms-read`,
> `troubleshoot-controller`, `verification-controller`, `verification-review`. The other eleven use the
> id for auth/actor identity, ticket assignment or `engineer_master` alone — `engineer_master` is keyed
> on the id itself, so those upserts are genuinely idempotent and were never part of this. The five are
> the whole defect, and they are exactly the three files the failing run named plus the two that share
> their shape.

Each of those five creates its **own** plant and then upserts a **DEDICATED** `se_coverage` row for
the shared SE. The upsert is keyed on `seId_plantId`, so Prisma's conflict target is
`(se_id, plant_id)` — different plants, no conflict, upsert proceeds to INSERT.

But `20260618121101_add_engineer_se_coverage/migration.sql:60` also declares:

```sql
CREATE UNIQUE INDEX "se_coverage_dedicated_se_key" ON "se_coverage"("se_id") WHERE "coverage_type" = 'DEDICATED';
```

A **partial** unique — raw SQL by necessity, not expressible in the Prisma schema, so the client has no
idea it exists and `upsert` cannot target it. Two files that both seed a DEDICATED coverage for the
shared SE at different plants therefore both pass the conflict check and **both INSERT**, and the
partial index rejects the loser.

> **Correction (2026-08-19, during the fix): the trigger is not concurrency.** `vitest.config.ts` sets
> `fileParallelism: false`, so spec files run **serially** — two of the five are never in flight at
> once, and each drops its own coverage row in `afterAll`. What actually leaks a row is a file whose
> `afterAll` never runs: the #184 Windows worker crash kills the file mid-flight, its DEDICATED row
> survives, and the *next* of the five to seed at its own plant is rejected. That matches the observed
> run exactly — `verification-review` was one of the two files a crash dropped, and three of the
> remaining four then threw in `beforeAll`. (The 2026-08-19 suite-noise triage row in INDEX had already
> reached the same reading: "they depend on each other's `afterAll` — which the #184 Windows worker
> crash skips.") A second, independently sufficient trigger is a concurrent second suite invocation
> against the shared `fsm_test`, which the environment notes already warn against.
>
> This matters for the fix rather than only for the record: a *concurrency* bug would be closed by
> serialising, which the suite already does and which did not help. The defect is that five files each
> assert an exclusivity none of them holds, so any leak at all is fatal.

This is structural, not incidental: all five use `DEDICATED` and their own plant.

## A second, independent bug in the same files

The `afterAll` on at least `soft-state-controller` deletes in FK-violating order:

```
Invalid `prisma.engineerMaster.deleteMany()` — Foreign key constraint violated: se_coverage_se_id_fkey
```

`se_coverage` must be deleted before `engineer_master`. That one is deterministic and worth fixing in
the same pass. (It bit this session's own new spec too, and was fixed there.)

> **Correction (2026-08-19, during the fix): this is worse than mis-ordering.** The delete it names is
> `engineerMaster.deleteMany({ where: { engineerId: otherSeId } })`, and `otherSeId` is assigned near
> the **end** of `beforeAll` — after the `se_coverage` upsert that throws. So on exactly the runs where
> this fires, `otherSeId` is still `undefined`; Prisma drops undefined filter fields, the call becomes
> `deleteMany({ where: {} })`, and the teardown attempts to delete **every row in `engineer_master`**.
> The FK error in the log is not this spec's own coverage row objecting — it is every *other* SE's.
> The one saving grace is that the FK rejects it, so no data is actually lost; had the sweep succeeded
> it would have taken the whole suite down behind it. Fixed by guarding on `otherSeId` as well as by
> re-ordering, in all three files that carry the pattern (`soft-state-controller`,
> `troubleshoot-controller`, `verification-controller`).

## Why it matters beyond tidiness

- **The suite's verdict is not trustworthy** — a red run has to be hand-triaged into "real" vs "two
  files collided", every time. That triage cost is what made a previous session wrongly indict its own
  change (the #184 note in `docs/archive/handoff-scheduler-block-247-249-2026-08-19.md`).
- **#107 depends on it.** Unattended CI cannot hand-triage, and this fires at exactly the concurrency
  CI uses.
- It hides real failures: a suite-level `beforeAll` throw reports **zero** tests, so the sixteen files'
  actual coverage silently contributes nothing on a run where they collide.

## What to build

1. **Give each file its own SE.** The shared constant exists because it matches the in-memory auth
   seed (`se.north@fsm.test`) that these specs log in as, so the fix is not a blind `randomUUID()` —
   either seed a per-file SE and mint its token the way the newer specs do, or keep the shared login
   and stop writing per-file `se_coverage`/`engineer_master` rows for it (seed those **once**, in
   global setup, where the uniqueness is real rather than raced).
2. **Prefer the second shape** — one DEDICATED coverage per SE is a genuine business invariant
   (`se_coverage_dedicated_se_key`), so sixteen files each asserting their own is the actual mistake;
   the partial index is right and the fixtures are wrong.
3. **Fix the `afterAll` FK order** in the affected files (`se_coverage` → `engineer_master`).
4. **Leave a comment at the partial index and at the shared constant** naming each other. A unique
   Prisma cannot see is a permanent trap for anyone writing an upsert against this table.

> **What was built instead of (1)/(2), and why (2026-08-19).** Neither listed shape survives contact.
> *Give each file its own SE* is ruled out by the login: the five specs authenticate as
> `se.north@fsm.test` over real HTTP, and the SE the token names is the SE whose coverage the
> `#162` floor is checked against — a per-file SE would have to be minted **and** logged in as, which is
> a rewrite of the auth fixture, not a fixture fix. *Seed the coverage once in global setup* is ruled
> out by ordering: each spec creates **its own plant at run time**, so there is no plant to point a
> global row at, and `se_coverage` rows are `(se, plant)` pairs — the global seed would have to invent
> a plant the specs then don't use.
>
> The row that has to exist is genuinely per-spec. What does **not** have to exist is the claim of
> exclusivity. So the coverage stays per-spec and becomes **`MULTI_PLANT`**, written through one shared
> helper (`test/fixtures/shared-auth-se.ts`). This keeps the issue's own principle — the partial index
> is right, the fixtures were wrong — and lands it more precisely: the mistake was not "five files each
> assert a DEDICATED row", it was "five files describe as *dedicated* an SE that demonstrably covers
> five different plants". `MULTI_PLANT` is the truthful classification, and it makes the collision
> unconstructible rather than unlikely. Nothing is lost in the process: the predicate these specs
> exercise, `SeCoverageService.coveredPlantIds` (#162), is a plain plant-set union and never reads
> `coverage_type`.
>
> `engineer_master.coverage_type` is deliberately **left** `DEDICATED`. It carries no partial unique,
> eleven other specs already upsert it, and `component-request-controller` exercises
> `computeResubmitOwnership()`, which reads it — changing it would be an unrelated behavioural change
> smuggled in under a test-infra fix.

## Acceptance criteria

- [x] AC1 — No two e2e files can write a DEDICATED `se_coverage` row for the same SE; the constraint is
      satisfied by construction, not by scheduling luck.
- [x] AC2 — The three named files pass in a full concurrent suite run, measured as a **rate** over
      repeat runs, not a single green run.
- [x] AC3 — `afterAll` teardown respects `se_coverage_se_id_fkey` ordering everywhere it is violated.
- [x] AC4 — The `se_coverage_dedicated_se_key` partial unique is documented where a developer writing
      an `upsert` against `se_coverage` will see it.
- [x] AC5 — The known-pre-existing failure list is restated accurately afterwards (today it says "2,
      both voucher-controller", which is true only on a run where these three do not collide).

## Relationship to #215 (found while fixing this — deliberately NOT folded in)

**[#215](./215-shared-fixture-se-zone-leak.md) is the same fixture, a different column.** It records
that nine specs `engineerMaster.upsert` the shared SE into **a throwaway zone of their own** with
`update: {}`, so the *first file to run wins* and decides which zone the shared SE sits in for the rest
of the suite — which is what `voucher-controller` ([#187](./187-voucher-controller-e2e-missing-engineer-seed.md))
trips over. Its nine are this issue's five plus `component-blocked`, `component-request`, `media` and
`shadow-use`.

#255's helper (`test/fixtures/shared-auth-se.ts`) is now the obvious single place to fix that, and five
of the nine already route through it. It was **not** fixed here, for two reasons:

- **#215 carries an ordering trap that #255 must not spring.** Its own filing says fixing the zone leak
  alone makes `voucher-controller` fail *harder* (2 failures → 3), "so the voucher fixture comes first
  or both land together". Closing it inside a test-infrastructure fix whose whole point is to make the
  suite's verdict legible would have done the opposite.
- The helper therefore preserves today's zone semantics **exactly** — same `update: {}`, same
  create-only payload, same first-writer-wins outcome. Nothing about #215 is better or worse than it
  was; it is simply now a one-file change instead of a nine-file one, once #187 lands with it.

## Blocked by

none. Prerequisite in spirit for **#107** (CI), which cannot triage this by hand.
