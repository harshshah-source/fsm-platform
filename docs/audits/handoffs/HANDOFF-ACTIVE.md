# HANDOFF — module-gaps backlog COMPLETE, five follow-ups open — 2026-09-04

Status: active
Issue: none in flight — the next unit of work is a **choice between five filed follow-ups** (below)
Branch: `feat/autoplant-integration` · base: `3d74eff` (where this run started)

## The job

The module-gaps completion backlog — **31 slices, #336–#366** — is **finished**. All of it is built,
committed and green. There is **no slice in flight**, nothing half-applied, and nothing to resume.

This handoff exists for two reasons only: to stop a fresh session re-deriving what was decided across
five parallel rounds, and to carry **two decisions the operator has not answered** plus five filed
follow-ups that nothing in the backlog will pick up.

Current state lives in `docs/SYSTEM-STATE-2026-07.md` and `.scratch/fsm-platform-v1/INDEX.md` §P12
(every slice has a row saying what it decided and where the plan was wrong). Per-slice detail is in
`docs/progress/<n>-*.md`. **Do not re-derive any of that from the diff.**

## Next step

**Ask the operator which of the five follow-ups to take, or act on whichever they name.** Do not
start one unprompted — the backlog they asked for is done, and picking the next piece of work is
theirs. If they say "keep going" without naming one, take **#370** first: it is the only PRD
notification event still without a producer, and #337/#338 already landed everything it needs.

Two things are waiting on an operator answer specifically (see *Open questions*), and one of them —
the F7 replay — **decays**: every day that passes adds another cube row computed on the corrected
aggregation, which is fine, but the historic rows stay wrong until someone decides how far back to
restate.

## Standing instructions from the user

Quoted, not paraphrased:

- **"Implement rest of remaining issues of scope-gap in proper sequence."** — the instruction that
  drove the last three rounds. **It is now satisfied**: 31 of 31. Treat it as discharged, not
  standing, unless they repeat it about the follow-ups.
- **"Do NOT parallelize blindly by wave number. Use BOTH: the explicit dependency graph … and actual
  file ownership/overlap in the repository"**; *"uncertain ownership → treat as conflicting and
  serialize"*; *"If the current environment cannot safely isolate concurrent work, reduce concurrency
  rather than risking the repository."*
- **"The objective is maximum safe parallelism, not maximum simultaneous agents."**
- **"option 1"** — on a migration: hand-write it and rely on the suite, flagging that the drift gate
  was not run. **Standing answer for every migration in this run**; used by #338, #348, #353, #357,
  #337. Never regenerate `prisma/drift-baseline.txt`.
