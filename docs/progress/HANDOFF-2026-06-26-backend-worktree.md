# Handoff — 2026-06-26 · backend issue line in an isolated worktree

Fresh-agent handoff for the FSM GPS platform. Captures only what is **not** in other artifacts. Read
these first, in order:

1. `CLAUDE.md` + `CONTEXT.md` (domain authority).
2. `docs/agents/workflow.md` (AFK HITL policy, per-slice TDD report, parity gate).
3. `.scratch/fsm-platform-v1/INDEX.md` — **the live backlog truth** (status per issue).
4. Auto-memory `MEMORY.md` — esp. **`shared-fe-branch-concurrent-agent.md`**, **`dev-db-pg16-postgis.md`**,
   **`gitignore-swallows-source-dirs.md`**, **`afk-tdd-auto-proceed.md`**.
5. Per-issue progress docs (local-only, gitignored — **do not re-summarise**):
   `docs/progress/{33,34,39,40}-*.md` (in the worktree, see below).

## CRITICAL: two worktrees, two agents, one repo

There are **two git worktrees on the same repo**, each with a different active agent. **Do not cross
them.**

| Worktree dir | Branch | Owner | HEAD at handoff |
|---|---|---|---|
| `D:/fms_adminDashbooard/fsm-platform-greenfield` | `feat/fe-enterprise-ui` | **concurrent FE agent** (FE-series enterprise UI) | `74ac934` (was advancing FE-06→FE-15+) |
| `D:/fms_adminDashbooard/fsm-platform-issue34` | `feat/issue-34-install-lifecycle` | **this backend line** | `1f773ea` |

- **Continue backend work ONLY in `D:/fms_adminDashbooard/fsm-platform-issue34`.** Never edit/commit in
  the FE worktree.
- The backend branch was based on `78db5a5` (last pure-backend commit) + cherry-picked `ba6271a` (test
  fix) + `ed96b19` (#33). It has **zero frontend commits** by design — verify with
  `git diff --name-only 78db5a5 HEAD -- apps/admin apps/mobile ':(glob)**/*.tsx' ':(glob)**/*.css'`
  (must be empty).
- The two branches diverge mainly on `.scratch/fsm-platform-v1/INDEX.md` + the per-issue spec files; they
  reconcile at eventual merge to `main`. Backend state for #33 is identical on both.
- **Follow-up numbering is shared across both branches via INDEX** — the FE agent reserved #69 (Install
  admin UI) and #70 (FE-09 form-read). This backend line added #71 (mobile install) and #72 (recommender
  preventive-mode). Check INDEX before claiming a new follow-up number.

## Work completed THIS session (all committed in the backend worktree)

Commits on `feat/issue-34-install-lifecycle` (newest first) — see commit messages + `docs/progress/*`:
- `1f773ea` **#40** Soft Inactive Count trend + Recommender mode switch
- `edb13a6` **#39** Fleet Uptime % monthly report
- `d51ec9b` **#34** Install lifecycle + verification + serial visibility
- `ed96b19` **#33** Install Ticket create (cherry-pick)
- `ba6271a` test-isolation fix (cherry-pick)

Issue specs are `Status: done` with AC checkboxes + a Disposition section in
`.scratch/fsm-platform-v1/issues/{33,34,39,40}-*.md`. **#39 + #40 fully unblock FE-21.**

### Architectural facts established this session (not obvious from a cold read)
- **Reports live in a new `src/reports/` module** (`ReportsModule`/`ReportsController` registered in
  AppModule, mirroring Dashboard). It now holds `ReportsService` (fleet-uptime + soft-inactive-trend),
  `FleetUptimeAggregationService`, `SoftInactiveCountService`. New report endpoints go here.
- **Aggregation/worker posture = on-demand, no scheduler** (same as VerificationService). Each worker is
  an Operations-Head `POST …/recompute` endpoint; the BullMQ cron is a deferred seam. Mirror this.
- **`device_states.eligible_for_uptime`** is the canonical Eligible-Device gate (active PGI ≤15d AND not
  Non-Op, from `eligibility.ts`). Reuse it for any uptime/soft-inactive denominator — don't re-derive.
