# HANDOFF — module-gaps backlog, Round 2 — COMPLETE 2026-09-03

**CLOSED. This file is audit trail, not a brief — do not execute it.** Round 2 landed all six slices
(#343 `0f45c99`, #347 `ddc2e05`, #353 `989ba44`, #355 `5ce3699`, #356 `59c2096`, #360 `042aa0b`) plus
two verification fixes (`735a0b6`, `2130d43`). Both suites green — backend 465 files / 2708 tests,
admin 132 / 971, zero test failures. The current state is `docs/SYSTEM-STATE-2026-07.md` and
`.scratch/fsm-platform-v1/INDEX.md` §P12; **read those, not this.**

**What the next session should know that is not in the slices' own reports:**

- **`dispatch-crashed-zone-recovery` was never flaky** — it failed after 18:00 IST because three call
  sites did not pin the recovery cutoff their ten siblings pin. Fixed in `test/setup-env.ts`
  (`735a0b6`). The "known-flaky" label below is **wrong** and is left only as the record of what was
  believed. `global-guard-validation` (#184) is still genuinely flaky under parallel load.
- **Round 3 is planned and unblocked** — see the "Round 3" section below, still accurate: **#337**
  (needs FCM credentials, external), **#357** (owns `schema.prisma` that round), **#349**, then
  **#351** once #349 frees `api/snapshots.ts`.
- **#367 was filed** for the mobile surfacing gap #360 left; **INV-G2 is still unanswered** and #353
  built its assumed default.

Status: closed
Branch: `feat/autoplant-integration` · working tree **clean**
Last commit: `3d74eff`

## The job

Build the module-gaps completion backlog — **31 slices, issues #336–#366** — filed 2026-09-03 from the
14-module gap survey. The brief is **`docs/module-gaps/IMPLEMENTATION-PLAN.md`**: §1 lists 21 survey
findings corrected or refuted (**where §1 disagrees with the survey brief, §1 wins**), §3 the
wave/dependency table, §4 the per-slice detail, §7 the ten operator decisions and the default each
slice assumes. `INDEX.md` section **P12** carries the same table with links, hashes and status.

**How to run several slices at once is documented in `docs/agents/parallel-execution.md`.** Read it
before launching anything — it carries the single-test-database constraint, the git discipline, the
mutex script (with the two bugs it has already had), and the agent-brief checklist.

### Done — 15 of 31

`#336` `#338` `#339` `#340` `#341` — fixtures, the durable notification outbox, and the whole acting
chain (gate → attribution → write-door scope).
`#342` `#344` `#345` `#346` `#348` `#350` `#352` `#354` `#359` `#362` — one parallel round of ten,
verified together: **backend 466 files / 2630 tests, 461 passed, 3 skipped, zero failures; admin
129 files / 928 tests, all passing.**

**Read each slice's `docs/progress/<n>-*.md` report for its detail** — each owns its decisions,
its defaults and its follow-ups. Do not re-derive them from the diff.

---

## Next step — Round 2 is RUNNING (launched 2026-09-03)

**Launched.** The mutex was recreated at `.scratch/locks/backend-test.sh` and round-tripped
(`backend-test.sh echo ok` → `ok`, lock released clean). The brief was written to
`.scratch/PARALLEL-BRIEF.md` from `docs/agents/parallel-agent-brief.md` with this round's specifics.
**Six agents launched in one message**, file-disjoint: **#343 #347 #353 #355 #356 #360**.

**If you are a fresh session reading this while the round is still running:** do not relaunch them.
Check `git status --porcelain` for uncommitted work in the six file lists below and pick up at
step 4 of "How to launch Round 2" (inspect, commit by explicit path, then the three bookkeeping files).

**Path corrections found while verifying the six lists against the tree** (plan §4 was wrong or vague):

- `src/cross-zone/` holds `cross-zone.controller.ts`, `cross-zone.dtos.ts`, `cross-zone.module.ts`,
  **`cross-zone-escalation.service.ts`** — there is no `cross-zone.service.ts`.
- `business-sweep-scheduler.service.ts` and `stranded-work-escalation.service.ts` live under
  `src/scheduling/` and `src/intraday/` respectively, not where §4 implies.
- #360's query service is **`me-tickets-query.service.ts`**.
- #353's "ZM dispute surface" is **`apps/admin/src/pages/inventory/ShadowUseQueuePage.tsx`**
  (+ `api/shadowUse.ts`) — those are the only two files mentioning disputes in the admin app.
- Every other path in the six lists exists as written.

Six agents, file-disjoint, all dependencies satisfied. This grouping is already computed from
plan §4's "Code areas"; **spot-check each list against the tree before launching**, because the plan
has been wrong about paths before (see Gotchas).

| slice | what it is | owns (from plan §4 — verify) |
|---|---|---|
| **#343** | Audit writers: leave, planner, ingestion triggers, voucher export, settings, VU pause/resume | `engineers/leave-request.{service,controller}.ts`, `planner/se-planner.controller.ts`, the ingestion trigger routes, `exports/exports.controller.ts`, `settings/settings.service.ts`, `ticketing/vehicle-unavailability.{service,controller}.ts` + their e2e specs |
| **#347** | Report freshness stamps + auto-escalations cube (absorbs **#333**) | `reports/reports.service.ts`, `api/reports.ts`, `ReportsPage.tsx`, `RootCauseAnalyticsPage.tsx`, `SystemEfficiencyPage.tsx`, `ZmScorecardPage.tsx` + the four report e2e specs |
| **#353** | Inventory ledger closure: dispute restore, recovery receipt, ZM dispute view | `inventory/shadow-use.{service,controller}.ts`, `ticketing/recovery.service.ts`, `inventory/warehouse-stock.service.ts`, `api/shadowUse.ts`, the ZM disputes surface |
| **#355** | Cross-zone page completion: flag from ticket, re-escalate, modal, deferred resurfacing, history | `cross-zone/*.{service,controller,dtos}.ts`, `business-sweep-scheduler.service.ts` (`crossZoneTick` only), `CrossZonePage.tsx`, `api/crossZone.ts`, `pages/tickets/TicketDetailDrawer.tsx` |
| **#356** | Intra-day queue hygiene: bounded reads, refresh, labels, dead routes (absorbs **#331**) | `intraday/intraday-insertion.{service,controller}.ts`, `scheduling/same-day-update.service.ts`, `stranded-work-escalation.service.ts`, `scheduling/intraday-updates.controller.ts`, `api/intradayInsertions.ts`, `api/intradayUpdates.ts`, `IntradayQueuePage.tsx`, `api/schedules.ts`, `notifications/notification.service.ts` |
| **#360** | SE poll contract: paginated tickets, VU-deferred visibility, readable day-plan notices | `me-tickets/me-tickets.controller.ts` + query service, `scheduling/day-plan-notifier.ts`, `scheduling/day-plan-notification-outbox.ts`, `packages/shared/src/index.ts` |

**Why these six and not more.** Every remaining slice with satisfied dependencies is in this list or
conflicts with something in it:

- **#337** (push/FCM) shares `notification.service.ts` with **#356** → next round. It also needs FCM
  credentials, which are external; the seam builds and is testable without them, live delivery is not.
- **#357** (verification integrity) shares `reports.service.ts:545-556` with **#347** and needs
  `prisma/schema.prisma` → next round.
- **#349** (Integration Health page) shares the integration-health backend with **#343**'s trigger
  audits, and `api/snapshots.ts` with **#351** → next round.
- **#351** (dashboard fidelity) shares `api/snapshots.ts` with **#349** → next round.
- **#366** shares `packages/shared` with **#360** and `schema.prisma` with **#357**, *and* carries a
  design stop → not before an operator decision.

### How to launch Round 2

1. Recreate `.scratch/locks/backend-test.sh` from `docs/agents/parallel-execution.md` §3 and
   `chmod +x` it. Verify it round-trips: `.scratch/locks/backend-test.sh echo ok`.
2. Copy `docs/agents/parallel-agent-brief.md` to `.scratch/PARALLEL-BRIEF.md` and refresh its
   in-flight specifics (dates, which slices are concurrent).
3. Launch the six agents **in one message** so they run concurrently. Each prompt is short:

   > Read `/c/fsm-platform-backup/.scratch/PARALLEL-BRIEF.md` FIRST — project rules, concurrency rules
   > (no state-mutating git; backend tests only through the lock script), gotchas. Then implement
   > **issue #N — <title>**. Your brief: `docs/module-gaps/IMPLEMENTATION-PLAN.md` §4 slice N, plus
   > `.scratch/fsm-platform-v1/issues/N-*.md`. **Files you own — do not edit anything else:** <list>.
   > <one or two sentences on the slice's real point, and anything the plan gets wrong about it.>
   > Work red-first. Backend specs via
   > `/c/fsm-platform-backup/.scratch/locks/backend-test.sh npx vitest run test/...`; admin tests
   > directly.

   Give each agent the *reason* the slice exists, not just its file list — the reports that came back
   best were the ones whose prompt said what the defect actually costs an operator.
4. As each reports: check its paths with `git status --porcelain -- <paths>`, read the diff for hunks
   that are not that slice's, then commit by explicit path. Do not batch several slices into one
   commit.
5. When all six are in: run the full backend suite once with nothing else running, then the admin
   suite. Then write the INDEX P12 rows, the session-log line and the SYSTEM-STATE update — **the
   orchestrator owns those three files, never the agents.**

### Round 3, once Round 2 lands

**#337** (after #356 frees `notification.service.ts`), **#357** (after #347 frees `reports.service.ts`;
it owns `schema.prisma` that round), **#349** (after #343), then **#351** (after #349 frees
`api/snapshots.ts`). Those four are mutually disjoint apart from that ordering.

