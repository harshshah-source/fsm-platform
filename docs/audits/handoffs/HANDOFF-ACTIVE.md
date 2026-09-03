# HANDOFF — #341 acting scope on write doors — 2026-09-03

Auto-handoff: **ARMED** (note "wave 1 - #339 acting-scope gate"). Refreshed after #339 and #340
both closed and were verified against one clean full-suite run. Disarm with `/autohandoff off` when the run finishes, and rename this file
`HANDOFF-<issue>-<date>.md` in place — that folder is the audit trail, nothing moves to `docs/archive/`.

Status: active
Issue: `.scratch/fsm-platform-v1/issues/341-acting-scope-on-write-doors.md`
Branch: `feat/autoplant-integration` · this run's commits: `abb0f0f` `1f20620` `fa11c55` `35bca9e`
`543e986` `d080433` `806bb7a` `deca11d` `ea155b3` `0001f9b` `aa0eaba` `a1270ad` `f686e23`

## The job

Build the module-gaps completion backlog — **31 slices, issues #336–#366** — filed 2026-09-03 from the
14-module gap survey. The brief is **`docs/module-gaps/IMPLEMENTATION-PLAN.md`**: §1 lists 21 survey
findings corrected or refuted (**do not build against the survey brief where §1 disagrees with it**),
§3 the wave/dependency table, §4 the per-slice detail, §7 the operator decisions and the default each
slice assumes. `INDEX.md` section **P12** carries the same table with links.

One slice at a time, red-first (`/tdd`), each with a `docs/progress/<issue>.md` report, an INDEX row
update and a session-log line.

**#336, #338, #339 and #340 are DONE, verified against a clean full-suite run, and reported.** #341 is
unstarted and is the next slice.

## Next step

**Start #341 — acting scope narrows every manager write door.** Its two blockers (#339, #340) are
both closed, and `request.acting` is now the proven source both decorators read.

1. **The finding is already re-verified** — done 2026-09-03, written into the issue file under
   "Finding re-verified". The survey's "~60 across 20" is exact: **57 sites, 20 controllers**, worst
   first `tickets` 6 / `reports` 6 / `verification` 4 / `vehicle-unavailability` 4 / `install` 4 /
   `schedules` 4 / `intraday-updates` 4 / `se-planner` 4 / `devices` 4. Do not redo the count.
2. **AC1's contract test is designed and the design is in the issue file** — read "AC1's contract
   test — design decision" before writing anything. Short version: **do not drive 57 routes with a
   real zone-1 entity each**; enumerate the route map at runtime the way
   `global-guard-validation.e2e-spec.ts` already does, filter to manager write routes, and assert each
   handler injects `@CurrentScope()`/`@CurrentActor()` via Nest's `ROUTE_ARGS_METADATA`. That is what
   delivers "fails on any new unscoped route". Then prove the behaviour on a representative e2e set
   including the reproduced case. Write the sweep first — it is the slice's real risk.
3. **The narrowing rule already recorded on #239:** narrowing a write can only *reduce* reach. AC4
   (no behaviour change for ZM/WM/SE) is the other half of the same statement and is what stops the
   conversion from becoming a permissions change.
4. **AC3 is the admin half** — `dispatch-runs.ts`, `intradayInsertions.ts`, `intradayUpdates.ts`
   build bearer-only headers, so the acting header never reaches those routes at all. One
   `authHeaders()` builder, plus `apps/admin/test/acting-zone-scope.test.tsx`.
5. Report, ACs, INDEX row + session-log line, commit — explicit paths only, and never the files under
   "State of the tree".
6. **Close #239 into this slice when it lands.**

## Standing instructions from the user

Quoted, not paraphrased:

- **"continue and use /autohandoff on"** — the most recent instruction. The loop is armed.
- **"start implementation and use /autohandoff on"** — given *after* being shown that the tree carries
  ~246 uncommitted files from the parallel scheduler-forensics run and that suite runs therefore
  verify a mixture. The user reaffirmed. **That is their decision; the run proceeds on the dirty base.**
