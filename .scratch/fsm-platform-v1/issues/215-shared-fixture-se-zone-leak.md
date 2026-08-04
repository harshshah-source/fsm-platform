# 215 — Nine specs re-zone the shared fixture SE and never clean up; `voucher-controller` is the one that trips over it

Status: ready-for-agent
Type: AFK · Backend (test infrastructure)
Filed 2026-08-04 · Completes [#180](./180-test-db-determinism-truncate-reseed.md): truncate-and-reseed
made the DB deterministic **at the start of a run**, and this is the hole it left — the specs themselves
mutate shared seeded state *during* a run, so determinism decays as the run proceeds. Sibling of
[#184](./184-vitest-worker-exited-unexpectedly.md): same class of problem, a suite that lies about itself.

## Root cause

`voucher-controller.e2e-spec.ts` fails **2 tests in a full run and 3 in isolation**, and has done for at
least as long as the last three full sweeps. It is not caused by any recent change — proven by reverting
the working tree's backend files to `5afc920` and re-running for a byte-identical failure.

The spec uses the seeded fixture SE `se.north@fsm.test` (`22222222-2222-2222-2222-222222222222`) but
**creates no fixture of its own for it**. `seedAuthFixtureUsers` (`test/global-setup.ts`) creates the
`users` row and **no `engineer_master` row**. So whether the spec passes depends entirely on what some
*other* spec left behind:

| State of `engineer_master` for the fixture SE | What voucher-controller does |
|---|---|
| absent (spec run alone) | `POST /api/vouchers` → **400 `SE_NOT_FOUND`** — 3 tests fail |
| present, zone ≠ North | create succeeds, but the ZM-North queue is zone-scoped → **`:97` queue miss + `:135` approve 403** — 2 tests fail |
| present, zone = North | would pass |

The row is created by whichever of **nine** specs runs first, each into a **throwaway zone of its own**:

```
component-blocked-controller · component-request-controller · media-controller · shadow-use-controller
soft-state-controller · ticket-forms-read · troubleshoot-controller · verification-controller
verification-review
```

Every one of them does `engineerMaster.upsert({ where: { engineerId: SE_ID }, create: { …, zoneId },
update: {} })` against a zone it created for itself, and **not one of them deletes that row in
`afterAll`**. Because the upsert is create-only, the **first** spec to run wins and its throwaway zone
becomes the fixture SE's zone for the rest of the run — decided by vitest worker scheduling, not by
anything in the test code.

Worked example, verified today: run `verification-controller.e2e-spec.ts` immediately before
`voucher-controller.e2e-spec.ts` and the failure changes shape from 3 tests to exactly the 2 seen in the
full sweep. `verification-controller.e2e-spec.ts:68,73` creates zone `Z-vc-<NS>` and upserts the fixture
SE into it; its `afterAll` (`:88-103`) deletes the *other* SE's row, the coverage, the plant and the
company — but neither the fixture SE's `engineer_master` row nor the zone.

## Evidence — verified 2026-08-04

- `test/global-setup.ts:41-42` — `seedOrgReferenceData` + `seedAuthFixtureUsers`; the DB is truncated
  and re-seeded before **every** run (#180), so this is not stale state from an old run — it is state
  created *within* the run by the specs themselves, which is precisely what #180 does not cover.
- `src/auth/auth-fixture-seed.ts:64` — seeds `se.north@fsm.test`; no `engineer_master` anywhere in that
  file.
- `test/verification-controller.e2e-spec.ts:68,72-73` — creates `Z-vc-<NS>`, upserts the fixture SE's
  `engineer_master` into it; `:88-103` — `afterAll` never removes either.
- Live probe against `fsm_test` after a fresh truncate+seed: `engineer_master` for the fixture SE is
  **null**, which is why the spec fails hardest in isolation.
- `test/voucher-controller.e2e-spec.ts:33-48` — a `beforeAll` that builds no SE fixture at all.

## Scope

**In:** make `voucher-controller` self-sufficient, and stop the nine specs mutating shared fixture state
they do not own.

**Order matters, and is the trap:** fixing the leak *first*, alone, makes `voucher-controller` fail
**harder** — always 3 failures instead of intermittently 2, because the row it was accidentally relying
on stops existing. Give the voucher spec its own fixture first, or do both in one change.

**Out:** the `VouchersService` zone-scoping itself — it is behaving correctly; the queue is meant to be
zone-scoped and the SE genuinely was in another zone. Nothing in `src/` is at fault here.

## Acceptance criteria

- [ ] `voucher-controller.e2e-spec.ts` creates the SE fixture it needs (own user + `engineer_master` in
      the ZM's zone, or its own SE entirely) and deletes it in `afterAll` — and **passes when run alone**
- [ ] No spec creates, upserts or mutates an `engineer_master` row for a **seeded fixture user id**
      without deleting it again; the nine listed above are each either given their own SE or made to
      clean up
- [ ] A spec that must use a seeded fixture user does not silently re-zone it for everything that runs
      afterwards
- [ ] The full suite passes with **zero** failing files, so "green" means green — today's baseline of
      "341 passed, 1 known-bad" trains everyone to read past a real regression
- [ ] Running `voucher-controller.e2e-spec.ts` alone and as part of the full sweep gives the **same**
      result, twice in a row

## Verification

```bash
cd apps/backend
node scripts/run-tests.mjs test/voucher-controller.e2e-spec.ts                    # alone — must pass
node scripts/run-tests.mjs test/verification-controller.e2e-spec.ts test/voucher-controller.e2e-spec.ts
node scripts/run-tests.mjs                                                        # zero failing files
```

## Risk if deferred

A permanently-red file in a suite everyone else has to run is worse than its own two tests. It is
already being read past — three full sweeps in this session reported "1 failed" and the correct response
each time was "that one does not count", which is exactly the habit that lets a real regression through.
The underlying leak is also live for the other eight specs: any future spec that uses the fixture SE and
cares which zone it is in will fail for reasons that have nothing to do with what it is testing, and
whose cause is a worker-scheduling order nobody can see from the failing test.

## Size estimate

S/M. The voucher fixture is a ten-line `beforeAll`/`afterAll`. Auditing the other eight is mechanical
but wants care — some may be legitimately relying on the fixture SE being in *their* zone, in which case
the fix is their own SE rather than a cleanup.