### Round 4, dependency-gated

**#358** needs #357 · **#361** needs #337 · **#363** needs #343 · **#364** needs #347 ·
**#365** needs #346 (satisfied) **plus a design stop** · **#366** needs #352 (satisfied) **plus a
design stop**.

### Two things Round 2 should fold in

Small debts the last round left because the file had no owner that round. Give each to the agent that
owns the file:

- **#355** — fold `direction` into `CrossZoneRow` in `api/crossZone.ts` (`CrossZonePage` declares a
  local intersection type meanwhile and says why).
- **#351** — lift #348's new snapshot fields (`overdue`, `silenceMinutes`, `expectedCadenceMinutes`,
  `overdueAfterMinutes`, `schedulerPaused`) out of `SnapshotBanner`'s local declaration into
  `api/snapshots.ts`. **#349** needs the same for `stale`/`staleAfterMinutes`/`schedulerEnabled` in
  `api/integrationHealth.ts`.

---

## Standing instructions from the user

Quoted, not paraphrased:

- **"Do NOT parallelize blindly by wave number. Use BOTH: the explicit dependency graph … and actual
  file ownership/overlap in the repository"**; *"uncertain ownership → treat as conflicting and
  serialize"*; *"If the current environment cannot safely isolate concurrent work, reduce concurrency
  rather than risking the repository."*
