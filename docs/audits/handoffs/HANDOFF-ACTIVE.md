# HANDOFF — #340 acting attribution — 2026-09-03

Auto-handoff: **ARMED** (note "wave 1 - #339 acting-scope gate"). Refreshed after #339 closed and
#340's code went green. Disarm with `/autohandoff off` when the run finishes, and rename this file
`HANDOFF-<issue>-<date>.md` in place — that folder is the audit trail, nothing moves to `docs/archive/`.

Status: active
Issue: `.scratch/fsm-platform-v1/issues/340-acting-attribution-null-sites-backup-report.md`
Branch: `feat/autoplant-integration` · this run's commits: `abb0f0f` `1f20620` `fa11c55` `35bca9e`
`543e986` `d080433` `806bb7a` `deca11d` `ea155b3` `0001f9b` `aa0eaba` `a1270ad`

## The job

Build the module-gaps completion backlog — **31 slices, issues #336–#366** — filed 2026-09-03 from the
14-module gap survey. The brief is **`docs/module-gaps/IMPLEMENTATION-PLAN.md`**: §1 lists 21 survey
findings corrected or refuted (**do not build against the survey brief where §1 disagrees with it**),
§3 the wave/dependency table, §4 the per-slice detail, §7 the operator decisions and the default each
slice assumes. `INDEX.md` section **P12** carries the same table with links.

One slice at a time, red-first (`/tdd`), each with a `docs/progress/<issue>.md` report, an INDEX row
update and a session-log line.

**#336, #338 and #339 are DONE and reported. #340 is code complete and green in its neighbourhood**;
what remains is the full-suite result and the bookkeeping.

## Next step

**Finish #340, in this order:**

1. **Read `.scratch/backend-suite-340.log`** (repo root) — one clean `npm test` from `apps/backend`,
   started 13:07 after every #339 and #340 edit was in the tree. It is the verification for **both**
   slices. Expect ~23 min and possibly one `#184` worker-crash retry. If it is missing or was cut
   off, re-run it — **and see the hard rule below about running only one suite at a time.**
2. **Write `docs/progress/340-acting-attribution.md`.** #339's
   (`docs/progress/339-acting-scope-gate.md`) is the shape to copy; the INDEX session-log line for
   #340 already carries the reasoning, including the second column overload the issue did not name.
3. **Tick the four ACs** in the issue file and set `Status: done …`.
4. **Fill in the full-suite number** in `docs/progress/339-acting-scope-gate.md` (its "Tests,
   verbatim" section currently points at the INDEX session log rather than naming a figure) and in
   the #339/#340 INDEX rows.
5. **Commit #340** — explicit paths only, never `git add -A`, and never the six files listed under
   "State of the tree".
6. Then continue the wave: **#341** (acting scope narrows every manager write door, ~60 sites / 20
   controllers), which depends on #339 and #340 and is now unblocked.

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

- **Committed through `a1270ad`**, explicit paths only.
- **#340's code and tests are UNCOMMITTED** (step 5 above). The files it touches:
  - *Seam*: `src/common/request-actor.ts` (+`zoneId`).
  - *Controllers, the eleven doors*: `cross-zone/cross-zone.controller.ts`,
    `devices/devices.controller.ts`, `engineers/engineers.controller.ts`,
    `engineers/leave-request.controller.ts`, `intraday/intraday-insertion.controller.ts`,
    `scheduling/intraday-updates.controller.ts`, `ticketing/tickets.controller.ts`.
  - *Actor types + audit writes*: `scheduling/override.service.ts` (`ActorContext`),
    `devices/device.service.ts`, `engineers/leave-request.service.ts`,
    `engineers/se-availability.service.ts`, `ticketing/auto-recovery.service.ts`,
    `cross-zone/cross-zone-escalation.service.ts`, `ticketing/vehicle-unavailability.service.ts`,
    `scheduling/bulk-unassign.service.ts`, `roles/role-backup.service.ts`.
  - *Doors that re-copied the actor and lost `actingZone`*: `scheduling/batches.controller.ts`,
    `ticketing/vehicle-unavailability.controller.ts`.
  - *Tests*: new `test/acting-attribution-pin.spec.ts`, `test/acting-attribution.e2e-spec.ts`;
    extended `csm-backup-report`, `bulk-unassign-history`; updated queries in
    `bulk-unassign-execute`, `bulk-unassign`; `zoneId` added to ~20 `RequestActor` fixtures across
    `test/` (mechanical — the field is now required).
- **SIX FILES ARE DELIBERATELY UNCOMMITTED** because their diffs interleave the parallel
  scheduler-forensics run's work with mine in the same hunks. **Do not stage them, do not revert
  them — #339's tests do not pass without the first four:**
  - `apps/admin/src/components/shell/TopBar.tsx` — mine is 3 lines in `enterActing`.
  - `apps/admin/src/pages/settings/SettingsPage.tsx` — mine is one `GROUPS` entry.
  - `apps/admin/test/acting-banner.test.tsx` — mine are the three `#339` assertions + the `calls[]` stub.
  - `apps/backend/test/dashboard-acting-scope.e2e-spec.ts` — untracked, the other run's file; mine is
    the `zmOutWindowId` fixture.
  - `.scratch/fsm-platform-v1/INDEX.md` and `docs/SYSTEM-STATE-2026-07.md` — same reason. #338's and
    #339's content is written and correct; #340's P12 row and both session-log lines are written too.
- **Uncommitted and NOT this run's: ~246 further paths** under `apps/` and `packages/` — the
  scheduler-forensics run's #297–#334.
- **Tests, verbatim, after the last code change:**
  - **#340's own**: `acting-attribution-pin` 2 + `acting-attribution` 3 + `csm-backup-report` 4 +
    `bulk-unassign-history` 1 → **4 files, 10 passed** (the pin was red first: 7 controller files).
  - **Neighbourhood**: cross-zone / auto-recovery / leave-request / bulk-unassign / role-backup /
    request-actor-attribution → 13 files; intraday / batch-override / devices / vehicle-unavailability
    / se-availability / engineers / tickets → 17 files; acting-context / dashboard-acting-scope /
    assign-batch-acting-scope / audit-trail / schedules-route-conflicts / removal-reason /
    terminal-status / engineer-admin / install-lifecycle / recovery-lifecycle / voucher → 11 files.
    **All green.**
  - `npx tsc --noEmit` (backend) → exit 0. `tsc -p tsconfig.test.json` has ~50 **pre-existing**
    errors unrelated to this work; the `RequestActor` ones this slice introduced are all fixed.
  - **Full backend suite: RUNNING** into `.scratch/backend-suite-340.log`. See step 1.
- **Half-done / stubbed:** nothing.

## Done so far

- **#336 — DONE** (`abb0f0f`). Report: `docs/progress/336-dev-seed-fixtures.md`.
- **#338 — DONE** (eight commits + `aa0eaba`). Report: `docs/progress/338-durable-notification-outbox.md`.
- **#339 — DONE** (`a1270ad`). Report: `docs/progress/339-acting-scope-gate.md`; all 7 ACs ticked.
- **#340 — code complete**, green in its neighbourhood, uncommitted.

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

**#340** — all four are **built and tested**; none ticked yet (step 3). AC1 by
`acting-attribution-pin.spec.ts`; AC2 by `acting-attribution.e2e-spec.ts`; AC3 by
`bulk-unassign-history` (the write) and `csm-backup-report` (the read); AC4 by `csm-backup-report`.
**#336, #338, #339** — none; all closed and reported.
Every other slice #337, #341–#366 is unstarted.

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
