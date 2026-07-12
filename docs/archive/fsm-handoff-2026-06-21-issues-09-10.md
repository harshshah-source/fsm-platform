# Handoff — FSM Platform, Issues 09–10 done; Issue 11 next

> **ARCHIVED 2026-07-12 — consumed session handoff.** Current state lives in `docs/SYSTEM-STATE-2026-07.md`; work tracking in `.scratch/fsm-platform-v1/INDEX.md`. Historical record only.
Date: 2026-06-21 · Workspace: `D:\fms_adminDashbooard\fsm-platform-greenfield`
Supersedes: `docs/progress/fsm-handoff-2026-06-21.md` (which covered 05–08).
Predecessors: `fsm-handoff-2026-06-17.md`, `...-mobile-shell-2026-06-18.md`.

## TL;DR

**Issues 04–10 are all DONE and green.** P1 (Ingestion→Tickets) is complete; P2 (Recommender &
scheduling) is underway — coverage/territory + MV (09) and the Recommender candidate-selection engine
(10) are done. **The local dev DB was migrated PG18 → PostgreSQL 16 + PostGIS 3.5.3 on :5433** during
Issue 09 (PostGIS has no PG18 Windows binaries; CONTEXT.md specifies PG16). All work is strict TDD;
nothing is committed (the repo is not git-initialised). **Next: Issue 11 — Batch auto-dispatch → SE
Day Plan.**

## Canonical status — read these first

- `docs/progress/09-coverage-territory-config-mv.md` — Floating-SE territory + PostGIS + `plant_eligible_floating_se` MV.
- `docs/progress/10-recommender-scoring-hard-filters.md` — Recommender engine (precedence, hard filters, sort, scoring, `recommendations`).
- Earlier: `05-…`, `06-…`, `07-…`, `08-auto-recovery-repeat-failure.md` progress docs.
- `.scratch/fsm-platform-v1/INDEX.md` — 04–10 marked `(done)`; 11 is next (`ready-for-agent`).
- `.scratch/fsm-platform-v1/issues/11-batch-auto-dispatch-se-day-plan.md` — the next issue + ACs.
- ADRs governing what's built: 0001 (precedence), 0003 (scoring tiers), 0006 (floating territory), 0017 (canonical order), 0021 (repeat/escalation).

## Environment / DB state (IMPORTANT — changed this session)

- **DB: PostgreSQL 16.14 + PostGIS 3.5.3, local, port `:5433`.** Role/db `fsm`/`fsm`, password `test123`.
  Connection in `apps/backend/.env` (gitignored): `postgresql://fsm:test123@localhost:5433/fsm?schema=public`.
- **The old PostgreSQL 18 on :5432 (no PostGIS) is left running as an untouched fallback.** Any handoff
  or progress note older than 2026-06-21 that says "local PG18" is stale.
- **PostGIS is a per-database superuser bootstrap** — `CREATE EXTENSION postgis` was run in the `fsm`
  DB by the user as `postgres`. The app role is **not** superuser, so geometry migrations assume the
  extension already exists; they never `CREATE EXTENSION`. On a fresh DB, that bootstrap must be done
  out-of-band before `migrate deploy`.
- This switch also closed **Issue 01 AC#2's** open PostGIS clause (its progress doc was updated).
- Memory written: `dev-db-pg16-postgis` (in the project memory dir) records this so future sessions
  don't trip on the stale PG18 references.

## Test baseline (all green)

- **Backend: 62 files / 205 tests.** PG16+PostGIS on :5433.
- **Admin: 11 files / 26 tests.** Mobile: unchanged since the shell (auth only).
- Both `tsc --noEmit` clean. Migrations: **17 applied**, `migrate status` = up to date.
- Run: `cd apps/backend && node node_modules/vitest/vitest.mjs run` and same under `apps/admin`.

## Issue 09 — what was built (recap)

PostGIS geography (`regions`, `districts`, `plants.location`), `engineer_territory_coverage`
(hierarchical + polygon union, CHECK ≥1 dimension), territory config API `/api/org/se-territory`,
geography reads `/api/org/geo/*`, the `plant_eligible_floating_se` MV (district/region/state ∪
`ST_Contains`) with CONCURRENTLY-on-edit refresh, a representative geography seed, and an Operations-
Head admin `TerritoryPage` (cascading selectors; polygon-draw deferred). AC#1 was already satisfied by
Issue 02.

## Issue 10 — what was built + architectural decisions

The Recommender **candidate-selection engine** (LLD §13.1 steps 1–5; dispatch is Issue 11). Pure
functions + a DB orchestrator under `apps/backend/src/recommender/`:
`canonical-sort.ts`, `hard-filters.ts`, `scoring.ts`, `candidate-selection.service.ts`,
`recommender.service.ts`, `recommender.module.ts`. New `recommendations` table + `rec_path` enum.

Decisions (both HITL-confirmed):
1. **Hard Filters are pluggable seams.** Pure predicates over a candidate-readiness shape. Data owned
   by later issues — vehicle ON_TRIP readiness (28), Common Kit / expected components (21), SE
   availability (25/26) — defaults to "pass"; the **drop logic is real and unit-tested** by injecting
   failing candidates. **Daily Capacity is enforced for real** (within-run counts vs `daily_capacity`)
   and drives the precedence fallback; `available` currently reads `engineer_master.is_active`.
