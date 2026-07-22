# 144 — Dispatch-correctness layer exists only as uncommitted files on one disk
Status: accepted
Type: AFK

> Source: `docs/audits/2026-07-22-adversarial-review-admin-backend.md` §6.1 (R1, **`fail`**) and
> `docs/audits/2026-07-22-full-project-audit.md` §3.1 + rank 1. Re-verified 2026-07-22: `.github`
> absent, 42 dirty paths, migration `20260721120000_batch_run_attribution/` untracked.

## Background

[#127](./127-dispatch-per-se-isolation.md) (per-SE dispatch isolation → APPEND) and
[#138](./138-floating-eligibility-mv-drift-on-se-admin-edits.md) (floating-eligibility MV drift) are
both marked ✅ DONE in INDEX. Their code is not in git.

The prior audit ranked committing this **rank 1, effort "Minutes", confidence HIGH** — in a document
dated **the same day** as the review that re-raised it. In the interval the working tree grew from
**37 → 41 → 42** dirty paths.

## Problem

The dispatch-correctness layer driving the live cron exists only as uncommitted files on a single
development machine, and **migration `20260721120000_batch_run_attribution` has already been applied
to the running dev database while remaining untracked**.

The repository therefore cannot reproduce the schema the running system uses.

## Root Cause

No commit discipline is enforced at any boundary: no CI (`.github` absent), no pre-commit hook
(`.husky` absent), and a working tree that mixes four unrelated workstreams — so "commit everything"
is unsafe and "commit nothing" becomes the path of least resistance.

## Evidence

`git status --porcelain` → **42 paths** (the audit said 41; the audit document itself is the 42nd),
which partition cleanly into four groups with no ambiguous file:

| Group | Paths | Owner |
|---|---|---|
| **A — backend dispatch correctness** | `apps/backend/prisma/schema.prisma` (+8 lines), `apps/backend/prisma/migrations/20260721120000_batch_run_attribution/` *(untracked)*, `src/recommender/recommender.service.ts`, `src/scheduling/batch-assignment.service.ts`, `src/scheduling/dispatch-run.service.ts`, `src/scheduling/dispatch-transparency-query.service.ts`, `test/dispatch-transactional.e2e-spec.ts`, `test/dispatch-zone-wedge.e2e-spec.ts`, `test/dispatch-same-day-append.e2e-spec.ts` *(untracked)*, `test/recommender-cross-zone-capacity.e2e-spec.ts` *(untracked)*, `prisma/seed-mock-engineers.ts`, `scripts/reset-reseed-ses.cjs` *(untracked)* | #127 / #138 |
| **B — admin SE-directory rework** | `src/components/data/EditableCell.tsx` *(untracked)*, `src/components/data/index.ts`, `src/api/engineersAdmin.ts`, `src/pages/engineers/SeManagementDirectoryPage.tsx` | unfiled — **this issue files it** |
| **C — admin dashboard / shell polish** | `src/components/domain/InactiveCountLink.tsx` *(untracked)*, `src/components/domain/index.ts`, `src/components/shell/{AppShell,Footer,Sidebar,SidebarContext}.tsx`, `src/index.css`, `src/components/charts/FleetActivityTrendChart.tsx`, `src/pages/dashboard/{DashboardHero,ActivityTrendSection,ZmDashboard,ZoneOverviewTable}.tsx`, `src/pages/dispatch/ZoneDispatchTable.tsx`, `test/{dashboard-filters,dispatch-zone-detail,inactive-total-display}.test.tsx` | unfiled — **this issue files it** |
| **D — docs** | 5 audit docs + 2 architecture docs + `docs/SYSTEM-STATE-2026-07.md` + `.scratch/fsm-platform-v1/INDEX.md` | — |

Governance facts:

- `ls .github` → **No such file or directory** (no CI).
- `ls .husky` → **No such file or directory** (no pre-commit hook).
- `git rev-list --left-right --count origin/feat/autoplant-integration...HEAD` → **`0 0`** (the prior
  audit's four unpushed commits *were* pushed — that recommendation was actioned; **the actual risk
  was untouched, because the correctness layer was never *committed*, so pushing changed nothing
  about it**).
- `docs/audits/test.md` is a near-duplicate of `docs/audits/2026-07-22-adversarial-review-mobile-readiness.md`
  (identical header block) — a scratch artifact. Dedupe or `git mv`; do not commit both.

## Current Behaviour

The proven fix for the live cron survives on one machine only. The live dev DB carries a schema no
committed migration produces. INDEX marks #127/#130/#133/#134/#135 as ✅ DONE against commits that do
not exist for the parts still dirty — **the tracker is making claims git cannot corroborate.**

## Expected Behaviour

Four coherent, independently revertible commits. `git status` clean of all backend
scheduling / recommender / prisma paths. Migration tracked. A from-zero migrate reproduces the schema
the running system uses.

## What to build

Four **explicit-path** commits in dependency order — A → B → C → D — with suite verification between
A and B, plus the INDEX session-log line the progress convention mandates.

> **Do not `git add -A`.** Group C touches a concurrently-edited admin surface including three
> modified specs; sweeping it into the backend commit destroys reviewability and couples unrelated
> rollbacks. Commit by explicit path only.

## Acceptance criteria

- [x] Group A committed by explicit path (`5937f2c`), message referencing #127/#138, with `20260721120000_batch_run_attribution/` tracked.
- [x] Group A's suites verified green **before** the commit: 4 core specs **9/9**, full dispatch regression **14 files / 47 tests**, full recommender regression **9 files / 22 tests**, `tsc --noEmit` clean.
- [x] **Drift checked — with a caveat that became its own finding.** `prisma migrate diff` against a fully `migrate deploy`-ed database shows **`plant_batch_assignments` zero times**: this migration is drift-free and reproduces its `schema.prisma` delta exactly. **However the repo as a whole is NOT drift-free** — see the finding below. A true scratch-DB from-zero run was not performed: the PostGIS extension is a one-time superuser bootstrap (`test/global-setup.ts` docblock, `.env.example`) and no `psql` is available on this host, so the check ran against the migrations-built `_test` database instead. That is a genuine migrations-only surface, but it is **not** identical to provisioning a brand-new database, and is stated rather than glossed.
- [x] Groups B and C committed separately, each with a filed stub — **#150** (SE-directory inline editing) and **#151** (dashboard/shell polish + `InactiveCountLink`).
- [x] `reset-reseed-ses.cjs` — **explicit decision: tracked.** `apps/backend/scripts/` is already a tracked directory with sibling dev scripts (`db-explore.cjs`, `run-ingest.cjs`); the script is **dry-run by default** (`--yes` required to execute), carries a "Never run against production" banner, and its docblock says to keep it in sync with the tracked `prisma/seed-mock-engineers.ts` — which is an argument for tracking it beside its twin, not away from it.
- [x] Group D committed; `docs/audits/test.md` **deleted** after verifying it byte-identical to `2026-07-22-adversarial-review-mobile-readiness.md` modulo CRLF (same 315 lines; `diff` clean after `tr -d '\r'`).
- [x] `git status` clean of every `apps/backend/src/scheduling`, `apps/backend/src/recommender`, and `apps/backend/prisma` path — in fact the **entire working tree** was clean after Slice 4.
- [x] INDEX session log appended (date · what landed · commit hashes).

### Finding surfaced by AC#3 — pre-existing repo-wide schema drift (NOT caused by this issue)

`prisma migrate diff --from-config-datasource --to-schema` against a fully migrated database is
**non-empty**: **22 unrelated tables** drift — 18 renamed indexes, 1 renamed foreign key, and
FK/default-annotation differences (e.g. `vehicle_unavail_ticket_fkey` vs
`vehicle_unavailability_reports_ticket_id_fkey`; `zpsm_month_idx` vs
`zm_performance_summary_monthly_month_idx`). Cause: hand-written migrations used short index names
where Prisma's introspected default naming differs. It is **cosmetic — naming, not structure.**

**This blocks nothing today, but [#107](./107-ci-concurrency-guard-migration-tests.md) AC#2
("a migration-from-zero test asserts a clean migrate with no drift") will trip on it immediately.**
#107 must either normalise the names first or scope its drift assertion to structural differences.
Recorded in the commit body, the INDEX session log, and `SYSTEM-STATE` so it cannot be rediscovered
as a surprise.

## TDD Strategy

**TDD does not apply.** This is commit hygiene — there is no behaviour to assert and no failing test
to write. `docs/agents/workflow.md` mandates strict TDD for *implementation*; forcing a RED here
would be ceremony with no signal.

**Verification-driven instead**, and the verification is stricter than a test would be:

1. Group A's suites must be green **before** the commit, not after.
2. A from-zero migrate must show **no drift** — this is the check that would have caught the untracked
   migration in the first place, and it is the same check [#107](./107-ci-concurrency-guard-migration-tests.md)
   Slice 2 automates.
3. Full admin suite after Groups B and C.

## Implementation Slices

### Slice 1 — Commit Group A (backend correctness layer)

- **Objective:** the dispatch-correctness layer is in version control and reproducible.
- **Files:** Group A above, by explicit path.
- **Services:** `scheduling` (batch-assignment, dispatch-run, dispatch-transparency-query), `recommender`.
- **Database:** track migration `20260721120000_batch_run_attribution`; `schema.prisma` +8 lines.
- **Frontend:** none.
- **Tests:** `dispatch-transactional`, `dispatch-zone-wedge`, `dispatch-same-day-append`,
  `recommender-cross-zone-capacity` — all green **before** committing.
- **Acceptance criteria:** AC 1, 2, 3, 5.
- **Definition of Done:** backend scheduling / recommender / prisma paths clean in `git status`;
  from-zero migrate shows no drift.

### Slice 2 — File and commit Group B (`EditableCell` / SE directory)

- **Objective:** the SE-directory rework is tracked so its test can be retargeted.
- **Files:** Group B above.
- **Services / Database:** none.
- **Frontend:** `EditableCell` + the SE Management Directory rework.
- **Tests:** admin suite — note `se-management-directory.test.tsx` is **expected to remain red** here;
  [#142](./142-se-directory-row-selection-contract.md) owns it and lands immediately after.
- **Acceptance criteria:** AC 4.
- **Definition of Done:** `EditableCell.tsx` tracked; a stub issue exists; **unblocks #142**.

### Slice 3 — File and commit Group C (dashboard / shell polish)

- **Objective:** the remaining admin working tree is tracked.
- **Files:** Group C above, including the three modified specs.
- **Services / Database:** none.
- **Frontend:** shell (AppShell/Sidebar/Footer/SidebarContext), dashboard (hero/trend/zone-overview),
  dispatch zone table, `InactiveCountLink`, `index.css`.
- **Tests:** full admin suite after the commit.
- **Acceptance criteria:** AC 4.
- **Definition of Done:** admin suite green apart from the failures owned by #142/#143.

### Slice 4 — Commit Group D (docs) and append the INDEX session log

- **Objective:** the audit trail of this work is itself in version control.
- **Files:** Group D above.
- **Acceptance criteria:** AC 6, 7, 8.
- **Definition of Done:** `docs/audits/test.md` resolved; session-log line appended;
  `git status` clean or only-intentional.

All four slices are independently mergeable and independently revertible.

## Rollback Plan

Each group is exactly one revertible commit. **Group A additionally needs a documented down-path**:
the migration has already been applied to the live dev DB, so reverting the commit after application
leaves the DB ahead of the repo. Record the manual down-SQL in the commit body so a revert is
actionable rather than theoretical.

## Dependencies

None — nothing blocks this. It **blocks** [#142](./142-se-directory-row-selection-contract.md)
(Slice 2), [#146](./146-zm-override-integrity-defer-remove.md),
[#147](./147-day-plan-date-filter-schedule-closure.md) (all three touch files currently dirty), and
[#107](./107-ci-concurrency-guard-migration-tests.md) (whose from-zero-migrate AC is unsatisfiable
while the migration is untracked).

## Estimated Effort

30–60 minutes. **Priority: P0 — the single highest-value next task on the roadmap.** It is the only
item whose artifact can be *lost*: a stale test expectation is re-derivable in fifteen minutes, but
two completed TDD'd issues plus an applied-but-untracked migration are not.

## UI surfaces

n/a for Slices 1 and 4. Slices 2 and 3 **commit already-built** admin surfaces (SE Management
Directory rework; dashboard/shell polish) — they create no new surface and change no behaviour beyond
what is already in the working tree. Parity gate not engaged: nothing is being deferred.

## Reference
n/a (no new UI is designed by this issue)

## Blocked by
None.