- **"commit it and start 338"** — commits are wanted **per slice, explicit paths only**.
- **"use option 3, then finish 336 and continue"** — the Platinum fixture is a scoped, expiring tier
  override (#157), never a re-tiered company.
- From the plan session, still live: *"Analyze the `docs/module-gaps/` results against the **current
  codebase** … verify every important finding against the current code before creating work. Do not
  blindly implement the report."* **This earned its keep: roughly two thirds of slices found their
  issue or the plan wrong.**
- Treat the AFK policy in `CLAUDE.md` as live: stop only for architecture / business-rule conflict /
  backlog-ownership / external-access / security.
- The operator answered the two design stops (#368, #369) in this session. **Do not re-ask them** —
  the designs are committed under `docs/ui/desktop/approved-designs/`.

## State of the tree

- **Everything is committed.** `git status` shows only four untracked files, none of them this
  work's: `.scratch-backend-run.json`, `apps/backend/_wh_evidence.mjs`, `audit/analysis-results.xlsx`,
  `docs/SUMMARYReport11thAug.xlsx`.
- Uncommitted: **none**.
- Half-done or stubbed: **none**.
- **Tests — full gate, both suites, nothing else running:**
  - `.scratch/locks/backend-test.sh npx vitest run` →
    `Test Files 464 passed | 3 skipped (468)` · `Tests 2792 passed | 5 skipped (2802)` · **zero
    failures**. One tinypool `Worker exited unexpectedly` orphaned a single file's results.
  - `cd apps/admin && npx vitest run` → `Test Files 1 failed | 135 passed (136)` ·
    `Tests 1 failed | 1049 passed (1050)`. The one failure was `commissioning-cohort` — **a file no
    slice touched** — asserting text synchronously after `findByTestId`, so under contention it read
    the loading `—`. Hardened to `waitFor` the value; re-run alone `26 passed (26)`.
  - Raw logs: `.scratch/final-gate.log`, `.scratch/round3-verify.log`.
- Typecheck: `apps/backend npx tsc --noEmit` and `apps/admin npx tsc -b` were clean per slice at
  commit time; not re-run after the last bookkeeping commit (docs only).

## Done so far

**25 commits, `3d74eff..HEAD`.** The INDEX P12 rows carry the per-slice detail; this is the shape:

- Round 1 (10 slices) and the acting chain — already recorded in the previous handoff, now
  `HANDOFF-round2-2026-09-03.md`.
- **Round 2 (6):** #343 `0f45c99` · #353 `989ba44` · #347 `ddc2e05` · #355 `5ce3699` · #360 `042aa0b`
  · #356 `59c2096`, plus `735a0b6` and `2130d43`.
- **Round 3 (4):** #349 `42e556a` · #357 `d165d55` · #363 `79072b0` (+ `12175f8`) · #364 `1d70753`.
- **Round 4 (2):** #337 · #358.
- **Round 5 (4):** #366 · #351 · #365 · #361.
- Bookkeeping: `38f7ad8` and the final docs commit; designs #368/#369 committed with their records.

## Decisions taken (not recoverable from the diff)

The per-slice reports own their own. The ones that outlive a single slice:

- **Round composition was computed from real file ownership every round, and twice contradicted the
  plan's wave numbers.** Round 3 dropped #337/#351 on discovering that #337 *and* #357 both needed
  `schema.prisma` — two `prisma generate` runs cannot share a working tree — and pulled in #363/#364,
  unblocked hours earlier by #343/#347. **Wave numbers are not a disjointness matrix.**
- **A follow-up issue covers work not yet done, never a regression already shipped.** #357 made a
  reason mandatory and would have broken a live admin button; that was fixed inside #357's own commit
  rather than deferred to #358, which "owned the page".
- **#366 refused the plan's schema change.** A stored pickup flag would be wrong within hours in
  *both* directions — "stop 0 appears only when it is real" is present tense, and
  `component_request.status = 'SHIPPED'` already means shipped-and-not-received. Rejected
  alternative: the plan's "+ pickup flag/row on the schedule + migration".
- **#365 ships a stated deviation, not a hidden one.** AC1's "computed from the summary tables" is
  impossible today (cube `se_id` on legs 5 and 7 only; legs 3/4/8 write NULL; no closure-type split).
  It ships a bounded live read whose first-time-fix predicate is character-for-character leg 3's —
  answering the design's *actual* concern (disagreeing with the scorecard beside it) rather than its
  literal wording. #372 restores the cube path.
- **`escalation_reason` is a live verdict, not history** (#357): escalate sets, de-escalate clears,
  so NULL means "not under escalation" and never "escalated for an unrecorded reason". The rejected
  alternative — append-only — makes the report list every ticket ever escalated, including ones
  reversed as raised in error.
- **#337 aborts the boot on misconfiguration** rather than degrading to inert. A quiet fallback to
  the logging gateway would rebuild that slice's own defect one layer up.

## Dead ends — do not retry

- **NEVER run two backend suites at once** — one `fsm_test`, and the `fsm` role cannot
  `CREATE DATABASE`. The symptom is dozens of files failing `401` at `login()`, which looks exactly
  like an auth regression. `docs/agents/parallel-execution.md` §1.
- **Do not edit `src/` while a suite runs** — vitest transforms each test file as it loads it.
- **Do not `git add` a directory.** Stage individual paths, always.
- **A plain `Proxy` on `PrismaService` does NOT reach inside `$transaction`** — an atomicity test
  written that way passes the mutation straight through and proves nothing. Use
  `test/fixtures/outbox-crash-injection.ts`, which wraps the transaction client. (#361 paid for this.)
- **Do not hand an interfering Prisma proxy only to the service under test when the write goes
  through `withAudit`** — it opens its transaction on the `AuditService`'s own client.
- **Do not reuse `outbox-crash-injection.ts`'s `failingNotifyEnqueue` for a day-plan producer** — it
  deliberately lets day-plan rows through, so it injects nothing.
- **Do not defer an enqueue because "there is no transaction to enqueue into."** That reading was
  wrong three times in #338 and once again in #361 review; the mutation had a local transaction.
- **Do not regenerate `prisma/drift-baseline.txt`.**

## Gotchas

- **`dispatch-crashed-zone-recovery` is NOT flaky** — the docs called it that for weeks. It failed
  deterministically **after 18:00 IST** because three call sites did not pin the recovery cutoff
  their ten siblings pin. Fixed in `test/setup-env.ts` (`735a0b6`). If it fails now, it is real.
  `global-guard-validation` (#184) is still genuinely flaky.
- **A tinypool `Worker exited unexpectedly` orphans one file's results without failing anything.**
  The counts will not add up. Re-run the orphan alone before hunting a phantom failure.
- **Watch the SKIP count, not just failures.** A broken `AppModule` DI makes every e2e importing it
  report as **skipped** — a suite that looks green while a third of it never ran. **5 skipped is the
  baseline.**
- **The harness kills a backgrounded Bash command at ~10 minutes.** Run the full suite detached via
  PowerShell `Start-Process` writing to a log, then poll the log. Pattern in `.scratch/final-gate.log`.
- **The Bash tool's safety classifier can go down**, taking Bash with it; read-only tools still work.
- The Bash tool truncates a long heredoc — write files over ~120 lines with the Write tool. **Do not
  use PowerShell here-string syntax (`@'…'@`) in the Bash tool**; it leaks into the commit subject.
- `apps/backend/src/generated/` is gitignored — `npx prisma generate` after a schema edit. The schema
  is at **`apps/backend/prisma/schema.prisma`**. `packages/shared`'s `dist/` is gitignored too —
  `npm run build` it after a type change.
- The admin nav is **`apps/admin/src/components/shell/nav.ts`**; `src/lib/nav.ts` does not exist.
- e2e fixture logins: `zm.north@fsm.test`, `csm@fsm.test`, `ops.head@fsm.test`, `wm@fsm.test`,
  `se.north@fsm.test`, password `correct-password`. There is no `oh@fsm.test`.
- `.scratch/locks/` and `.scratch/PARALLEL-BRIEF.md` are **gitignored** — recreate the mutex from
  `docs/agents/parallel-execution.md` §3 and the brief from `docs/agents/parallel-agent-brief.md`.

## Remaining acceptance criteria

**None outstanding inside the 31 slices**, with one stated exception, and every gap has a filed
issue rather than silence (the CLAUDE.md parity gate):

- **#365 AC1's "computed from the summary tables"** — deliberately unmet, reasoning above → **#372**.
- **#367** — mobile Tickets screen does not consume #360's poll contract; an SE still watches a
  VU-deferred ticket vanish.
- **#370** — SLA-warning at bucket crossing, the ninth PRD notification event. **Its dedup must be
  per (event, ticket, bucket), NOT per day** like #361's other eight.
- **#371** — mobile day plan does not render #366's pickup stop; the engineer who must walk to the
  warehouse is the one who cannot see it.
- **#372** — SE productivity onto the cube. Key AC: **the numbers must not move.**
- Plus: `REVOKED` as a real `leave_request_status` member (#363 derived it rather than touching
  #357's schema).

## Open questions / HITL

Two, both raised and **unanswered**:

1. **The F7 replay.** #365 fixed `se_repaired_closures` going forward, but **cube rows computed
   before it still carry the mis-attribution** — an SE whose plants had vehicles leave the fleet
   reads as more productive than one who repaired devices. The aggregation is idempotent per day, so
   `POST /reports/efficiency/recompute?day=` corrects any day on demand. **Nobody has decided how far
   back is worth restating, and no replay was run.**
2. **Whether #365's live read is acceptable** or should wait for #372's cube columns. It was shipped
   under the reasoning above; the operator has not confirmed.

Still open from earlier, not blocking: **INV-G2** (#353 built the default — a recovery receipt writes
a transaction row and moves no stock; reversal is one function, `writeRecoveryReceipt`), **#337 needs
FCM credentials** (external provisioning; the seam is built and tested, default binding `logging`),
and **the dev database has never been seeded** — `SEED_DEV_WALK_FIXTURES=true npm run seed:dev-fixtures`
is an operator action.

## Suggested skills

- **`/tdd`** — red-first on whichever follow-up is taken.
- **`/code-review`** — worth one pass over `3d74eff..HEAD` now that the backlog is whole; no
  cross-slice review has been done, only per-slice diff inspection at commit time.
- **`/diagnose`** — if a cited `file:line` no longer matches; it frequently did not this run.
