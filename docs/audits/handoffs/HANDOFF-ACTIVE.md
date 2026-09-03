# HANDOFF — module-gaps wave 1: #338 done, #337/#339 next — 2026-09-03

Auto-handoff: **ARMED** (note "#336 then wave 1 - module-gaps completion").
Disarm with `/autohandoff off` when the run finishes, and rename this file
`HANDOFF-<issue>-<date>.md` in place — that folder is the audit trail, nothing moves to `docs/archive/`.

Status: active
Branch: `feat/autoplant-integration` · this run's commits: `abb0f0f` `1f20620` `fa11c55` `35bca9e`
`543e986` `d080433` `806bb7a` `deca11d` `ea155b3` `0001f9b`

## The job

Build the module-gaps completion backlog — **31 slices, issues #336–#366** — filed 2026-09-03 from the
14-module gap survey. The brief is **`docs/module-gaps/IMPLEMENTATION-PLAN.md`**: §1 lists 21 survey
findings that were corrected or refuted (**do not build against the survey brief where §1 disagrees
with it**), §3 is the wave/dependency table, §4 the per-slice detail, §7 the operator decisions and the
default each slice assumes. `INDEX.md` section **P12** carries the same table with links.

One slice at a time, red-first (`/tdd`), each with a `docs/progress/<issue>.md` report, an INDEX row
update and a session-log line.

## Next step

**#336 and #338 are DONE.** Wave 1's remaining slices are **#337, #339, #340** (then #341, #342 in
wave 2). Pick up at:

- **#339 — acting-scope gate, manager-unavailability windows, audited enter/exit.** No blocker; the
  request-scoped acting guard question was raised to the user and is unanswered, so **proceed on plan
  §7's default** (recorded there).
- **#340 — acting attribution** (11 `actedAsRole: null` sites, bulk-unassign column overload,
  backup-share report). Also unblocked. #341 needs both, so doing 339 → 340 in order keeps wave 2 open.
- **#337 — push delivery exit (FCM)** is buildable *except* its live-delivery test: credentials are
  external provisioning (HITL). The seam builds with the logging default bound. Take it if you want the
  notification thread finished end to end — #338 now guarantees the notice *reaches* `NotificationService`;
  #337 is what leaves the building.

## Standing instructions from the user

Quoted, not paraphrased:

- **"start implementation and use /autohandoff on"** — given *after* being shown that the tree carries
  246 uncommitted files from the parallel scheduler-forensics run and that suite runs therefore verify
  a mixture. The user reaffirmed. **That is their decision; the run proceeds on the dirty base.**
- **"leave that, start implemettation of our issues and use /autohandoff on"** — said after I asked
  whether taking over `HANDOFF-ACTIVE.md` from the other run was acceptable. It is settled; do not
  reopen it.
- **"use option 3, then finish 336 and continue"** — the Platinum fixture is a scoped, expiring tier
  override (#157), never a re-tiered company.
- **"option 1"** — on #338's migration: hand-write it and rely on the suite, flagging that the drift
  gate was not run. **Standing answer for any later migration in this run.**
- **"commit it and start 338"** — commits are wanted per slice, **explicit paths only**.
- From the plan session, still live: *"Analyze the `docs/module-gaps/` results against the **current
  codebase** … verify every important finding against the current code before creating work. Do not
  blindly implement the report."* This outlived planning — it is why §1 exists, why #336 was re-scoped,
  and why #338's cross-zone half turned out to be buildable after all (below).
- Treat the AFK policy in `CLAUDE.md` as live: keep going down the wave order, stop only for
  architecture / business-rule conflict / backlog-ownership / external-access / security.
- **Handoffs live in `docs/audits/handoffs/HANDOFF-ACTIVE.md`.** There is only ever one.

## State of the tree

- **This run's work is committed** through `0001f9b`, explicit paths only, never `git add -A`.
  (One near-miss: `git add apps/backend/test/` staged ~60 of the *other* run's files. Caught with
  `git status --porcelain` before committing and reset. **Stage individual files, never a directory.**)
- **Uncommitted and NOT this run's: ~246 paths under `apps/` and `packages/`** — the scheduler-forensics
  run's #297–#334. **Do not commit, revert or stash it.**
- **`.scratch/fsm-platform-v1/INDEX.md` and `docs/SYSTEM-STATE-2026-07.md` are deliberately
  UNCOMMITTED.** Both interleave this run's edits with the other run's in single hunks; committing
  either would carry their bookkeeping without their code. Content is correct; it rides along with
  their next commit.
- **Tests, verbatim, after the last code change** (`0001f9b`): cross-zone (escalation + controller)
  **2 files, 20 passed**; outbox/notification/sweep (`business-sweep-scheduler` ×4, outbox ×4,
  intraday ×2, `notifier-adoption-wiring`, `notifications-controller`, `notification-service`,
  `notification-seam-assertion`) **14 files, 71 passed**; recovery **9 files, 34 passed**; install
  **6 files, 39 passed**; bulk-unassign **4 files, 24 passed**; intraday **5 files, 30 passed**.
  `npx tsc --noEmit` → **exit 0**. A **full backend suite** run was started in the background after
  `0001f9b`; if its result is not in this session's transcript, re-run `npm test` in `apps/backend`
  before trusting a "whole suite green" claim.
- **Half-done / stubbed:** nothing.

## Done so far

- **#336 — DONE** (`abb0f0f`). Report: `docs/progress/336-dev-seed-fixtures.md`.
- **#338 — DONE** (`1f20620` infrastructure, then `35bca9e` `543e986` `d080433` `806bb7a` `deca11d`
  `ea155b3` `0001f9b`). Report: **`docs/progress/338-durable-notification-outbox.md`** — it owns the
  detail; the commit messages own the per-part reasoning. Do not re-read the diffs.

