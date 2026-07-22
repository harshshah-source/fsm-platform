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

### Added 2026-07-22 — adversarial review v3 (`docs/audits/2026-07-22-adversarial-review-admin-backend.md`)

*Appended, not rewritten. The five criteria above stand unchanged.*

- [ ] **The CI test step asserts vitest's own exit code.** No pipe into `tail`/`head`/`tee` or any status-swallowing command anywhere in the workflow. Verified by deliberately breaking one test, confirming the job fails, and reverting.
- [ ] **CI runs both suites in full** — backend (1176 tests / 289 files) and admin (318 tests / 82 files) — never a hand-picked subset.
- [ ] **N3 — the admin→backend HTTP seam has unmocked coverage in the pipeline:** at least one smoke test exercises admin→backend over real HTTP against a booted backend, **or** `apps/admin/visual/` is promoted into the pipeline with a CI-started dev server. Whichever is chosen is documented as the seam's owner.
- [ ] The issue's blocker record is corrected (see "Blockers cleared" below) so no future session re-parks this on obsolete grounds.

## UI surfaces
n/a (test/infra)

## Reference
n/a

## Blocked by
None — can start immediately. #100/#101 consume the concurrency-test scaffolding; #99 may own the route-guard sweep (dedupe with whichever lands first).

**Amended 2026-07-22:** now blocked by **#141, #142, #143, #144** — see "Sequencing" below. Still
unblocked in the *infrastructural* sense (the original "None" was about external prerequisites).

---

## 2026-07-22 — blockers cleared, evidence refreshed, and why this is the root cause

*Appended by the adversarial-review-v3 conversion. Nothing above was modified.*

### Both standing obstacles are gone

1. **The OOM objection is disproven.** The prior audit declined to run the backend suite because
   *"the docs' own OOM warning makes an unattended full run unreliable."* The v3 review ran it: **289
   spec files, `fileParallelism: false`, against real Postgres 16 + PostGIS, completed unattended in
   544 s (~9 min)** — 1 failed / 1170 passed / 5 skipped. That is well inside any CI budget. Isolation
   held: `test/global-setup.ts` targets the `_test` sibling DB and the live dev DB was untouched.
2. **The "no git remote" premise is stale.** `docs/agents/workflow.md:47` parks CI partly because
   *"CI needs a git remote"*, and `docs/agents/issue-tracker.md:3` still says the repo *"is not (yet)
   a git repository and has no GitHub/GitLab remote."* Both are false:
   `origin  https://github.com/harshshah-source/fsm-platform.git`, working tree in sync (`0 0`).
   Corrected by **#149**.

### The exit-code trap, demonstrated on this repo

During the review the admin suite was run as `npx vitest run … | tail -60` and the harness reported
**"exit code 0"** — that is `tail`'s status through the pipe, **not vitest's**. The suite was red the
whole time. Re-confirmed during roadmap conversion with `echo "EXIT=${PIPESTATUS[0]}"` → **1**.

**This is exactly how a CI job gets written and reports green on a red suite.**

### Why this issue is the root cause of every Gate-1 finding

Three guarded changes, both sides of the stack, none noticed:

| Change | Guarding test | Red for |
|---|---|---|
| `b9242da` #128 widened the operational-status filter (backend) | `integration-reconciliation.e2e-spec.ts` | **43 commits / 4 days** |
| `ad03769` removed the Critical KPI (admin) | `kpi-critical-plus-consistency.test.tsx` | **3 commits** |
| uncommitted `EditableCell` rework (admin) | `se-management-directory.test.tsx` | uncommitted |

**The decisive detail is that the #128 session was not careless.** INDEX:113 records a deliberate,
author-selected four-suite regression sweep — *"8/8 green … regression sweep green (device-state 23/23
· plant-deactivation+ticketing 18/18 · recommender 10/10 · dispatch 12/12)"*. It still missed the
break, because nothing connects "device departure lifecycle" to "integration health reconciliation
counts" in any author's mental model.

**A hand-picked regression sweep can only cover the blast radius the author already imagined.** No
amount of diligence reliably selects the right subset — which is why AC "runs both suites in full" is
not negotiable, and why both prior audits' "test posture" assessments measured test *volume* while the
suites were red.

### Sequencing

Land **#141, #142, #143** (both suites green — ~35 min combined) and **#144** (the correctness layer
committed, so a from-zero migrate reproduces the running schema) **before** building the pipeline.

Rationale: a CI job that is red on its first run gets muted, and #144's untracked migration would make
the from-zero-migrate AC fail for a reason nobody could diagnose from the repository.