2. **Output = per-ticket recommendation rows** (AC#6 persistence in this issue). No day-plan grouping /
   `work_schedules` / dispatch — that's Issue 11.
3. `STALE`/`UNKNOWN` vehicle readiness is a ZM conflict signal, **not** a drop.
4. **Floating distance-from-previous-stop deferred** (needs day-plan geo) — neutral (null) in scoring.
5. Seeded the within-(Tier×Bucket)-cell weights into `priority_rule_config` ('v1') and a
   `plant_cluster_multiplier` default (1.25) into `system_settings`.

## Open follow-ups / deferred items (consolidated)

- **Scheduling/cron absent across the board** — `runForZone` (10), MV `refresh()` nightly (09),
  `runAutoRecovery`/`runEscalationScan` (08) are invokable methods with no BullMQ/cron yet. The
  scheduler is its own forthcoming work (Issue 04 lineage).
- **Recommender filter data sources** (vehicle readiness 28, van stock/components 21, availability
  25/26) — wire real reads when those issues land; predicate logic is final.
- **Floating distance term** — neutral until day-plan geo (11/14).
- **Full ~700-district geography seed** — only a representative subset is seeded (09); full
  authoritative load is a separate reference-data task.
- **Polygon map-drawing editor** (09 AC#6) — reserved column + `ST_Contains` are live; the draw UI is
  a disabled "coming soon" affordance.
- **`recommendations.status` is free text** — currently `SUGGESTED` / `UNASSIGNABLE`; Issue 11 owns
  dispatch statuses.
- **Auth still in-memory** — login uses the seeded in-memory store (`ops.head@fsm.test`,
  `se.north@fsm.test`, etc., password `correct-password`); `users` table exists but isn't the auth
  source yet.

## Next issue — Issue 11 (Batch auto-dispatch → SE Day Plan)

Blocked by #10 (✓). Turns `recommendations` into dispatched plans: group into
`plant_batch_assignments` (one Plant → one SE), build `work_schedules` ACTIVE, order stops by distance,
`status=AUTO_ASSIGNED`, push "Day Plan is live" to the SE mobile app — **no approval gate** (Decision
§7 / ADR-0007). Surfaces: `/api/schedules/*`, `/api/batches/*`, the SE mobile Day Plan. Read LLD §13.1
step 6, ADR-0007 (morning-batch one-click), ADR-0019 (day-plan approval SLA/override), and the
`work_schedules` / `plant_batch_assignments` / `batch_assignment_tickets` schema (LLD §3.6).
Expect genuine forks worth surfacing: the BatchAssignment trigger (still no cron — likely another
invokable-method posture), distance-ordering of stops (needs geo), and the mobile Day Plan surface vs
backend-only for v1.

## How the user works (match this)

Strict TDD, **RED → GREEN → REFACTOR, one slice at a time**; show RED proof, impl, GREEN, deviations.
AFK mode — do **not** ask "Proceed?" between slices; stop only for (a) an architecture/backlog-ownership
decision, (b) an external install/blocker, (c) issue completion. The user surfaces genuine forks via
`AskUserQuestion` and expects the same (e.g. the Issue 10 hard-filter-seam + output-scope questions).
They are detail-oriented and will push back on unverified assumptions (they forced a real check on
PostGIS Windows availability rather than trusting the docs). They sometimes interrupt with "wait after
slice N" or correct scope mid-issue. Finalisation (progress doc + issue file + INDEX + handoff) is the
last step of every issue.

## Environment gotchas (will bite a fresh agent)

- **Run tests/typecheck via the binaries, not pnpm** (FortiGate blocks pnpm's network deps-check):
  `cd apps/backend && node node_modules/vitest/vitest.mjs run [file]`,
  `node node_modules/typescript/bin/tsc --noEmit`. Same under `apps/admin`. Pipe through
  `sed 's/\x1b\[[0-9;]*m//g'` before grepping (ANSI colour).
- **Bash tool cwd can persist or reset** between calls — always `cd` into the app dir in the command.
- **Prisma migrations are hand-written** (the `fsm` role lacks CREATEDB for `migrate dev`'s shadow DB):
  write `schema.prisma` + a hand-authored `migration.sql`, then `migrate deploy` + `generate`. The
  Prisma client is the TS generator (`src/generated/prisma/client.ts`) — can't `require()` from plain
  node; query via a throwaway spec using `PrismaService` if you need ad-hoc DB inspection.
- **Shared local Postgres → cross-test data overlap**: the `plant_eligible_floating_se` MV is global,
  so state-level floating territory from other tests can match a test's plant. Isolate spatial fixtures
  with a **unique state string** (see `candidate-selection.e2e-spec.ts`). Delete `ticket_events` before
  `tickets`, and `recommendations` before `tickets` (FKs are `ON DELETE RESTRICT`).
- **Agent cannot install deps or run superuser SQL** — ask the user for `pnpm add`, `CREATE EXTENSION`,
  role/db creation, etc.

## Suggested skills

- **`/tdd`** — every slice is strict RED→GREEN→REFACTOR.
- **`/triage`** — for any backlog/state review or scoping the next issue.
- **`/run` or `/verify`** — to launch backend + admin and confirm flows live (e.g. the Coverage page,
  or a recommender run) against the real app.

## Exact prompt to resume in a fresh session

> Read the repository and establish project state from source of truth only. Required reading:
> `docs/progress/fsm-handoff-2026-06-21-issues-09-10.md`, then CONTEXT.md, CLAUDE.md, the PRD, the
> backend LLD + ADRs (0007, 0019 for this issue), `.scratch/fsm-platform-v1/INDEX.md`, and the Issue 11
> file. Confirm the green baseline (backend 205 tests on PG16+PostGIS at :5433, admin 26). Then **start
> Issue 11 — Batch auto-dispatch → SE Day Plan** under strict TDD (RED→GREEN→REFACTOR, one slice at a
> time), AFK: surface genuine forks via AskUserQuestion, otherwise proceed and finalise with a progress
> doc + issue/INDEX update at the end.
