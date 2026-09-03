# HANDOFF — Wave-4 run-list closed + Wave 3 begun (#311 #313 done); #315 next — 2026-09-03

> **RETIRED FROM `HANDOFF-ACTIVE.md` on 2026-09-03 by the module-gaps implementation session, with its
> run-list still OUTSTANDING — this is a park, not a completion.** The user directed that session to
> start #336 and arm auto-handoff, which needs the one live handoff slot. Nothing here was edited or
> lost; the content below is exactly as this run left it.
>
> **To resume this run:** point a session at *this file* and start at its "Next step" (#315), or move
> it back to `HANDOFF-ACTIVE.md` once the module-gaps run parks its own. Its uncommitted tree —
> #297–#310, #319, #325, #327 and this run's own slices — is **still uncommitted and untouched**; the
> module-gaps session was told the same rule and commits explicit paths only, never `git add -A`.
> Its "Gotchas" and "Dead ends" sections below stay live for anyone working this repo.

Auto-handoff: was **ARMED** (note "#334 acquisition order + run-list #321/#330/#323-324/Wave 3");
the marker is now re-armed for the module-gaps run. That switch is a single shared file
(`.claude/state/guard-armed.json`), not per-session.

## The job

Work the scheduler-forensics remediation backlog down the recorded run-list, one slice at a time,
red-first, with a `docs/progress/<issue>.md` report + an INDEX row + a session-log line per slice.
Seven slices landed this session. **Wave 3 is in progress; nothing is half-done.**

Branch: `feat/autoplant-integration` · base commit: `e0b0ed5`.

## Next step

**Start #315** (`.scratch/fsm-platform-v1/issues/315-run-status-freshness.md`) — a frontend slice on
`RunNowControl.tsx`'s in-flight pre-check. Then **#318**, then the sequential chain
**#312 → #314 → #316**, then **#329** (soft-blocked by #313, which is now done, so it is startable),
then the small independents **#322, #326, #328, #331, #333**, then **#335** (filed this session).

**Read each issue file first and re-verify its premises against the source before writing anything
down.** This is not ceremony: #324's issue asserted `SnapshotRun.chunkStats` "is never written", which
was stale (#299/#300 write *and* read it) and acting on it would have destroyed #300's containment
accounting. #311's issue said `soft_states` "does not exist yet" in a comment that was years past
true. The audit's `file:line` references have drifted badly in the files this chain keeps rewriting.

Work them **sequentially even where they are independent**: all backend suites share one Postgres with
`fileParallelism: false`, so concurrent agents contend on global fixtures and produce results you
cannot trust. Independence holds for correctness; validation is what cannot be parallelised.

## Standing instructions from the user

- **"docs/audits/handoffs/HANDOFF-ACTIVE.md /autohandoff on , continue #334, then #321, #330, #323 →
  #324, then Wave 3"** — this session's entire instruction. Everything before Wave 3 is done. Keep
  going down the list without checking in; treat the AFK policy in `CLAUDE.md` as live and stop only
  for architecture / business-rule conflict / backlog-ownership / external-access / security events.
- From the previous handoff, still live: **"yes rewrite it after you are sure"** — said about the
  handoff itself. Claims are to be verified against the repo before they are written down, not carried
  over from memory.
- **Handoffs live in `docs/audits/handoffs/HANDOFF-ACTIVE.md`.** There is only ever one.

## State of the tree

- **Committed:** this session's own work is committed (see `git log`); everything before it in this
  remediation run — #297–#310, #319, #325, #327 — is **still uncommitted**, as every prior session in
  the run recorded.
- **Uncommitted: ~340 other paths.** Mostly other sessions' admin-console WIP that long predates this
  run. **Do not commit, revert, stash or rebuild over it without asking.** This session committed
  **explicit paths only** — never `git add -A`.
- **Backend tests:** full suite run three times this session, last after #323+#324 —
  **456 spec files, 2,441 passed, 5 skipped, zero failures**, five foreground batches, every batch
  exit 0. One #184 worker-crash retry in batch 2 (`global-guard-validation`, the documented flake),
  recovered clean by the harness's own retry. #311's backend change landed after that run and was
  verified against a 21-test targeted override surface; **the next session should re-run the full
  backend suite once** to fold #311 in.
- **Admin tests:** `npx vitest run` in `apps/admin` → **119 files, 832 tests, all passing**, but
  **exit code 1**, from one pre-existing unhandled error — `TicketDetailDrawer.tsx:440` reads
  `attempts.attempts.length` unguarded and throws during render. Reproduced with #313's two source
  files stashed, so it is **not** this session's. Filed as **#335**.
- **Typecheck:** `npx tsc --noEmit` clean in both `apps/backend` and `apps/admin`.
- **Half-done / stubbed:** nothing.

## Done so far

Seven slices, each with a report under `docs/progress/`, an INDEX backlog-row update, a session-log
row, and every AC ticked in the issue file. Do not re-read the diffs to learn what they did — the
reports own that.

| issue | one line |
|---|---|
| **#334** | the dispatch run and the two-schedule movers joined #327's acquisition order |
| **#321** | the day-plan notification's two counts share one (cumulative) basis |
| **#330** | the recommender's candidate pool is fetched once per plant per run |
| **#323** | one sentinel vocabulary + one plausibility floor across both ingestion mappers |
| **#324** | per-row degradation on the masters path; the dead resume cursor removed |
| **#311** | the override preview reads the ON_SITE source the commit gates on |
| **#313** | one override implementation; Schedule Detail's silent failures closed |

New files: `apps/backend/test/support/tx-hooks.ts`,
`apps/backend/src/ingestion/autoplant/source-sentinels.ts`,
`apps/backend/scripts/probe-source-sentinels.cjs`, six new specs, two new progress reports per pair.
Deleted: `apps/backend/test/snapshot-partial-cursor.e2e-spec.ts` (its machinery is gone — #324).
Filed: **#335**.

## Decisions taken (not recoverable from the diff)

- **#334 — the dispatch run moved, not the manual doors.** Recorded in `override.service.ts`'s order
  docblock (~:230) because that block is the single place this codebase states the acquisition order.
  **Do not reopen.** And do not read #306's "the ticket write comes FIRST" as settling
  ticket-vs-schedule — it is ticket-vs-*batch*.
- **#334 — two schedules are locked ascending by `schedule_id`** (`lockSchedulesInOrder`, reached from
  `ensureSchedule`'s new `peerScheduleId`). Ascending id because it depends on the *pair of rows*,
  never on which end of *this* move a row sits at — which is what "lock the destination first" gets
  wrong.
- **#334 — the schedule is still resolved on `byPlant`, not on what the guard placed.** An SE whose
  every claimed ticket loses its guard still ends with `schedules: 1` and an outbox row of
  `tickets: 0`, exactly as before. Gating on placement is tidier and *different*.
- **#321 — cumulative, and read back the way `DayPlanQueryService` reads it.** `stopSequence` is a
  numbering not a count, and a stop whose tickets were all withdrawn is not on the plan (#179 slice 3).
  **`DispatchSummary.tickets` stays incremental** — it feeds `dispatch_runs.tickets_dispatched`.
- **#330 — the memo cache is a parameter, not a field.** Born with `runForZone`, dead with it; that is
  the whole scoping guarantee.
- **#323 — the stricter (masters) sentinel set wins**, on a directional argument: that path decides
  whether a device exists at all. `SENTINEL_DEVICE_ID` is reported for a *non-empty* sentinel only —
  a NULL/empty id is the source's ordinary no-fitted-device shape and counting it would bury the signal.
- **#324 — the resume cursor was removed rather than labelled; the column is kept, unwritten,** and
  documented at the schema field. No migration.
- **#311 — the projection asks the same *object*, not the same table**, and carries the identical
  `@Optional()` + `NoConflictSoftStatePort` fallback as `OverrideService`, so one cannot fall back
  while the other does not.
- **#313 — took the full absorption, not the issue's own sanctioned reduced landing.** `CLAUDE.md`'s
  parity gate permits deferring an in-scope UI criterion only for an external-integration blocker, and
  "the test rewrite is big" is not one.
- **#313 — the Console's preview no longer waits for the reason.** `ready` split into `moveSpecified`
  (preview) and `ready` (write). This is a deliberate console behaviour change; no console suite
  asserted the preview, and #289's contract ("a function of the target, never the reason") says the
  Schedule Detail fork was right.

## Dead ends — do not retry

- **Do not assert "no 5xx" to test "cannot deadlock."** #327 *maps* a residual 40P01 onto each door's
  ordinary conflict outcome, so a cycle and a fair race are indistinguishable from outside — #334's
  first concurrency draft **passed against unguarded code** with every observable matching. Use
  `watchDeadlocks(hits, hook)` from `apps/backend/test/support/tx-hooks.ts`.
- **Do not park a dispatch hook on `workSchedule.findFirst`** when staging the run-vs-assign cycle: the
  lookup holds nothing, so you stage a plain P2002 (#307's, already answered). Park on the `create`.
- **Do not build a table-matching regex with `new RegExp('FROM' + '\\s+' + table)`.** The `\s` is eaten
  by string escaping, the predicate never matches, and the spec **hangs on its own rendezvous** instead
  of failing. `isRowLock` takes a regex literal per table for exactly this reason.
- **Do not put a call-count assertion before the equivalence assertions** in a memoisation spec.
  #330's equivalence exists only because the count check is *last*: on the red run everything above it
  ran against the unmemoised code, which is what makes those values the pre-image.
- **Do not delete `SnapshotRun.chunkStats`** on the strength of #324's issue text.
- **Do not assert a preview/commit parity by comparing each side to a list the spec wrote.** #311's
  spec drives *both* paths over one fixture; a spec that spells the expected set twice keeps agreeing
  with itself while the two code paths diverge.

## Gotchas

- **Run the backend suite in five foreground batches**, redirected to log files. From `apps/backend`:
  `find test -name "*spec.ts" | sort -u > /tmp/all.txt; split -n l/5 -d /tmp/all.txt /tmp/b`, then
  `node scripts/run-tests.mjs $(cat /tmp/b00 | tr '\n' ' ') > /tmp/b00.log 2>&1` for each. A single run
  exceeds the Bash tool's 10-minute cap; backgrounded runs get killed with no output.
- **The Bash tool's heredocs eat backslashes**, even quoted (`<<'PY'`), and a `'` inside the body can
  break the parse outright. Write Python helpers into the scratchpad and run them, or use Edit.
- **Watch line endings when scripting edits.** Files here are a mix of LF and CRLF. `open(f,'w')`
  rewrites LF as CRLF, and a `.replace()` inserting `\n` into a CRLF file leaves one bare LF. Read and
  write binary, then check `b.count(b'\r\n')` against `b.count(b'\n')`.
- **A multi-line search pattern will not match a CRLF file.** Match line by line, or normalise first.
- **`echo $?` after a pipeline reports the pipeline's last command.** Redirect, then check.
- **`git` with repo-relative paths fails when the shell cwd is `apps/backend`** — the Bash tool's cwd
  persists across calls. A `fatal: ambiguous argument` on an obviously-present path is this.
- **`tsc --noEmit` does not cover `test/`.** Three specs passing a parameter #324 removed compiled fine
  and surfaced only from the suite. `tsconfig.test.json` reports 158 pre-existing errors in files no
  current slice touches — grep it for *your* files rather than expecting it clean.
- **Two backend files are known-flaky and neither is broken**: `dispatch-crashed-zone-recovery` and
  `global-guard-validation` (#184). Both fail under batch load and pass isolated; `run-tests.mjs`
  retries the crashed file itself and says so in the log.
- **The admin suite exits 1 with everything green** until #335 lands. Check the summary lines, not the
  exit code, and say which you used.
- **`prisma.dispatchRun.create` needs `trigger` (`CRON`/`MANUAL`) and `configSnapshot`** — there is no
  `triggeredBy`, and `configSnapshot` has no default.
- **A schema `///` doc comment still needs `npx prisma generate`** so the client's embedded schema
  string stays in step. It produces no SQL, so the drift baseline is unaffected.
- **The drift gate cannot be run the way CI runs it here** — the local Postgres role has no
  `CREATE DATABASE` right, so `fsm_drift` cannot be rebuilt. `drift-baseline.txt` is 99 lines and must
  not grow. No slice this session needed a migration.

## Remaining acceptance criteria

None outstanding for the seven slices landed — every AC is ticked in both the issue file and the
report, and #313's UI ACs were built in-slice, so the parity gate has nothing pending.

## Open questions / HITL

None on the run-list — keep going.

**#332 is `needs-info`** (deployment shape — single Nest instance vs multiple) and is not startable.
`INGESTION_SCHEDULER_ENABLED` stays off until it is resolved.

## Suggested skills

- **`/tdd`** — every slice this session was red-first, and three times the red run was the only thing
  that made the assertion honest (#330's equivalence, #334's deadlock watch, #313's CB-7 pin).
- **`/diagnose`** — when a cited `file:line` no longer matches behaviour.
- **`/code-review`** — per finished slice, before the bookkeeping.
