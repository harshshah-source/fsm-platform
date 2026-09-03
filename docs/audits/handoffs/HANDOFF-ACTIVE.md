# HANDOFF — module-gaps backlog, next parallel round — 2026-09-03

Auto-handoff: **ARMED**. Disarm with `/autohandoff off` when the run finishes, and rename this file
`HANDOFF-<issue>-<date>.md` in place — that folder is the audit trail, nothing moves to `docs/archive/`.

Status: active
Branch: `feat/autoplant-integration` · working tree **clean** (4 untracked junk files, see below)
This session's commits: `615f4d8` `88d81e5` `f29725e` `04c6b6d` `80418c3` `1863f5e` `b3c8396`
`dd5da2f` `7ebb5e0` `f22d227` `bc1eef2` (+ earlier `f686e23` `0f323d5` `a50e4b3`)

## The job

Build the module-gaps completion backlog — **31 slices, issues #336–#366** — filed 2026-09-03 from the
14-module gap survey. The brief is **`docs/module-gaps/IMPLEMENTATION-PLAN.md`**: §1 lists 21 survey
findings corrected or refuted (**where §1 disagrees with the survey brief, §1 wins**), §3 the
wave/dependency table, §4 the per-slice detail, §7 the ten operator decisions and the default each
slice assumes. `INDEX.md` section **P12** carries the same table with links, hashes and status.

One slice at a time (or one agent per file-disjoint slice, see below), red-first (`/tdd`), each with a
`docs/progress/<issue>.md` report, an INDEX row update and a session-log line.

### Done — 15 of 31

`#336` `#338` `#339` `#340` `#341` — the fixtures, the durable outbox, and the whole acting chain
(gate → attribution → write-door scope).
`#342` `#344` `#345` `#346` `#348` `#350` `#352` `#354` `#359` `#362` — one parallel round of ten.

Every one has a report in `docs/progress/`. **Read the report, not this file, for a slice's detail** —
each owns its decisions and its follow-ups.

## Next step

**The operator's last instruction was: "dont launch new issues , after these are done, then wait".**
The ten finished and were committed. **Do not start anything without asking.** When the operator says
go, the analysis below is done and current — no new dependency work is needed.

**Six slices are ready right now.** None is blocked by a dependency; each was held back only because it
collided on a file with a slice in the last round, and those slices are now committed:

| slice | was blocked on | the file they shared |
|---|---|---|
| #337 push delivery exit (FCM) | #354 | `notifications/notification.service.ts` |
| #356 intra-day queue hygiene | #354 | `notifications/notification.service.ts` |
| #347 report freshness stamps | #346 | `reports/reports.service.ts`, `api/reports.ts`, `ReportsPage.tsx` |
| #357 verification integrity | #346, #348 | `reports.service.ts:545-556`, `prisma/schema.prisma` |
| #360 SE poll contract | #345, #352 | day-plan outbox/notifier, `packages/shared/src/index.ts` |
| #343 audit writers | #348 | `ingestion/snapshots.controller.ts` |

**#337 still needs FCM credentials** (external provisioning) — the seam builds and is testable; only
live delivery is blocked.