- **"The objective is maximum safe parallelism, not maximum simultaneous agents."**
- **"dont launch new issues , after these are done, then wait"** — this governed the *previous* round
  only, and was honoured; it is why Round 2 is planned but unstarted. The operator then asked for a
  handoff so the next session "knows what to build in parallel" and confirmed that **the next session
  should launch Round 2 on its first message**. A one-word "go" is the go-ahead — do not ask again,
  and do not summarise this file back at them. Verify the six file lists against the tree as you
  launch (the plan has been wrong about paths before), but do not treat a stale path as a reason to
  stop: correct it and carry on.
- **"continue and use /autohandoff on"** — the loop is armed.
- **"use option 3, then finish 336 and continue"** — the Platinum fixture is a scoped, expiring tier
  override (#157), never a re-tiered company.
- **"option 1"** — on a migration: hand-write it and rely on the suite, flagging that the drift gate
  was not run. **Standing answer for any migration in this run** (#338 and #348 both used it).
- **"commit it and start 338"** — commits are wanted per slice, **explicit paths only**.
- From the plan session, still live: *"Analyze the `docs/module-gaps/` results against the **current
  codebase** … verify every important finding against the current code before creating work. Do not
  blindly implement the report."*
- Treat the AFK policy in `CLAUDE.md` as live: stop only for architecture / business-rule conflict /
  backlog-ownership / external-access / security.
- **Handoffs live in `docs/audits/handoffs/HANDOFF-ACTIVE.md`.** There is only ever one.

## State of the tree

- **Everything is committed**; `git status` shows only four untracked files, none of them this work's:
  `.scratch-backend-run.json`, `apps/backend/_wh_evidence.mjs`, `audit/analysis-results.xlsx`,
  `docs/SUMMARYReport11thAug.xlsx`.
- **`.scratch/` is partly gitignored.** `.scratch/fsm-platform-v1/` is tracked; **`.scratch/locks/`
  and `.scratch/PARALLEL-BRIEF.md` are not** — recreate the mutex from
  `docs/agents/parallel-execution.md` §3 and the brief from §4.
- Raw logs from the last verification: `.scratch/backend-suite-parallel.log`.
- **Half-done / stubbed:** nothing.

## Decisions taken that are not recoverable from the diff

Each slice's `docs/progress/` report owns its own. The cross-cutting ones:

- **Acting is finished as a chain and is now load-bearing.** #339 gates the `X-Acting-As-Zone` header
  once per request (a CSM only when the cascade names them; an OH anywhere; an unknown or non-numeric
  zone is a 400, never a silent pan-India read). #340 makes every write attributed. #341 makes acting
  actually *narrow* a manager write door. Two sweeps enforce it: `test/acting-scope-route-sweep.spec.ts`
  fails any manager write route that hand-builds a scope, and `apps/admin/test/acting-header-builder.test.ts`
  fails any admin client that does not authenticate through `authHeaders()`.
- **Every post-commit notification is a durable outbox row enqueued inside the producing
  transaction** (#338). New producers use `queueNotification` inside their own transaction; there is
  one pattern to copy and `docs/progress/338-durable-notification-outbox.md` explains the two row
  shapes and why a port is not flattened into a resolved notice.
- **A pin's allowlist is a list of reasons, checked from both ends.** #340/#341/#342's sweeps each
  assert that every allowlist entry still names a real, still-offending target — a stale entry is a
  suppression nobody is reading, and it silently covers the next thing that takes the same name.

## Known follow-ups (none blocking)

- **`audit_logs` has no index on `created_at`** — the ledger sort is on every query, the actor filter
  only on some. When someone owns `schema.prisma`: `(created_at DESC, id DESC)` first, then
  `(actor_id, created_at)`, `(action, created_at)`, and an expression index on
  `(lower(entity_type), entity_id)`. Not a correctness or latency problem at `LIMIT <= 200` today.
- **`entity_type` is written three ways** — `'ticket'` (16 sites), `'tickets'` (15), `'TICKET'` (1).
  Both audit readers now normalise; **normalising the 32 writers needs a backfill decision on an
  append-only table and was deliberately not taken.**
- **#362's residual:** revoking refresh tokens ends the session's ability to renew, but an
  **already-minted access token stays valid until it expires**. Closing that needs a token-version
  claim in `AuthGuard`.
- **#345 has no post-commit drain** — `PlantDeactivationModule` owns no `DayPlanNotifier`, so the
  2-minute outbox sweep delivers. Latency, not durability.
- **`api/vouchers.ts`** still types `apiMarkVouchersPaid` without `reason`/`failed[]` and
  `VoucherActivityCheck` without `warnings` (#359 did not own the file).
- **A pre-existing drawer crash, found and deliberately not fixed:** `TicketDetailDrawer.tsx:537`
  reads `attempts.attempts.length` and throws on another shape (#244, present at HEAD). **#355 owns
  that file in Round 2** and is the natural place to fix it.
- **`docs/ui/desktop/approved-designs/README.md`** should record the audit-ledger page as an
  approved-design gap (#342's ask).

## Dead ends — do not retry

- **NEVER run two backend suites at once** — `docs/agents/parallel-execution.md` §1. Check for a live
  `node` process first.
- **Do not edit `src/` while a suite runs.** Vitest transforms each test file as it loads it, so later
  files pick up half-finished edits and the run means nothing.
- **Do not `git add` a directory.** `git add apps/backend/test/` once staged ~60 files from another
  session. Stage individual paths, always.
- **Converting every caller of a function does not exercise a unit spec of the function itself.** #339
  changed `resolveManagerScope`'s signature, converted both decorators, and left `manager-scope.spec.ts`
  on the old shape — five tests throwing, invisible to every acting e2e. Grep `test/` for the
  **symbol** when you change a signature.
- **Do not defer an enqueue (or a gate) because "there is no transaction to enqueue into".** That
  reading was wrong three times in #338 — the mutations were local and a local transaction was there.
- **Do not hand an interfering Prisma proxy only to the service under test when the write goes through
  `withAudit`** — it opens its transaction on the **`AuditService`'s own** client.
- **Do not reuse `test/fixtures/outbox-crash-injection.ts` for a day-plan producer.**
  `failingNotifyEnqueue` deliberately lets day-plan rows through (#338 needed exactly that), so it
  injects nothing. #345 used a local proxy instead of widening the shared fixture.
- **Do not regenerate `prisma/drift-baseline.txt`** (99 lines, must not grow).

## Gotchas

- **`tsc --noEmit` does not cover `apps/backend/test/`**, and `tsconfig.test.json` has ~50
  **pre-existing** errors — it is not a green gate. Grep it for your own error class.
- **The Bash tool truncates a long heredoc**; write files over ~120 lines with the Write tool.
- **`print()` of non-ASCII fails on this box** (cp1252 stdout) *after* the write already happened —
  check the file before redoing an edit; a blind retry can double-apply.
- **A backgrounded command piped through `tail` writes nothing until it exits** and its task-output
  file stays empty. Redirect to a log file directly (`> log 2>&1`).
- **The generated Prisma client is TypeScript** (`src/generated/prisma/client.ts`), so a throwaway
  `node` script cannot require it. Query the test DB from a spec, not a script.
- **`apps/backend/src/generated/` is gitignored** — run `npx prisma generate` after a schema edit.
- **The schema is at `apps/backend/prisma/schema.prisma`**, not `prisma/schema.prisma`.
- **The admin nav is `apps/admin/src/components/shell/nav.ts`** — `src/lib/nav.ts` does not exist,
  whatever plan §4 says.
- **e2e fixture logins:** `zm.north@fsm.test`, `csm@fsm.test`, `ops.head@fsm.test`, `wm@fsm.test`,
  `se.north@fsm.test`, password `correct-password`. There is no `oh@fsm.test`.
- **`OPEN` is TROUBLESHOOT-only** (`tickets_work_type_status`, #309) — invalid fixture states cost
  #350 a red cycle.
- Known-flaky, neither broken: `dispatch-crashed-zone-recovery`, `global-guard-validation` (#184).
  Under parallel load several admin files time out and pass alone — re-run before believing one.

## Open questions / HITL

- **Plan §7 holds ten operator decisions**, each with the default its slice assumes. Live for the next
  rounds: **INV-G2** (#353 — whether a recovery receipt increments zone warehouse stock or only writes
  a transaction row; default: transaction row only), **VCH-08** (un-pay — not built), **AC-03**
  (reactivation restores nothing — kept), **E-15/E-17**, **INTRA-G4**, **AA-06** (not built).
- **#365 and #366 carry design stops** and should not start without one.
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
