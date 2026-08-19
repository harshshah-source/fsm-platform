# 255 — 16 e2e files share one hardcoded SE id and race on a partial unique Prisma cannot see

Status: ready-for-agent
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

Each creates its **own** plant and then upserts a **DEDICATED** `se_coverage` row for that shared SE.
The upsert is keyed on `seId_plantId`, so Prisma's conflict target is `(se_id, plant_id)` — different
plants, no conflict, upsert proceeds to INSERT.

But `20260618121101_add_engineer_se_coverage/migration.sql:60` also declares:

```sql
CREATE UNIQUE INDEX "se_coverage_dedicated_se_key" ON "se_coverage"("se_id") WHERE "coverage_type" = 'DEDICATED';
```

A **partial** unique — raw SQL by necessity, not expressible in the Prisma schema, so the client has no
idea it exists and `upsert` cannot target it. Two files that both seed a DEDICATED coverage for the
shared SE at different plants therefore both pass the conflict check and **both INSERT**, and the
partial index rejects the loser. Whether it happens is purely a function of which files a worker pool
happens to run concurrently — which is why the suite has been intermittently, inexplicably red here.

This is structural, not incidental: every one of the sixteen uses `DEDICATED` and its own plant.

## A second, independent bug in the same files

The `afterAll` on at least `soft-state-controller` deletes in FK-violating order:

```
Invalid `prisma.engineerMaster.deleteMany()` — Foreign key constraint violated: se_coverage_se_id_fkey
```

`se_coverage` must be deleted before `engineer_master`. That one is deterministic and worth fixing in
the same pass. (It bit this session's own new spec too, and was fixed there.)

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

## Acceptance criteria

- [ ] AC1 — No two e2e files can write a DEDICATED `se_coverage` row for the same SE; the constraint is
      satisfied by construction, not by scheduling luck.
- [ ] AC2 — The three named files pass in a full concurrent suite run, measured as a **rate** over
      repeat runs, not a single green run.
- [ ] AC3 — `afterAll` teardown respects `se_coverage_se_id_fkey` ordering everywhere it is violated.
- [ ] AC4 — The `se_coverage_dedicated_se_key` partial unique is documented where a developer writing
      an `upsert` against `se_coverage` will see it.
- [ ] AC5 — The known-pre-existing failure list is restated accurately afterwards (today it says "2,
      both voucher-controller", which is true only on a run where these three do not collide).

## Blocked by

none. Prerequisite in spirit for **#107** (CI), which cannot triage this by hand.