**Newly unblocked by the last round, second wave:** #349 and #351 (needed #348), #353 and #366
(needed #352), #355 (needed #354). Still blocked: #358 (needs #357), #361 (needs #337), #363 (needs
#343), #364 (needs #347), #365 (needs #346 — satisfied — **plus a design stop**), #366 also has a
design stop.

**Do not re-derive the overlap matrix from wave numbers.** The plan's §3 says "within a wave, slices
are file-disjoint unless a dependency is listed" and **that is not true** — #346/#347/#357 are three
waves apart and share `reports.service.ts`. Build it from §4's "Code areas" plus a real `git grep`.

## Standing instructions from the user

Quoted, not paraphrased:

- **"dont launch new issues , after these are done, then wait /stop"** — the most recent, and it
  governs. The ten completed; nothing further was started.
- **"Do NOT parallelize blindly by wave number. Use BOTH: the explicit dependency graph … and actual
  file ownership/overlap in the repository"**, and *"uncertain ownership → treat as conflicting and
  serialize"*, and *"If the current environment cannot safely isolate concurrent work, reduce
  concurrency rather than risking the repository."*
- **"The objective is maximum safe parallelism, not maximum simultaneous agents."**
- **"continue and use /autohandoff on"** — the loop is armed.
- **"start implementation and use /autohandoff on"** — given after being shown the tree carried ~246
  uncommitted files from a parallel scheduler-forensics run. The user reaffirmed. That run has since
  committed everything; the tree is clean now.
- **"use option 3, then finish 336 and continue"** — the Platinum fixture is a scoped, expiring tier
  override (#157), never a re-tiered company.
- **"option 1"** — on #338's migration: hand-write it and rely on the suite, flagging that the drift
  gate was not run. **Standing answer for any later migration in this run** (#348 used it).
- **"commit it and start 338"** — commits are wanted per slice, **explicit paths only**.
- From the plan session, still live: *"Analyze the `docs/module-gaps/` results against the **current
  codebase** … verify every important finding against the current code before creating work. Do not
  blindly implement the report."* **This keeps paying** — see "What the premise got wrong" below.
- Treat the AFK policy in `CLAUDE.md` as live: stop only for architecture / business-rule conflict /
  backlog-ownership / external-access / security.
- **Handoffs live in `docs/audits/handoffs/HANDOFF-ACTIVE.md`.** There is only ever one.

## State of the tree

- **Everything is committed.** `git status` shows only 4 untracked files, none of them this work's:
  `.scratch-backend-run.json`, `apps/backend/_wh_evidence.mjs`, `audit/analysis-results.xlsx`,
  `docs/SUMMARYReport11thAug.xlsx`. Leave them or bin them; they are not part of any slice.
- **`.scratch/` is partly gitignored.** `.scratch/fsm-platform-v1/` is tracked; `.scratch/locks/` and
  `.scratch/PARALLEL-BRIEF.md` are **not** — the parallel tooling below lives only on this disk.
- **Verification of the integrated tree:** the session-log line in `INDEX.md` records it, and the raw
  log is `.scratch/backend-suite-parallel.log`. Per-slice results are in each `docs/progress/` report.
- **Half-done / stubbed:** nothing.

## How the parallel round was run (repeat this, with the fixes)

**The concurrency limit is the database, not the agents.**

- The `fsm` Postgres role is **not superuser and cannot `CREATE DATABASE`** (verified, not assumed).
  There is exactly one `fsm_test`, and `test/global-setup.ts` **truncates and re-seeds it on every
  run**. Two concurrent backend suites destroy each other, and the symptom — dozens of files failing
  on `401 Unauthorized` at login — is indistinguishable from a real regression. This cost three
  wasted suite runs across the session before it was understood.
- `TEST_DATABASE_URL` *does* override the derived URL (`test/test-db-url.ts`), so per-agent databases
  would work if the role could create them. Per-**schema** isolation is half-possible (`CREATE SCHEMA`
  succeeds) but **PostGIS is installed in `public`**, so migrations would need search-path surgery
  that was not verified. Not attempted.

What was done instead, and it worked:

1. **File isolation by strict per-agent ownership**, declared in each agent's prompt.
2. **Agents ran NO state-mutating git** — no `add`, `commit`, `checkout`, `stash`, `reset`. They left
   work in the tree and reported their exact paths; the orchestrator committed each slice by explicit
   path after inspecting its diff. This removed every index-lock race and every cross-staging risk.
3. **The one shared resource serialised by an atomic `mkdir` mutex**, `.scratch/locks/backend-test.sh`
   (untracked — recreate it if it is gone). Admin tests need no lock (jsdom, no DB).
4. A shared brief at `.scratch/PARALLEL-BRIEF.md` (untracked) carried the rules so prompts stayed short.

**The mutex had two bugs and both cost real test runs. If you rebuild it, avoid both:**

- **v1 failed OPEN**: `$(stat -c %Y "$LOCK" || echo 0)` — any transient failure (including the holder
  `rmdir`-ing between the `-d` test and the `stat`) made a fresh lock look decades old, so **every
  waiter broke the lock it was waiting on**. One agent lost two suites to it. Break a lock only when
  you *positively* know its age.
- **The fail-safe fix then failed CLOSED**: a lock abandoned between `mkdir` and its first write has
  no age at all, and "unknown means fresh" deadlocked waiters for the full 45-minute fallback. One
  agent sat 25 minutes behind an empty lock directory. A contentless lock (no `owner`, no `epoch`)
  older than a 60-second grace is now cleared.

**Ownership assignment was right but not sufficient.** Two things a plan-derived matrix misses:

- **Shared leaf files with no owner in the plan.** #346 had to touch `charts/TrendChart.tsx` (a gap
  cannot be drawn without a nullable datum) and `cron-tick-claim-wiring.e2e-spec.ts`; #352 had to
  touch `app.module.ts` and `inventory.module.ts` (a new controller cannot be reached unregistered).
  Both disclosed; both minimal. **Budget for module registration and shared chart/util files.**
- **Two agents can legitimately need one page.** #346 and #350 both needed `ManagerDashboard.tsx`;
  #346's edit was swept into #350's commit (`f29725e`) because the orchestrator committed by path
  without checking for a second author. Harmless here — both green — but check `git diff` per file for
  unexpected hunks before staging, the way the #340 pass did.

## What the premise got wrong (the verify-first rule earning its keep)

Four of ten slices found the issue file or plan wrong about the code. Expect this and check first:

- **#342** — `entity_type` is written three ways (`'ticket'` 16 sites, `'tickets'` 15, `'TICKET'` 1)
  and the per-ticket trail hard-filtered one. It had been **dropping about half its rows**. Readers
  now normalise; **normalising the 32 writers needs a backfill decision on an append-only table and is
  NOT done**.
- **#346** — the zero-window uptime rendered **100**, not 0 (flattering, so nobody investigates), and
  the unguarded maps are in `ManagerDashboard.tsx:86,92`, not `api/reports.ts`.
- **#348** — there was **no age threshold anywhere**; `ageMinutes` was computed and compared with
  nothing, so a 21-hour-old snapshot drew the same line as a two-minute-old one.
- **#354** — plan §4 is **stale**: #338 already landed CZ-02, so only CZ-01 remained.
- **#344** — the `?since=` both the issue and §4 promise "from #165" does not exist; #165 is unstarted.
- **#352** — the "active rows" the brief asks `GET /api/components` to return have **no column**;
  `ComponentMaster` has only `name`, `category`, `serial_tracked`.

## Known follow-ups left by this round (none blocking)

- **`audit_logs` has no index on `created_at`** — the sort is on every ledger query, the actor filter
  only on some. Recommended when someone owns `schema.prisma`: `(created_at DESC, id DESC)`, then
  `(actor_id, created_at)`, `(action, created_at)`, and an expression index on
  `(lower(entity_type), entity_id)`. Not a correctness or latency problem at `LIMIT <= 200` today.
- **`api/snapshots.ts`** should lift #348's new fields out of `SnapshotBanner`'s local declaration
  (**#351**); **`api/integrationHealth.ts`** needs `stale`/`staleAfterMinutes`/`schedulerEnabled`
  (**#349**); **`api/crossZone.ts`** should fold `direction` into `CrossZoneRow` (**#355**);
  **`api/vouchers.ts`** still types `apiMarkVouchersPaid` without `reason`/`failed[]` (whoever owns it
  next). Each page declares the type locally meanwhile and says why.
- **#362 left a real residual**: revocation kills the refresh token, but an **already-minted access
  token stays valid until it expires**. Closing it needs a token-version claim in `AuthGuard`.
- **#345 has no post-commit drain** — `PlantDeactivationModule` owns no `DayPlanNotifier`, so the
  2-minute sweep delivers. Latency, not durability.
- **A pre-existing drawer crash, found and deliberately not fixed:** `TicketDetailDrawer.tsx:537`
  reads `attempts.attempts.length` and throws on another shape (#244, present at HEAD).
- **`docs/ui/desktop/approved-designs/README.md`** should record the audit-ledger page as an
  approved-design gap (#342's ask; the file had no owner that round).

## Dead ends — do not retry

- **NEVER run two backend suites at once.** See above. Check for a live `node` process first.
- **Do not edit `src/` while a suite runs** — vitest transforms each test file as it loads it, so
  later files pick up half-finished edits and the run means nothing.
- **Do not `git add` a directory.** `git add apps/backend/test/` once staged ~60 files from another
  session. Stage individual paths.
- **Converting every caller of a function does not exercise a unit spec of the function itself.** #339
  changed `resolveManagerScope`'s signature, converted both decorators, and left `manager-scope.spec.ts`
  on the old shape — five tests throwing, invisible to every acting e2e. Grep `test/` for the
  **symbol** when you change a signature.
- **Do not defer an enqueue (or a gate) because "there is no transaction to enqueue into".** Wrong
  three times in #338 — the mutations were local and a local transaction was available.
- **Do not hand an interfering Prisma proxy only to the service under test when the write goes through
  `withAudit`** — it opens its transaction on the **`AuditService`'s own** client.
- **Do not reuse `test/fixtures/outbox-crash-injection.ts` for a day-plan producer** —
  `failingNotifyEnqueue` deliberately lets day-plan rows through (#338 needed that), so it injects
  nothing. #345 used a local proxy.
- **Do not regenerate `prisma/drift-baseline.txt`** (99 lines, must not grow).

## Gotchas

- **`tsc --noEmit` does not cover `apps/backend/test/`**, and `tsconfig.test.json` has ~50
  **pre-existing** errors — it is not a green gate. Grep it for your own error class.
- **The Bash tool truncates a long heredoc**; write files over ~120 lines with the Write tool.
- **`print()` of non-ASCII fails on this box** (cp1252 stdout) *after* the write already happened —
  check the file before redoing an edit; a blind retry can double-apply.
- **A backgrounded command piped through `tail` writes nothing until it exits**, and its task-output
  file stays empty. Redirect to a log file directly (`> log 2>&1`).
- **The generated Prisma client is TypeScript** (`src/generated/prisma/client.ts`), so a throwaway
  `node` script cannot require it. Query the test DB from a spec, not a script.
- **`apps/backend/src/generated/` is gitignored** — run `npx prisma generate` after a schema edit.
- **The schema is at `apps/backend/prisma/schema.prisma`**, not `prisma/schema.prisma`.
- **The admin nav is `apps/admin/src/components/shell/nav.ts`** — `src/lib/nav.ts` does not exist,
  whatever the plan says.
- **e2e fixture logins**: `zm.north@fsm.test`, `csm@fsm.test`, `ops.head@fsm.test`, `wm@fsm.test`,
  `se.north@fsm.test`, password `correct-password`. There is no `oh@fsm.test`.
- **`OPEN` is TROUBLESHOOT-only** (`tickets_work_type_status`, #309) — invalid fixture states cost
  #350 a red cycle.
- Known-flaky, neither broken: `dispatch-crashed-zone-recovery`, `global-guard-validation` (#184).
  Under parallel load several admin files time out and pass in isolation; re-run before believing one.
- **Acting is gated (#339), attributed (#340) and narrowing (#341).** A manager write door takes
  `@CurrentScope()`/`@CurrentActor()`, never `{ role: user.role, zoneId: user.zone_id }`;
  `test/acting-scope-route-sweep.spec.ts` fails any new door that hand-builds a scope, and
  `apps/admin/test/acting-header-builder.test.ts` fails any admin client not going through
  `authHeaders()`.

## Remaining acceptance criteria

All fifteen landed slices have their ACs ticked in their issue files, each with a report named in the
`Status:` line. #341's AC1 and #340's AC1 were each met with a deliberately narrowed reading, recorded
in the issue file at the AC itself. Nothing is half-met.

## Open questions / HITL

- **Plan §7 holds ten operator decisions**, each with the default its slice assumes. Live ones for the
  next round: **VCH-08** (un-pay — #359 did not build it), **AC-03** (reactivation restores nothing —
  #345 kept the default), **E-15/E-17**, **INTRA-G4**, **INV-G2** (#353), **AA-06** (not built).
- **#365 and #366 carry design stops** in the plan and should not start without one.
- **#337 needs FCM credentials** — external provisioning.
- **The request-scoped acting guard** (#339) was raised to the operator and never answered; it was
  built on plan §7's default. `common/guards/acting-context.guard.ts` is the file to change if the
  answer differs.
- **The dev database has not been seeded.** `SEED_DEV_WALK_FIXTURES=true npm run seed:dev-fixtures` is
  an operator action; until it runs, the 17 blocked survey findings stay blocked.

## Suggested skills

- **`/tdd`** — red-first per slice; each slice's Verification line in plan §4 is the test to write first.
- **`/code-review`** — per finished slice, before the bookkeeping.
- **`/diagnose`** — when a cited `file:line` no longer matches behaviour.
