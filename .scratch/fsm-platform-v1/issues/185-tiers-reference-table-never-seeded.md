# 185 — `tiers` reference table is never seeded — Issue 157 Slice 1 has been dead since it landed

Status: ready-for-agent
Type: AFK · Backend (test repair / seed gap)

Filed 2026-07-31. Discovered verifying [#181](./181-business-sweep-scheduler-arity-and-config-drift.md)
+ [#182](./182-hermetic-test-env-allowlist.md) against a fully deterministic suite ([#180](./180-test-db-determinism-truncate-reseed.md)
landed first). Not part of the #180–184 suite-repair block and not #183's territory — see
"Not #183" below. **Independent of the repair programme; can be picked up any time.**

---

## What's broken

`org-tiers.e2e-spec.ts` and `tiers-spec-pin.spec.ts` (2 files, 4 tests) fail on every run, on a
freshly truncated+reseeded database, because `prisma.tier.findMany()` returns `[]` where the specs
expect the three PRD-canon rows (`PLATINUM` rank 1, `GOLD` rank 2, `SILVER` rank 3):

- `test/org-tiers.e2e-spec.ts:39` — `GET /api/org/tiers` returns `[]`.
- `test/tiers-spec-pin.spec.ts:26,35,40` — three separate assertions against
  `prisma.tier.findMany()`, all empty.

**Root cause, confirmed from source, not inferred:** migration
`prisma/migrations/20260723120000_tiers_reference_table` creates the `tiers` table (Issue 157 Slice
1), but `grep -n "prisma.tier\." src/org/org-seed.ts` returns **zero matches** —
`seedOrgReferenceData` never seeds it. Nothing under `src/` references `prisma.tier.create` or
`prisma.tier.upsert` anywhere. The table has existed, empty, since the migration landed; these two
spec files have been red since Issue 157 Slice 1, masked previously by the DB non-determinism #180
fixed (an orphan-accumulation run could coincidentally not reach these files, or their failure was
lost in the noise of 10+ other failures per run).

## Not #183

[#183](./183-tier-override-frozen-clock-check-violation.md) also has "tier" in three spec names
(`dispatch-run-tier-override-snapshot`, `recommender-tier-override`, `ticket-creation-tier-override`)
but is a **different table and a different failure mode**: those three specs' `beforeAll` *throws*
(a `company_tier_overrides` CHECK-constraint violation on a frozen `expiresAt`/`created_at` pair), so
vitest reports them as **skipped**, not failed — 6 tests, not these 4. Confirmed by running the full
suite: `org-tiers.e2e-spec.ts` and `tiers-spec-pin.spec.ts` show real `AssertionError`s against an
empty result set; the #183 trio shows zero executed assertions, hook failure only. Do not fold this
into #183 — different table (`tiers` vs `company_tier_overrides`), different fix (seed data vs a
`createdAt` timestamp), different files.

## What to build

Add a `tiers` seed step to `seedOrgReferenceData` (`src/org/org-seed.ts`), upserted the same way every
other reference table there is (idempotent — re-running must not duplicate or reorder), producing
exactly the three PRD-canon rows:

| name | rank |
|---|---|
| PLATINUM | 1 |
| GOLD | 2 |
| SILVER | 3 |

Cross-check the exact shape (column names, any additional fields) against `prisma/schema.prisma`'s
`Tier` model and the two failing specs' expectations before writing the upsert — both specs assert
`toEqual`/`toEqual` on the exact row shape, so extra or missing fields will fail loudly and correctly.

## Acceptance criteria

- [ ] **AC-1** — `seedOrgReferenceData` seeds `tiers` with the three PRD-canon rows, idempotently
      (a second call does not duplicate or error).
- [ ] **AC-2** — `org-tiers.e2e-spec.ts` and `tiers-spec-pin.spec.ts` (4 tests) pass against a
      truncated+reseeded database.
- [ ] **AC-3** — no regression in any other spec that reads `tiers` or depends on the recompute of
      `seedOrgReferenceData`'s row counts (#180 R5's table gains one row: `tiers: 3`).

## Out of scope — do not do these here

- **`company_tier_overrides`** and its CHECK constraint — that is #183.
- **Any change to the `Tier` model or its migration.** The schema is correct; only the seed is
  missing.

## Targeted test command

From `apps/backend/`:

```bash
npx vitest run test/org-tiers.e2e-spec.ts test/tiers-spec-pin.spec.ts
```

## UI surfaces

n/a — reference-data seed only. (If any admin surface reads `/api/org/tiers` and currently renders
empty, that is a consequence of this same gap, not a separate finding — check when fixing.)

## Reference

n/a.

## Blocked by

- **[#180](./180-test-db-determinism-truncate-reseed.md)** — soft; verification is only meaningful
  against a deterministic suite, which now exists.
- Independent of #181, #182, #183 in mechanism — can land any time, in any order relative to them.
