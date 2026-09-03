# 336 — Dev seed fixtures for SE, verification, inventory, Platinum
Status: done (2026-09-03)
Type: AFK
Wave: 0 · Severity: P1 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

The only SE login (`se.north@fsm.test`) has a `users` row and no `engineer_master` / `se_coverage`
row (`apps/backend/src/auth/auth-fixture-seed.ts` ~74-78; `auth/dev-seed.ts:74` seeds users only).
`verification_runs` has zero rows; van stock, component requests and shadow use are empty; no
Platinum ticket exists. 17 survey findings were `needs-verify` for this reason alone — the dev DB
cannot be walked from the SE side or through the verification flow at all.

This is the one dev-process precondition (P0-c in the plan §2) that is a slice, because it is code.

## Current code

- `apps/backend/src/auth/auth-fixture-seed.ts` ~74-78 — `se.north@fsm.test` gets a `users` row only
- `apps/backend/src/auth/dev-seed.ts:74` — `runDevSeed` seeds users only; no `engineer_master`,
  no `se_coverage`
- `verification_runs` — zero rows in the dev DB
- `se_van_stock`, component requests, shadow use — empty
- No PLATINUM-company ticket in the dev DB
- `prisma/seed-mock-engineers.ts:131-149` — the existing engineer-seeding pattern to follow

## What to build

- `apps/backend/src/auth/dev-seed.ts` — extend `runDevSeed`, following the pattern at
  `prisma/seed-mock-engineers.ts:131-149`, so that `pnpm seed:dev` leaves a dev DB on which every
  SE-side and verification walk is possible
- `apps/backend/test/fixtures/shared-auth-se.ts` — the e2e side of the same fixtures
- `package.json` `seed:dev` — the script that runs it
- The seed must be idempotent: every row is an upsert, so a second run changes nothing

## Acceptance criteria

- [x] AC1 — `engineer_master` row `2222…2222`, zone 1, DEDICATED, capacity 5, active; plus one
      `se_coverage` row on a zone-1 plant
- [x] AC2 — three `verification_runs` on real tickets: zone-1 `FAILED_NO_PINGS`, zone-2
      `fraudFlag=true`, zone-1 CLOSED
- [x] AC3 — `se_van_stock` for `se.north` = the common kit minus one item
- [x] AC4 — one PLATINUM-company ticket, OPEN/UNASSIGNED, older than 4 h, in zone 1
- [x] AC5 — one PENDING leave request for `se.north`
- [x] AC6 — a second run changes nothing (upserts)

## Corrections applied while building (2026-09-03)

The ACs above are ticked as **met in substance**; three of them were written against facts that turned
out to be wrong. Recorded here so the next reader is not misled. Full reasoning:
`docs/progress/336-dev-seed-fixtures.md`.

1. **"Extend `runDevSeed`" was not done, on purpose.** Two files record a deliberate decision that a
   fixture engineer row must not appear in a development database's engineer directory
   (`test/fixtures/shared-auth-se.ts`; `test/global-setup.ts:46-47`). Extending the login seeder would
   reverse that silently. Built instead: a **separate opt-in**, `SEED_DEV_WALK_FIXTURES`, in its own
   module + entrypoint (`npm run seed:dev-fixtures`). `ALLOW_DEV_SEED` is deliberately *not* enough.
2. **The `test/fixtures/shared-auth-se.ts` half was already built** and has been since #215/#187 —
   `seedSharedAuthSeEngineer` runs in `test/global-setup.ts` before any spec. **#187 is closed**; this
   issue does not absorb it, and nothing there was modified.
3. **AC2's `FAILED_NO_PINGS` is not an outcome in this schema.** The shape is
   `outcome: FAILED_VERIFICATION` with `pingsReceivedCount: 0`. The fraud run additionally carries
   *received* pings (a fraud flag means pings arrived from the wrong place; zero pings would be
   incoherent) and is placed out of zone where the database offers a second one, since V-02's leak
   cannot be shown from a same-zone row.
4. **AC4's Platinum case is a scoped, expiring `company_tier_overrides` row (#157)** — operator's
   choice of three options — plus a matching `tickets.company_tier` snapshot, because
   `sweepAutoEscalations` filters on that column (`cross-zone-escalation.service.ts:77`), not on the
   effective tier. `companies.company_tier` is untouched.

## Verification

`test/dev-fixture-seed.spec.ts` (2 unit tests, no database) pins the guard;
`test/dev-fixture-seed.e2e-spec.ts` (7 e2e, each inside a rolled-back transaction) pins the rows and
the double-run invariance. `GET /me/tickets` returning rows for `se.north` is a property of the dev
database once the command has run; it is not asserted in `fsm_test`, which holds no tickets.

## UI surfaces

n/a (backend / dev-process only)

## Reference

n/a

## Blocked by

— (none)

## Absorbs / supersedes

- survey ids: ENG-G7, V-08, INV surface
- existing issues: #187 (test side — closes into this slice when it lands)

## Downstream

Slices 337, 352, 357 and 359 depend on this one (plan §3); it is the first shared blocker after
the P0-a commit (plan §5).