- **"leave that, start implemettation of our issues and use /autohandoff on"** — said after I asked
  whether taking over `HANDOFF-ACTIVE.md` from the other run was acceptable. Settled; do not reopen.
- **"use option 3, then finish 336 and continue"** — the Platinum fixture is a scoped, expiring tier
  override (#157), never a re-tiered company.
- **"option 1"** — on #338's migration: hand-write it and rely on the suite, flagging that the drift
  gate was not run. **Standing answer for any later migration in this run.**
- **"commit it and start 338"** — commits are wanted per slice, **explicit paths only**.
- From the plan session, still live: *"Analyze the `docs/module-gaps/` results against the **current
  codebase** … verify every important finding against the current code before creating work. Do not
  blindly implement the report."* — #340 is a live example: the issue named one column overload and
  the code had two.
- Treat the AFK policy in `CLAUDE.md` as live: keep going down the wave order, stop only for
  architecture / business-rule conflict / backlog-ownership / external-access / security.
- **Handoffs live in `docs/audits/handoffs/HANDOFF-ACTIVE.md`.** There is only ever one.

## State of the tree

- **This run's work is committed through `f686e23`**, explicit paths only, never `git add -A`.
- **TEN FILES ARE DELIBERATELY UNCOMMITTED** because their diffs interleave the parallel
  scheduler-forensics run's work with mine in the same hunks. Committing them would carry that run's
  code. **Do not stage them, and do not revert them — #339's and #340's tests do not pass without
  them:**
  - `apps/admin/src/components/shell/TopBar.tsx` — mine is 3 lines in `enterActing`.
  - `apps/admin/src/pages/settings/SettingsPage.tsx` — mine is one `GROUPS` entry.
  - `apps/admin/test/acting-banner.test.tsx` — mine are the three `#339` assertions + the `calls[]` stub.
  - `apps/backend/test/dashboard-acting-scope.e2e-spec.ts` — untracked, the other run's file; mine is
    the `zmOutWindowId` fixture.
  - `apps/backend/src/devices/device.service.ts` (theirs: #308), `engineers/engineers.controller.ts`
    (#267), `intraday/intraday-insertion.controller.ts` and `scheduling/intraday-updates.controller.ts`
    (#310), `scheduling/batches.controller.ts`, `scheduling/override.service.ts`,
    `ticketing/auto-recovery.service.ts` — each carries one to seven lines of **#340** (the
    `@CurrentActor()` conversion and the `actingZone` stamp) inside their hunks.
  - `apps/backend/test/engineer-admin.e2e-spec.ts`, `test/recovery-compliance-stalled.e2e-spec.ts`,
    `test/terminal-status-no-reclose.e2e-spec.ts` — same.
  - `.scratch/fsm-platform-v1/INDEX.md` and `docs/SYSTEM-STATE-2026-07.md` — same reason. Their
    #338/#339/#340 content is written and correct, including both session-log lines, the P12 rows,
    and SYSTEM-STATE §3j's acting paragraph rewritten in place.
- **`f686e23` is therefore a WIP commit**: on its own the tree it describes does not compile, because
  seven of #340's source files are in the list above. That is the same trade `a1270ad` made and is
  deliberate — see the commit message, which names every one.
- **Uncommitted and NOT this run's: ~246 further paths** under `apps/` and `packages/` — the
  scheduler-forensics run's #297–#334.
- **Verification, verbatim:**
  - **Full backend suite, one clean run after every #339/#340 edit** (`.scratch/backend-suite-340.log`,
    818 s): **463 files / 2494 tests — 458 files passed, 3 skipped, 2 failed.** Both failures were
    this run's own and both are fixed in **test files only, no source change**, and re-run green:
    `manager-scope.spec.ts` (still on #339's pre-guard signature) and `shared-auth-se-fixture-guard`
    (flagging #336's rolled-back `engineerMaster.deleteMany`).
  - **Full admin suite: 120 files / 838 tests, all passing** (the 1 reported error is the pre-existing
    #335 drawer crash). #340 changed no admin code.
  - `npx tsc --noEmit` (backend) and `npx tsc -b` (admin) → exit 0. `tsc -p tsconfig.test.json` has
    ~50 **pre-existing** errors unrelated to this work and is **not** a green gate — grep it for the
    error class you care about rather than reading the list.
- **Half-done / stubbed:** nothing.

## Done so far

- **#336 — DONE** (`abb0f0f`). Report: `docs/progress/336-dev-seed-fixtures.md`.
- **#338 — DONE** (eight commits + `aa0eaba`). Report: `docs/progress/338-durable-notification-outbox.md`.
- **#339 — DONE** (`a1270ad`, bookkeeping in `f686e23`). Report: `docs/progress/339-acting-scope-gate.md`;
  all 7 ACs ticked.
- **#340 — DONE** (`f686e23`). Report: `docs/progress/340-acting-attribution.md`; all 4 ACs ticked,
  with AC1's wording deliberately narrowed and the reason recorded in the issue file.

## Decisions taken (not recoverable from the diff)

**#340**

- **`RequestActor` gains `zoneId`, and it is the claims value verbatim.** Several module actor types
  (`LeaveActor`, `CrossZoneActor`, `VuActor`, `AvailabilityActor`) require the caller's home zone, so
  without it a door would have to inject *both* decorators and re-copy fields — which is exactly how
  the `actedAsRole: null` literal spread to eleven doors. **It is not narrowed by acting**: whether a
  write door's scope should follow the acting zone is #341's question, and answering it inside an
  attribution fix would change permissions invisibly.
- **A second column overload was found that the issue does not name.**
  `vehicle-unavailability.service.ts` wrote `actor.zoneId` — the caller's *home* zone — into
  `audit_logs.acting_zone`. Bulk unassign wrote its *target* zone. Both put non-acting rows into the
  CSM-backup-share denominator; both are fixed. Look for the pattern, not the site.
- **The target zone moves to `entity_id`, not to a new metadata key.** `entity_type = 'zones'` /
  `entity_id` already carried it on **every row ever written**, so `history()` is correct on pre-fix
  rows and **nothing is backfilled**. A new metadata key would have needed a migration or a dual read.
- **Both halves of the report fix are kept.** The producer fixes correct today's rows; the
  `actedAsRole IS NOT NULL` filter is what stops the next overloader corrupting the number. Either
  alone makes this month right; only both make the column mean one thing.
- **The five services behind those doors now stamp `acting_zone` too.** They carried `acted_as_role`
  and dropped the zone — attribution the pair's one reader (the backup-share report) could never see.
- **AC1 is pinned over comment-stripped source, and names its two exceptions.** `acting-context.ts`
  and `acting-context.guard.ts` build the *non-acting* context, where `actedAsRole: null` is the
  meaning. Naming them beats a loose pattern-exclusion a third site could hide behind. Stripping
  comments matters because several of the fixed files now discuss the literal in prose.

**#339** — see `docs/progress/339-acting-scope-gate.md`; it owns the detail.

**#338** — see `docs/progress/338-durable-notification-outbox.md`; two row shapes, the
`OutboxDeliverers` bag, and #354's shrunk scope (CZ-01 only).

## Dead ends — do not retry

- **Converting every caller of a function does not exercise a unit spec of the function itself.**
  #339 changed `resolveManagerScope`'s signature, converted both decorators, and left
  `manager-scope.spec.ts` calling the old shape — five tests throwing, invisible to every acting e2e.
  When you change a signature, grep `test/` for the **symbol**, not just for its call sites.
- **NEVER run two backend suites at once.** There is one `fsm_test` database and `globalSetup`
  migrates and re-seeds it, so a second run pulls the ground out from under the first: 46 files
  "failed" on `401 Unauthorized` at login and none of it was real. Both runs were discarded. Check
  for a live `node` process before starting one.
- **Do not edit `src/` while a suite runs.** Vitest transforms each test file as it loads it, so
  later files pick up half-finished edits and the run means nothing.
- **Do not `git add` a directory.** `git add apps/backend/test/` staged ~60 of the other run's files.
  Stage individual paths.
- **Do not commit the six mixed files** listed under "State of the tree" while the other run's tree
  is uncommitted.
- **Do not defer an enqueue (or a gate) because "there is no transaction to enqueue into".** Wrong
  three times in #338.
- **Do not hand an interfering Prisma proxy only to the service under test when the write goes through
  `withAudit`** — it opens its transaction on the **`AuditService`'s own** client.
- **Do not regenerate `prisma/drift-baseline.txt`** (99 lines, must not grow).
- Everything under **Dead ends**/**Gotchas** in `HANDOFF-scheduler-forensics-wave3-2026-09-03.md`
  still applies.

## Gotchas

- **`tsc --noEmit` does not cover `test/`**, and `tsconfig.test.json` has ~50 pre-existing errors, so
  it is not a green gate — a spec's type error surfaces only from the suite. Grep the specific error
  class you care about instead of reading the whole list.
- **The Bash tool truncates a long heredoc**, and the shell then fails with `unexpected EOF while
  looking for matching`. Write files over ~120 lines with the Write tool, or split the script.
- **`print()` of non-ASCII fails on this box** (`cp1252` stdout) *after* the file write has already
  happened. Check the file before redoing an edit; a blind retry can double-apply.
- **A backgrounded command piped through `tail` writes nothing until it exits**, and its task-output
  file stays empty. Redirect to a log file directly (`> log 2>&1`) rather than `| tee | tail`.
- **The e2e fixture logins are `zm.north@fsm.test`, `csm@fsm.test`, `ops.head@fsm.test`, `wm@fsm.test`,
  `se.north@fsm.test`** — there is no `oh@fsm.test`.
- **The generated Prisma client is TypeScript** (`src/generated/prisma/client.ts`), so a throwaway
  `node` script cannot require it. Query the test DB from a spec, not a script.
- **The drift gate cannot run on this box** — the local Postgres role has no `CREATE DATABASE`.
- **`apps/backend/src/generated/` is gitignored** — run `npx prisma generate` after a schema edit.
- **The admin suite reports 1 error with everything green** until #335 lands.
- Two backend files are known-flaky and neither is broken: `dispatch-crashed-zone-recovery`,
  `global-guard-validation` (#184).

## Remaining acceptance criteria

**#341** — all four are unstarted. AC1 (route-enumeration contract test) is the slice's real content;
AC2/AC4 are the "narrowing only reduces reach" guarantee; AC3 is the admin `authHeaders()` builder.
**#336, #338, #339, #340** — none; all four closed and reported.
Every other slice #337, #342–#366 is unstarted.

## Open questions / HITL

- **The request-scoped acting guard** #339 assumes was raised to the user and is unanswered. Built on
  plan §7's default (recommended; no new framework). `common/guards/acting-context.guard.ts` is the
  file to change if the answer differs.
- **AA-06** (auto-open a ZM window from a >24 h login gap) — **not built**, per the issue's recorded
  default.
- **Plan §7 holds ten operator decisions**, each with the default its slice assumes. None blocks #341.
- **#337 needs FCM credentials** (external provisioning).
- **The dev database has not been seeded.** `SEED_DEV_WALK_FIXTURES=true npm run seed:dev-fixtures` is
  an operator action; until it runs, the 17 blocked survey findings stay blocked.

## Suggested skills

- **`/tdd`** — red-first per slice; each slice's Verification line in plan §4 is the test to write first.
- **`/code-review`** — per finished slice, before the bookkeeping.
- **`/diagnose`** — when a cited `file:line` no longer matches behaviour.
