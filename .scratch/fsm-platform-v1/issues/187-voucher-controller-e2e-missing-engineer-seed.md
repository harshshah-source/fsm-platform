# 187 — `voucher-controller.e2e-spec.ts` fails 3/5: fixture never seeds the SE's `EngineerMaster` row

Status: ready-for-agent
Type: AFK · Backend · Test infrastructure

Filed 2026-08-03, found incidentally while verifying the #161/#162 slice (not caused by it — reproduces
identically on the base commit, `git stash` isolation-tested; see below). `#38` (Expense Vouchers) is
marked `Status: done` with every AC checked, but its own e2e coverage has been silently red.

## What's wrong

`test/voucher-controller.e2e-spec.ts`'s `beforeAll` (`:33-39`) boots the Nest app but creates no
`user`/`engineerMaster` row for the SE it authenticates as (`se.north@fsm.test`, the fixed in-memory
auth seed, `userId: '22222222-2222-2222-2222-222222222222'`). It relies on that row existing from
elsewhere — but `seedOrgReferenceData` (`src/org/org-seed.ts`, run by `test/global-setup.ts` on every
`vitest run` invocation, truncate-then-reseed per #180) never creates one, and no other spec runs
before this file in a way this file can depend on (file order is independent per #184 R2, and each
`vitest run` invocation truncates first).

Every other e2e spec that authenticates as `se.north@fsm.test` upserts its own
`user`/`engineerMaster` row in its own `beforeAll` — **104 of the suite's spec files do this**
(`grep -c "engineerMaster.upsert\|engineerMaster.create" test/*.e2e-spec.ts`). This file is the
outlier that skips it, most likely because it was written against an earlier DB state where that row
persisted incidentally (before #180's per-run truncate+reseed landed) and was never re-verified after.

**Consequence:** `VouchersService.create()` (`src/vouchers/vouchers.service.ts:162-163`) does
`this.prisma.engineerMaster.findUnique({ where: { engineerId: input.seId } })`; when it's `null`,
returns `{ result: 'ERROR', code: 'SE_NOT_FOUND' }`, which `VouchersController.create()`
(`:96`) maps to `400 Bad Request`. Every voucher-creation call in the file hits this path.

## Reproduction

```bash
cd apps/backend
npx vitest run test/voucher-controller.e2e-spec.ts
```

```
Test Files  1 failed (1)
     Tests  3 failed | 2 passed (5)
```

The 2 that pass don't call create as the happy path: "rejects an unauthenticated request with 401"
and "create with no photo on any item → 400 PHOTO_REQUIRED" (that one 400s for a *different*,
correct reason — no `SE_NOT_FOUND` check is reached because the photo check runs first). The 3 that
fail all hit `.expect(201)` on the first real voucher-creation call in the test:
- `SE creates a voucher (201, ZONAL_MANAGER_REVIEW); ZM cannot create (403)` — `expected 201, got 400`
- `ZM sees the queue; SE cannot read it (403)` — `expected 201, got 400`
- `runs the full ZM approve → OH export → OH mark-paid lifecycle with RBAC gates` — `expected 201, got 400`

**Confirmed pre-existing, not caused by the #161/#162 slice landing alongside this finding**:
reproduced identically (same 3/5 failure, same error) via `git stash` (stashing every file that slice
touched) → run → `git stash pop`. Base commit `0f62e73` fails the same way.

## What to build

Add the same seed the other 104 files already do, in `beforeAll`:

```ts
await prisma.user.upsert({
  where: { userId: SE_ID },
  create: { userId: SE_ID, name: 'SE North', role: 'SERVICE_ENGINEER', phone: '...', email: '...', zoneId },
  update: {},
});
await prisma.engineerMaster.upsert({
  where: { engineerId: SE_ID },
  create: { engineerId: SE_ID, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 },
  update: {},
});
```

Needs a `zone` created first (the file currently creates none — check whether `se.north`'s seeded
`zoneId: 1` needs an explicit `zone.upsert({ zoneId: 1n, ... })` the way several other files do, since
the org-reference seed may not guarantee zone `1` exists). Clean up the added rows in `afterAll`
following the file's existing pattern for `created` vouchers.

Out of scope: whether `#38`'s other, currently-`[x]`-checked ACs still hold beyond what this one spec
file exercises — this issue is scoped to making the existing spec's own fixture correct, not a fresh
audit of the voucher feature.

## Acceptance criteria

- [ ] `voucher-controller.e2e-spec.ts` passes 5/5
- [ ] The fixture seeds its own `user`/`engineerMaster` row rather than depending on incidental state
      from elsewhere, matching the pattern already used by the other 104 e2e specs that authenticate
      as `se.north@fsm.test`

## UI surfaces

n/a (test-only fix).

## Reference

n/a.

## Blocked by

- None.

## Comments

n/a.