- **Downtime = failure-cycle overlap with the window** (`FailureCycle.openedAt`→`closedAt`). This is the
  computable "device was offline" model used by Fleet Uptime; reuse for #44 (device downtime trend).
- **Recommender now has a mode seam**: `RecommenderService.runForZone` reads
  `SoftInactiveCountService.modeForZone(zoneId)` and records `RunSummary.mode` + `scoreBreakdown.mode`.
  It does NOT yet change ranking by mode — that's **#72** (preventive-mode scoring). `SoftInactiveCountService`
  is a provider in BOTH `ReportsModule` and `RecommenderModule`.
- **Nest DI gotcha**: a non-injectable ctor param (e.g. `thresholdPct: number`) must be `@Optional()` or
  Nest tries to resolve a `Number` provider and the whole AppModule fails to boot e2e tests.

## Next work (what the user asked: "continue in next session")

Continue the **P7 reporting cluster** in dependency order, in the backend worktree. All deps met, all
AFK-ready, each unblocks an FE chart page:
- **#41 Root Cause Analytics** (→ #16 done) — unblocks FE-23. *(recommended next — user was told this)*
- **#43 ZM Performance Scorecard** (→ #13 done) — unblocks FE-25.
- **#44 Device Detail + Lifetime Downtime Trend** (→ #08 done) — unblocks FE-22; also closes #49's
  deferred admin `deal_type` tag-control backend.
- **#72 Recommender preventive-mode scoring** (filed this session) — engine behaviour for #40's mode seam.
- *Blocked*: #42 System Efficiency (needs #30 → #29 → #03 spine). #03 + #54 remain the big HITL/greenfield
  unlocks (notification spine; mobile foundation).

Follow the same shape each issue: hand-author migration if needed → `migrate deploy` + `generate` → TDD
slices → `tsc --noEmit` + full `vitest run` green → set spec `done` + INDEX line + `docs/progress/NN-*.md`
→ **focused partial-commit pathspec** (exclude `pnpm-lock.yaml`) → file follow-ups for deferred ACs.

## Repo gotchas specific to this worktree (cost real time if unknown)

- **The worktree needed its own setup** (already done, persists): `pnpm install`, build `@fsm/shared`
  (`cd packages/shared && pnpm build` — else `Failed to resolve entry for @fsm/shared`), copy
  `apps/backend/.env` from the FE worktree (it's gitignored), `npx prisma generate`. DB already migrated
  (PG16+PostGIS on **5433**, db `fsm`, shared between worktrees — backend tests only).
- **`pnpm-lock.yaml` shows as modified** in the worktree (install churn: `@playwright/mcp`/`turbo`). It is
  intentionally **left uncommitted** and **excluded from every commit** — do not stage it.
- **Migrations**: dev user can't shadow (`prisma migrate dev` fails P3014). Hand-author
  `prisma/migrations/<UTC-ts>_<name>/migration.sql` + edit `schema.prisma`, then `migrate deploy` +
  `generate`. Latest migration: `20260626180000_add_soft_inactive_history` (36 total, 0 pending).
- **`docs/*` is gitignored** (only `docs/agents/` tracked) — progress docs are local-only; never
  `git add -f` them. Tracked planning is `.scratch/fsm-platform-v1/`.
- **Tests are real-DB e2e via vitest** (`npx vitest run <pattern>`), `fileParallelism:false`. Full suite
  ~6 min. Current: **169 files / 583 passed / 0 failed**, `tsc` clean.
- **Bash tool cwd resets** between calls — use absolute paths / `cd` each time.
- **No `gh`/`GH_TOKEN`** — PRs can't be opened from here; branches are local only.

## Suggested skills for the next session

- **`/tdd`** — the required red-green-refactor protocol for every slice.
- **`/field-ops-director`** — sanity-check reporting issues (#41 root-cause, #43 scorecard, #44 downtime)
  against field/ops reality before/after building.
- **`/code-review`** or **`/review`** — run against `78db5a5` (the backend base) before committing a batch
  to catch correctness/altitude issues across the now-5-commit backend line.
- **`handoff`** — at the end of the next session.
