# #215 — the shared SE's zone stops being decided by worker scheduling

**Done 2026-08-20**, together with #187 (one change, deliberately — #215's own filing records the
ordering trap: fixing the leak alone makes `voucher-controller` fail *harder*). Test infrastructure
only; no `src/` behaviour changed.

## The defect, restated

`seedAuthFixtureUsers` seeds the shared SE's `users` row and never an `engineer_master` row. Nine
specs upserted that row themselves — each create-only, each into a throwaway zone of its own — so the
**first spec to run** decided the SE's zone for the rest of the run. `voucher-controller` paid: its ZM
queue scopes on `engineer.zoneId` (`vouchers.service.ts:217`), so it failed 3/5 alone (no row →
`SE_NOT_FOUND`) and 2/5 in a sweep (row in a foreign zone → queue miss + approve 403), with the shape
of the failure chosen by vitest worker scheduling.

## The shape chosen — a third one, not either the issue proposed

Not nine cleanups (each individually rots), not nine per-file SEs (the login is keyed to this
identity). The row became **canonical seeded state**: `test/global-setup.ts` →
`seedSharedAuthSeEngineer()` (`test/fixtures/shared-auth-se.ts`), zone **North** — the zone the seeded
`users` row already names, and zm.north's. Every per-spec create-only upsert is thereby structurally
unable to win; "first writer decides the zone" has no writer left to decide anything. Same shape as
#255's MULTI_PLANT fix: close the leak by construction, then guard the construction.

Deliberately **not** inside `seedAuthFixtureUsers` itself — the gated dev-seed runner also calls that,
and a fixture engineer row does not belong in a development database's engineer directory.

## What was built

| Piece | Substance |
|---|---|
| `seedSharedAuthSeEngineer()` | the one canonical writer (North, DEDICATED, capacity 10); called by global setup and by any spec wanting explicit self-sufficiency |
| `ensureSharedAuthSe()` | users-row backstop + the canonical seed — the identity half for specs that never write coverage |
| Nine specs refactored | four inline upsert pairs (`component-blocked`, `component-request`, `media`, `shadow-use`) → helper calls; five already routed via #255's `ensureSharedSeCoversPlant`, which now delegates; `soft-state`'s dead `updateMany` "detach" removed |
| Canonical-seed pin | `shared-auth-se-canonical-seed.e2e-spec.ts` — exists / North / DEDICATED. **Red 3/3 before** the global-setup line; probe-verified (seed disabled → red again; restore diff-verified) |
| Static guard | `shared-auth-se-fixture-guard.spec.ts` gained an `engineerMaster`-write scan: any create/upsert/update/delete naming the shared id outside the fixtures module fails the suite. **Red on exactly five call sites** before the refactor, green after |

## The audit the size-estimate feared

"Some may be legitimately relying on the fixture SE being in *their* zone" — checked, all nine: they
use the SE for auth identity, SE-scoped reads (van stock, media, shadow-use, soft-state), or
plant-scoped coverage (#162's floor reads `se_coverage`, never the engineer's zone).
`component-request` reads `coverageType` (DEDICATED — preserved). None reads the zone. Also audited
the blast radius of a row that now exists from t0 in North: `engineers-list`, `zone-engineers`,
availability and dashboard specs all assert membership (`toContain`) or per-fixture rows, never exact
totals or "North is empty".

## #187, closed by the same change

The voucher spec's `beforeAll` now calls `seedSharedAuthSeEngineer(prisma)` itself — self-sufficient
per its AC2, without a second competing definition of the row. Its issue file carries a correction:
"copy the seed the other 104 files do" was the wrong prescription, because those 104 seeds *are* the
#215 leak.

## Verification

- `voucher-controller` **5/5 alone, twice** (was 3/5) — #215 AC5.
- `verification-controller` then `voucher-controller` — the worked example that used to flip the
  failure 3→2 — **14/14**.
- All nine refactored/affected specs + neighbours: 60/60 in one targeted run.
- Full suite: recorded on the INDEX session-log row (the zero-failing-files gate, AC4).

## Not done, on purpose

The **zone rows** the nine specs created for themselves are still created (they hang plants and
tickets off them) — that is per-spec state they own, not shared state. Only the *shared identity's*
rows moved to seeded state.