## Decisions taken (not recoverable from the diff)

Everything below is stated in the #338 report; these are the three a *future* slice can get wrong.

- **The outbox now has two row shapes, and new producers must pick the right one.** A site that calls
  `NotificationService` directly enqueues a resolved `NotifyInput` (`queueNotification`). A site that
  goes through a **port** (`InstallNotifier`, `RecoveryNotifier`, `DayPlanNotifier`) enqueues the
  *event* and the drain hands it to that port. Do not flatten a port into a resolved notice: those
  seams have implementations, DI bindings and specs, and `RecoveryNotifier.escalatedToOh` notifies
  nobody at all, so it has no `NotifyInput` to flatten to.
- **Any new deliverer goes in the `OutboxDeliverers` bag, and the sweep must carry it.**
  `business-sweep-scheduler` is the only drain that sees every producer's rows. Part 1's defect was a
  `useFactory` one positional argument short of the notify deliverer — the app could retry day-plan
  rows and nothing else. `business-sweep-scheduler-wiring.e2e-spec.ts` now boots the real module and
  runs the real tick; keep that test honest when adding a deliverer.
- **#354's scope shrank, and the plan text is now stale on this point.** #338 gave every cross-zone
  door its own transaction, which closes **CZ-02**. What #354 still owns is **CZ-01**: `approve` calls
  `assignTicket` in its own transaction *before* updating the escalation, so an approval can still
  leave an assigned ticket beside an un-updated escalation. The code says so at the site
  (`cross-zone-escalation.service.ts`, `approve`). Read plan §4's #338/#354 entries with this
  correction in hand.

## Dead ends — do not retry

- **Do not defer an enqueue because "there is no transaction to enqueue into".** That was the recorded
  reading for three producers and it was wrong every time — their mutations are local, and opening a
  local transaction is what the gap was asking for. Check whether the mutation is local before
  concluding a slice is blocked.
- **Do not hand an interfering Prisma proxy only to the service under test when the write goes through
  `withAudit`** — that opens its transaction on the **`AuditService`'s own** client. Build both on one
  client. (#325's spec records the same trap; `recovery-receipt-unable.e2e-spec.ts` now names it too.)
- **Do not extend `runDevSeed` or `seedAuthFixtureUsers` with fixture operational rows** (#336).
- **Do not guard an idempotent seeder on "rows that have no child yet"** (#336).
- **Do not commit `.scratch/fsm-platform-v1/INDEX.md` or `docs/SYSTEM-STATE-2026-07.md`** while the
  other run's tree is uncommitted.
- **Do not regenerate `prisma/drift-baseline.txt`** (99 lines, must not grow).
- Everything under **Dead ends** and **Gotchas** in `HANDOFF-scheduler-forensics-wave3-2026-09-03.md`
  still applies to this repo.

## Gotchas

- **The Bash tool truncates a long heredoc**, and the shell then fails with `unexpected EOF while
  looking for matching`. Write files over ~120 lines with the Write tool, or split the script.
- **`print()` of non-ASCII fails on this box** (`cp1252` stdout) *after* the file write has already
  happened — the traceback looks like the write failed when it did not. Check the file before redoing
  the edit; a blind retry can double-apply.
- **The drift gate cannot run on this box** — the local Postgres role has no `CREATE DATABASE`. Standing
  answer: hand-write the migration to match the schema edit exactly, rely on the suite, say so in the
  report. `prisma migrate deploy` runs on test boot.
- **`apps/backend/src/generated/` is gitignored** — run `npx prisma generate` after a schema edit.
- **The Bash tool's cwd persists across calls** (and a backgrounded `cd` does not affect it). Use
  absolute paths after any `cd`.
- **`tsc --noEmit` does not cover `test/`** — a spec's type error surfaces only from the suite.
- **The admin suite exits 1 with everything green** until #335 lands; report the summary lines.
- Two backend files are known-flaky and neither is broken: `dispatch-crashed-zone-recovery`,
  `global-guard-validation` (#184).

## Remaining acceptance criteria

**#338** — none; AC1–AC5 all met, report written, issue ticked.
**#336** — none.
Every other slice #337, #339–#366 is unstarted.

## Open questions / HITL

- **Plan §7 holds ten operator decisions**, each with the default its slice assumes. None blocks
  #339/#340. The **request-scoped acting guard** #339 assumes was raised and is unanswered — proceed on
  the default.
- **#337 needs FCM credentials** (external provisioning). The seam builds; only live delivery is blocked.
- **The dev database has not been seeded.** `SEED_DEV_WALK_FIXTURES=true npm run seed:dev-fixtures` is an
  operator action and the dev backend is mid-run for the other session. Until it runs, the 17 blocked
  survey findings stay blocked — the command exists, the state does not.

## Suggested skills

- **`/tdd`** — red-first per slice; each slice's Verification line in plan §4 is the test to write first.
- **`/code-review`** — per finished slice, before the bookkeeping.
- **`/diagnose`** — when a cited `file:line` no longer matches behaviour. The plan's `file:line`
  references were verified on 2026-09-03 but the tree moves.
