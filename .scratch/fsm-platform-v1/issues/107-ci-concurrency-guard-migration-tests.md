# 107 — CI pipeline + concurrency / route-guard / migration-from-zero test coverage
Status: ready-for-agent
Type: AFK

> Source: `docs/audits/2026-07-03-backend-production-readiness-audit.md` — MEDIUM (testing gaps) +
> the "concurrency-test + CI absence" compounding-debt item. Verified 2026-07-07: no `.github/`
> workflow; zero `Promise.all` concurrency tests across the 200+ test files; the migration test only
> asserts `SELECT 1`.

## What to build

Stand up CI and close the three test-shape gaps the audit called out as the reason its concurrency
and route-guard findings can't currently regress-fail.

1. **CI pipeline.** A workflow (e.g. GitHub Actions) that provisions a **from-zero migrated**
   disposable Postgres (+ PostGIS), runs `prisma migrate`, then the full backend suite, admin vitest,
   and tsc/builds. This becomes the gate every future hardening issue relies on.
2. **Migration-from-zero test.** Replace/augment the `SELECT 1` migration test with a real
   migrate-from-empty that asserts no drift against `schema.prisma`.
3. **Route-guard sweep test.** (If not delivered by #99) a test that walks the route map and asserts
   every route is guarded or explicitly `@Public()`.
4. **Concurrency test scaffolding.** A small harness/pattern for `Promise.all` double-invoke tests so
   #100 and #101 can land their concurrency assertions on a shared foundation.

## Acceptance criteria

- [ ] CI runs on push/PR: migrate-from-zero → backend suite + admin vitest + tsc + builds, all green, against a disposable DB.
- [ ] A migration-from-zero test asserts a clean migrate with no drift (beyond `SELECT 1`).
- [ ] A route-guard sweep test exists (here or referenced from #99) and fails on an unguarded route.
- [ ] A documented, reusable concurrency-test pattern exists; at least one representative `Promise.all` double-invoke test runs in CI.
- [ ] The pipeline is documented (how to run locally, how the disposable DB is provisioned).

## UI surfaces
n/a (test/infra)

## Reference
n/a

## Blocked by
None — can start immediately. #100/#101 consume the concurrency-test scaffolding; #99 may own the route-guard sweep (dedupe with whichever lands first).
