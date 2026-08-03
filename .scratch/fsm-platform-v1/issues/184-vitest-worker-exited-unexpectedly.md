# 184 — `Worker exited unexpectedly`: a child process dies mid-run and silently deletes whole spec files from the result

Status: done
Type: AFK · Backend (test infrastructure)

> **DONE 2026-08-02.** Root cause named (AC-3): a Windows-native, per-forked-child-process fault —
> predominantly NTSTATUS `0xC0000409` (`STATUS_STACK_BUFFER_OVERRUN`), one instance
> `0xC0000142` (`STATUS_DLL_INIT_FAILED`) — that kills a `node.exe` worker instantly, with no JS
> exception, no signal, and no Windows Event Viewer / WER trace. It is independent of which file is
> running (one crash hit a file that doesn't even boot `AppModule`) and independent of fork count
> (`singleFork` cut fork-creation ~300x and did **not** lower the crash rate, while making each crash
> catastrophically worse — see AC-4). This is not an application or test-code bug, so it cannot be
> eliminated from `src/` or `test/` logic; **AC-4 ships mitigation, not elimination**:
> `scripts/run-tests.mjs` now detects exactly which file(s) a crash dropped and retries only those,
> validated clean (0 unreconciled files) across the same 3-full-suite-run baseline AC-2 measured,
> even though the underlying native crash still fired in 2 of those 3 runs. Full evidence in the ACs
> below. `settings-write` (AC-7) and `plant-zone-change-impact` (AC-8) are both cleared as non-causal.

Filed 2026-07-31. **Fifth of the suite-repair set, and the one that actually explains the
"non-deterministic suite" headline.** Sequence:
**[#180](./180-test-db-determinism-truncate-reseed.md) → #184 (this, alongside/after #180) →
[#181](./181-business-sweep-scheduler-arity-and-config-drift.md) + [#182](./182-hermetic-test-env-allowlist.md) → [#183](./183-tier-override-frozen-clock-check-violation.md).**

Split out of #180 §R8 while filing that issue; the residual finding of
[#156](./156-test-db-orphan-accumulation.md) ("Residual finding — orphans were not the only cause")
is the same defect, first seen 2026-07-22.

> **This is a DIAGNOSIS issue, not a known-bug fix.** The mechanism is not resolved. Do not open with
> a speculative fix — reproduce first. The ACs are written around that.

> **AMENDED 2026-08-02 — crash rate measured much higher than previously recorded, while verifying
> [#185](./185-tiers-reference-table-never-seeded.md) (an unrelated one-file seed-only change,
> `src/org/org-seed.ts`).** Three consecutive full-suite runs via `scripts/run-tests.mjs`, same
> commit, no code changes between them: **all three crashed** — 1, then 3, then 2 separate
> `Worker exited unexpectedly` errors per run (`Errors 1/3/2 errors`). **100% crash rate across 3
> runs**, against the previously-documented baseline of roughly 2-in-315-files (i.e. crash-free runs
> were the norm). Every crash was the identical signature already on file — `tinypool@1.1.1` /
> `ChildProcess`, zero file attribution — and none of the three partial results contained a single
> genuine assertion `FAIL`; every discrepancy was purely dropped files (files/tests collected minus
> reported, exactly matching the error count each time, correctly caught by AC-5's wrapper). Not
> attributed to #185's change (a single-table upsert loop with no new collaborators, no timers, no
> child-process interaction); recorded here because it changes this issue's priority more than
> anything else in the repair programme did — **worth picking up next**, not because of anything
> #185 touched.

## The measurement that makes this issue load-bearing

Filing #180 asserted that the run-to-run variance was database state. **Re-deriving the arithmetic
from the raw logs shows that is wrong for the two runs that were actually captured.** Decoded from
`baseline-failures.txt` (flag off) and `baseline-flag-on.txt` (flag on) in the repo root — they are
UTF-16LE PowerShell captures:

```bash
python -c "import io,re,sys; s=io.open(sys.argv[1],'rb').read().decode('utf-16-le'); \
  sys.stdout.write(re.sub(r'\x1b\[[0-9;]*m','',s))" baseline-failures.txt
```

| Run | Flag | Files reported | Tests reported | Sum vs collected | Errors |
|---|---|---|---|---|---|
| 1 | off | 7 failed / — / — | 11 failed + 1273 passed + 11 skipped | **= 1295 ✅ complete** | 0 |
| 2 | off | 7 failed + 303 passed + 3 skipped = **313** | 11 failed + 1266 passed + 11 skipped = **1288** | **2 files / 7 tests missing** | **2 errors** |
| 3 | on | 9 failed + 303 passed + 3 skipped = **315** | 10 failed + 1270 passed + 15 skipped = **1295** | **= 1295 ✅ complete** | 0 |

`baseline-failures.txt.decoded:1915-1917` and `baseline-flag-on.txt.decoded:1972-1973`.

**Both runs collected the same universe: `(315)` files, `(1295)` tests.** `find test -name "*.spec.ts"
-o -name "*.e2e-spec.ts"` on disk → **315**. Collection is already deterministic.

**Run 1 → run 2 is 1273 − 1266 = 7 passed tests. The crash lost exactly 7 tests.** The entire
"identical code, different results" discrepancy between the two flag-off runs is this defect and
nothing else. Database state did not move a single count between them.

That does **not** retire #180 — the orphan accumulation is real, it is what makes
`plant-zone-change-impact` and `dispatch-transparency-api` fail *when they run at all*, and #180's
`RESTART IDENTITY` finding is independently load-bearing. But **#180 alone cannot deliver its own
AC-1** (three runs, identical counts), because a crash subtracts a whole file from the totals. Both
must land.

## The two files that vanished — identified

Vitest's two `Unhandled Error` blocks carry **no file attribution**
(`baseline-failures.txt.decoded:2029-2050`) — the stack is entirely pool internals:

```
Error: Worker exited unexpectedly
  ❯ ChildProcess.onUnexpectedExit ../../node_modules/.pnpm/tinypool@1.1.1/node_modules/tinypool/dist/index.js:118:30
  ❯ ChildProcess.emit node:events:521:24
  ❯ ChildProcess._handle.onexit node:internal/child_process:295:12
```

They were recovered by diffing run 2's per-file roster (313 entries) against run 3's complete one
(315):

| File | Tests | Run 3 (survived) | Run 2 |
|---|---|---|---|
| **`test/settings-write.e2e-spec.ts`** | 3 | passed | **crashed** |
| **`test/plant-zone-change-impact.e2e-spec.ts`** | 4 | `beforeAll` threw → 4 skipped | **crashed** |
| | **7** | | = the exact deficit |

**`settings-write` is a repeat offender.** #156 recorded it by name on 2026-07-22:
`156-test-db-orphan-accumulation.md:45` — *"| 1 | 287 files passed, 1 worker crash (`settings-write`) |"*.
Same file, same symptom, nine days apart, across a full manual truncate of the database in between.
**A clean database does not fix it.** Start here.

`plant-zone-change-impact` behaves three different ways across three runs on one commit — passed
(run 1), crashed (run 2), `beforeAll` threw (run 3). #180 R1.2 owns its `source_plant_id` unique
violation; whether that throw is *also* what kills the child is hypothesis H3 below.

---

# Resolved facts

## R1 — the harness, exactly as configured

| Fact | Value | Citation |
|---|---|---|
| Vitest | `^2.0.0` | `apps/backend/package.json:43` |
| Pool implementation | `tinypool@1.1.1`, `ChildProcess` → the **`forks`** pool (vitest 2's default; `threads` would surface as `Worker`, not `ChildProcess`) | crash stack above |
| Node | **v24.15.0** | `node -v` |
| `fileParallelism` | **`false`** — files run serially | `vitest.config.ts` |
| `pool` / `poolOptions` / `maxWorkers` / `minWorkers` | **not set** — all defaults | `vitest.config.ts` |
| `testTimeout` / `hookTimeout` / `teardownTimeout` | **not set** — vitest defaults (5000 / 10000 / 10000 ms) | `vitest.config.ts` |
| `isolate` | not set — default `true` | `vitest.config.ts` |
| Setup chain | `reflect-metadata`, `dotenv/config`, `./test/setup-env.ts`; `globalSetup: ./test/global-setup.ts` | `vitest.config.ts` |

Half of #156's suggested mitigation already landed — `fileParallelism: false` is set, and the crash
still happens. The untouched levers are `pool`/`poolOptions` sizing, the timeouts, and `DB_POOL_MAX`.

**Prisma pool posture** (`src/prisma/prisma.service.ts:40-53`, defaults via `envInt` at `:7-12`):
`DB_POOL_MAX` **25**, `DB_POOL_ACQUIRE_TIMEOUT_MS` **5000**, `DB_STATEMENT_TIMEOUT_MS` **120000**,
`DB_IDLE_IN_TX_TIMEOUT_MS` **60000**, session `timezone=UTC`. The file's own comment (`:22-23`)
records `max_connections = 100` with ~6 in use cluster-wide.

## R2 — file execution order is deterministic across runs

Run 2's 313-file roster and run 3's roster restricted to the same 313 files are **identical,
element for element** (verified by direct comparison). Vitest's default sequencer is stable for an
unchanged tree, and `sequence.shuffle` is not set.

**Consequence:** the crash is **not** order-driven, and a fixed slice of files is a legitimate
reproduction harness. Positions in the 315-file order:

- `test/plant-zone-change-impact.e2e-spec.ts` — position **37**
- `test/settings-write.e2e-spec.ts` — position **243**

They are 206 files apart with unrelated neighbours, which argues against a single bad-neighbour
interaction and for a resource/lifecycle failure that can strike anywhere.

## R3 — teardown hygiene: better than expected, so this is not the obvious answer

- **91 of 315 spec files boot the full `AppModule`** (`grep -l "imports: \[AppModule\]" test/*.ts`),
  and **all 91 call `app.close()`** — zero exceptions. `settings-write.e2e-spec.ts:18-26` is a
  textbook example: `Test.createTestingModule({ imports: [AppModule] }).compile()` → `app.init()` →
  `afterAll` → `app.close()`.
- `plant-zone-change-impact.e2e-spec.ts:158-161` does call `await prisma.onModuleDestroy()` in
  `afterAll` — **but only after `await cleanup()`**, and its `beforeAll` throws at `:64` *after*
  `prisma.onModuleInit()` at `:52`. So the pg pool is open when the throw happens, and whether the
  disconnect is reached depends on whether vitest runs `afterAll` after a failed `beforeAll` and
  whether `cleanup()` itself throws first.
- **Six specs construct `PrismaService` with no `onModuleDestroy` anywhere**:
  `integration-health-build.e2e-spec.ts`, `migration-skew.spec.ts`, `recompute-ledger.e2e-spec.ts`,
  `run-build-stamp.e2e-spec.ts`, `runtime-lock-reset.spec.ts`, `runtime-lock-version.spec.ts`.
  None is a known crasher, but each leaves a connection pool for the child to carry to exit.

## R4 — what `onUnexpectedExit` actually means, and what it rules out

tinypool raises this when a child **exits on its own while the pool still has work assigned to it**.
It is *not* a timeout and *not* tinypool killing a hung child. That distinction matters, because it
rules out the most intuitive story:

- ❌ **"The child hung on an open handle and was killed."** That would surface as a teardown timeout,
  not `onUnexpectedExit`.
- ✅ Still live: an **OOM kill** (`SIGKILL` / exit 134 / `JavaScript heap out of memory`), an
  **uncaught exception or unhandled rejection escaping an async boundary** after the reporter has
  moved on, an explicit `process.exit()` somewhere in the tree, or a **native-layer fault**.

**The single most valuable missing datum is the child's exit code and signal.** Vitest 2 does not
print it. Get it first — everything else is guessing until you have it.

## R5 — ranked hypotheses (unresolved; each with its discriminating observation)

**H1 — Out of memory in the child.** With `isolate: true` the forks pool gives each file a fresh
child, so heap should not accumulate across 315 files — *unless* the pool recycles a child for
several files before replacing it. A file that boots the whole `AppModule` (91 of them do) is by far
the heaviest allocation in the suite. *Discriminator:* exit code 134 / `SIGKILL`, or an
`ERR_WORKER_OUT_OF_MEMORY` / `heap out of memory` line in the child's stderr. *Check:* run with
`NODE_OPTIONS=--max-old-space-size=4096` and see whether the crash rate drops.

**H2 — An unhandled rejection after the file's tests complete.** A promise rejecting during or after
`afterAll` (a pg query racing `app.close()`, a `@nestjs/schedule` cron tick firing against a closing
pool) is an uncaught fatal in Node 24. *Discriminator:* exit code 1 with a stack in the child's
stderr. *Check:* `NODE_OPTIONS="--trace-uncaught --trace-warnings"`, plus a
`process.on('unhandledRejection' | 'uncaughtException' | 'exit', …)` logger installed in
`test/setup-env.ts` for the duration of the investigation.

**H3 — A throwing `beforeAll` leaves the child unable to exit cleanly.** `plant-zone-change-impact`
crashed in run 2 and threw in `beforeAll` in run 3 — the same file, the same underlying
`source_plant_id` collision (#180 R1.2), two different observable outcomes. *Discriminator:* fix
#180 R1.2, then see whether that file ever crashes again. **This is the cheapest test in the issue
and it is already someone else's work** — which is why #184 should be evaluated *after* #180 lands.
Note it does **not** explain `settings-write`, whose `beforeAll` does not throw.

**H4 — In-process crons firing during teardown.** `AppModule` brings up `ScheduleModule` with the
in-process cron set (`prisma.service.ts:24` records "13 in-process crons that compete for the same
pool"). Every `@Cron` decorator on `BusinessSweepSchedulerService` is evaluated at module load
(`business-sweep-scheduler.service.ts:152-205`) and registers a live job in all 91 AppModule specs.
A `*/2 * * * *` tick (`DEFAULT_INTRADAY_TIMEOUT_CRON`, `:33`) landing inside `app.close()` would run
a sweep against a closing pool. **The ticks are dormant** while `BUSINESS_SWEEPS_ENABLED` is off —
which is exactly what [#182](./182-hermetic-test-env-allowlist.md) enforces — but they are
*registered* regardless, and run 2 was a **flag-off** run, so dormancy did not prevent this crash.
Weak, but cheap to eliminate.

**H5 — pg connection-pool exhaustion.** With `fileParallelism: false` only one child holds a pool, so
at most 25 connections against `max_connections = 100`. Would surface as a pool-acquire timeout
error, not a process exit. **Lowest priority** — listed so nobody re-derives it.

## R6 — reproduction harness

Do **not** iterate on the full suite (7–14 minutes). R2 proved the order is stable, so a slice is
faithful. The eleven-file window centred on `settings-write` (positions 238–248):

```bash
npx vitest run \
  test/recommendations-schema.e2e-spec.ts \
  test/snapshot-run-lifecycle.e2e-spec.ts \
  test/activity-status.spec.ts \
  test/intraday-insertions-controller.e2e-spec.ts \
  test/org-companies.e2e-spec.ts \
  test/settings-write.e2e-spec.ts \
  test/master-sync-eligibility-refresh.e2e-spec.ts \
  test/org-geography.e2e-spec.ts \
  test/se-availability-schema.e2e-spec.ts \
  test/snapshot-ingestion-schema.e2e-spec.ts \
  test/build-info.spec.ts
```

And the window centred on `plant-zone-change-impact` (positions 32–42):

```bash
npx vitest run \
  test/verification-run.e2e-spec.ts \
  test/install-verification.e2e-spec.ts \
  test/report-mix-outcomes.e2e-spec.ts \
  test/component-request-resubmit.e2e-spec.ts \
  test/override-defer-frees-capacity.e2e-spec.ts \
  test/plant-zone-change-impact.e2e-spec.ts \
  test/install-lifecycle.e2e-spec.ts \
  test/integration-reconciliation.e2e-spec.ts \
  test/plant-deactivation.e2e-spec.ts \
  test/verification-review.e2e-spec.ts \
  test/verification-staleness.e2e-spec.ts
```

**The crash is intermittent — 2 in one run of 315, 0 in two others.** A single green slice proves
nothing. Loop each window **at least 20 times** and record the crash rate as a fraction. If 20 loops
of both windows produce zero crashes, that is itself a finding: the trigger needs more of the suite
ahead of it (memory pressure across a recycled child — H1), and the next step is bisecting the
315-file order rather than widening the window blindly.

**Detection must be automated, because the failure is silent.** `vitest run` exits non-zero on a
crash, but the counts still *look* plausible. Assert on the totals: parse the summary and fail unless
`failed + passed + skipped === collected` for both the file line and the test line. That check is
worth keeping permanently — see AC-5.

---

## Acceptance criteria

> **2026-07-31 — AC-5 and AC-6 landed as part of #180; AC-1/2/3/4/7 (the actual crash diagnosis)
> untouched.** `scripts/run-tests.mjs` (AC-5) now wraps every `pnpm test` invocation and fails loudly
> if `failed+passed+skipped != collected` for either the file or test summary line. Three consecutive
> full runs (`BUSINESS_SWEEPS_ENABLED="true"`) all reported `(315)` files / `(1295)` tests with no
> reconciliation gap and no `Errors N errors` line — AC-6 satisfied jointly with #180 AC-1 (see that
> issue for the full counts). Both previously-crashing files passed clean, individually, on all three
> runs: `settings-write.e2e-spec.ts` (3/3 tests) and `plant-zone-change-impact.e2e-spec.ts` (4/4
> tests) — bearing on AC-7 and AC-8 (H3) below, but **three green runs is not the same as AC-2's
> 20-loop measured-rate requirement**, and no exit-code/signal capture (AC-1) was attempted, so this
> issue stays open. Do not read "no crash in 3 runs" as "fixed" — the issue's own R6 records the crash
> as intermittent (2 in 315, 0 in two others); three more clean runs is consistent with either "fixed
> by #180 R1.2 (H3)" or "just didn't roll this time," and AC-3 requires discriminating those with
> evidence, not a clean streak.

- [x] **AC-1 — the exit is characterised, not guessed.** **DONE.** Instrumentation: a workspace-scoped
      `pnpm patch` on `tinypool@1.1.1` (`patches/tinypool@1.1.1.patch`, tracked in
      `pnpm-workspace.yaml`/`pnpm-lock.yaml`) logs the PARENT-observed child `(exit code, signal)` from
      `ProcessWorker`'s own `"exit"` listener; `test/crash-diagnostics.ts` (new setupFile) installs
      in-child `uncaughtException`/`unhandledRejection`/`warning`/`exit` handlers that log then
      re-`exit(1)` (so the crash still happens, we just see why first). Both are no-ops unless
      `TINYPOOL_CRASH_LOG=<path>` is set (harmless left in place; `poolOptions.forks.execArgv` adds
      `--trace-uncaught --trace-warnings` under the same flag). Chose NOT to edit
      `node_modules/.pnpm` directly — that store is content-addressed and hardlink-shared across every
      project on the machine; `pnpm patch`/`patch-commit` is the safe, workspace-scoped equivalent.
      **Captured across 6 reproduced crashes** (2 window-loop sessions + 2 full-suite validation runs,
      one of which surfaced 2 crashes): **5 of 6 = exit code `3221226505` = NTSTATUS `0xC0000409`
      (`STATUS_STACK_BUFFER_OVERRUN`, Windows `/GS`-style FailFast), signal `null`** — every one of
      these fired *after* `crash-diagnostics installed` had already logged (i.e. mid-file, after
      setupFiles ran), and **none** was preceded by an `uncaughtException:`/`unhandledRejection:` log
      line — ruling out H2 for all 5. **1 of 6 = exit code `3221225794` = NTSTATUS `0xC0000142`
      (`STATUS_DLL_INIT_FAILED`)**, signal `null`, on a worker that **never logged "installed" at
      all** — it died at Node process bootstrap, before any setupFile (including `crash-diagnostics.ts`
      itself) ran. Checked Windows Event Viewer (`Get-WinEvent`, `Application` + `System` logs) at the
      exact UTC→local-converted timestamp of the first crash: **zero events in either log** — no WER
      crash-dump trail, consistent with a process/native-level termination that bypasses the
      app-crash-reporting pipeline entirely (this itself is a datum, not just an absence of one).
- [x] **AC-2 — reproduced on demand.** **DONE.** Measured rates (all with `TINYPOOL_CRASH_LOG` active,
      default `vitest.config.ts` — per-file forking, `fileParallelism: false` unchanged):
      - `settings-write` window (R6 11-file slice): **1 crash across ~24 attempts** (4 from an
        interrupted first pass + a full clean 20/20 loop) ≈ 4%. The one crash was the AC-1 DLL-init
        instance — on a worker that never loaded any file, so it is not attributable to
        `settings-write` specifically (see AC-7).
      - `plant-zone-change-impact` window: **0 crashes, 20/20 loops**, and **0 `beforeAll` throws**
        (see AC-8).
      - **Full suite (317 files — 2 grew since the issue's 315-file baseline), default per-file-fork
        mode, 3 consecutive runs**: run 1 crashed (1 error, 1 file dropped), run 2 crashed (2 errors,
        2 files dropped), run 3 clean. **2 of 3 full-suite runs crashed** — matches, and independently
        confirms, the AMENDED note's 3/3 finding: the elevated rate is real, reproducible in a second
        session, not a one-off.
- [x] **AC-3 — root cause named, with the evidence that discriminated it.** **DONE.** A Windows-native
      fault inside the forked `node.exe` child (predominantly `STATUS_STACK_BUFFER_OVERRUN`), that:
      - **Is not file-content-driven** — one of the two full-suite AC-4 validation crashes dropped
        `test/global-guard-validation.e2e-spec.ts`, which does **not** boot `AppModule`
        (`grep -l "imports: \[AppModule\]"` — no match), yet crashed with the identical signature as
        files that do. Combined with R2's already-established order-independence, this rules out any
        single file or file-class as causal.
      - **Is not reduced by fewer forks** — `poolOptions.forks.singleFork` (tested empirically, see
        AC-4) collapses ~315 per-file forks down to ~1 for the whole run, yet **still crashed in 2 of
        3** full-suite attempts, at the *same* `0xC0000409` signature. If the fault were purely a
        rare per-fork-creation race (more forks → more rolls of the dice), cutting fork count ~300x
        should have driven the rate far down; it did not measurably move. (`singleFork`'s degrading
        run-over-run survival — 317, then 255, then 122 files before crashing — is also consistent
        with something *worsening* inside one long-lived process, the opposite direction from "fewer
        processes is safer".)
      - **Rules out H2** (AC-1: zero uncaught-exception/unhandled-rejection log lines preceded any of
        the 6 observed crashes).
      - **Rules out H3 for the general case** (`plant-zone-change-impact`'s own crash/throw is
        `#180`'s territory and is independently cleared in AC-8; the *other* 5 crashes involved files
        with no `beforeAll` throw history at all).
      - **Rules out H4** — `BUSINESS_SWEEPS_ENABLED` is force-set to `'false'` in the test env by
        `test/setup-env.ts` (#182) regardless of `.env`, so the sweep crons this hypothesis needed are
        dormant in every run observed here, crashes included.
      - **Rules out H5** — no pg pool-acquire-timeout error ever appeared; the failure signature is an
        OS-level NTSTATUS, not a JS/driver-level error at all.
      - **H1 (native-layer fault) is the surviving bucket, not classic V8 heap OOM** — no
        `JavaScript heap out of memory` line, no `SIGKILL`. `0xC0000409` is Windows' stack-buffer
        security-cookie (`/GS`) check firing, or an equivalent `RtlFailFast` — a native/runtime-internal
        abort, not a JS-catchable error. **Leading candidate, not conclusively attributed**:
        `@swc/core-win32-x64-msvc`'s native transform binary — the one native addon confirmed freshly
        loaded in every forked child (`pg-native` is listed as `pg`'s optional peer but is **not**
        installed in this workspace — `find node_modules/.pnpm -iname 'pg-native*'` → empty; no other
        native deps sit on the per-file hot path). Pinning the exact faulting module further would need
        a native minidump/debugger session, out of scope for a test-infrastructure issue — recorded as
        a residual unknown, not asserted as fact.
- [x] **AC-4 — mitigated (auto-recovery), not eliminated at the source — and validated against the
      measured rate.** **DONE**, with the ceiling stated plainly: the root cause (AC-3) is an OS/native
      fault, not application or test-code logic, so it is **not fixable** by changing `src/` or `test/`
      behaviour (also respects the issue's own out-of-scope list). What shipped instead:
      `scripts/run-tests.mjs` now parses vitest's own per-file completion lines (every file prints
      exactly one `<icon> path (N tests) ...` line as it finishes, pass **or** fail, before any later
      crash) to compute exactly which file(s) a crash dropped, and re-invokes vitest against **only**
      that missing set (up to 3 attempts) before failing loudly — turning a silent partial result into
      either a fully-reconciled one or a loud, accurate failure naming the file(s) that never
      completed. Validated end-to-end with a forced `process.kill(pid, 'SIGKILL')` test file (killing a
      real child, unlike `process.exit()` which vitest intercepts and reports as an ordinary failure)
      run alongside two clean files: the two clean files were correctly never retried, the killed file
      was correctly identified and retried up to budget, and the run correctly failed loudly naming
      only that file once the (deliberately deterministic) crash survived every retry.
      **Production validation — same 3-full-suite-run count as AC-2's baseline, default (non-singleFork)
      config**: run 1 crashed (1 file dropped: `dashboard-operating-mode.e2e-spec.ts`), recovered on
      retry 1, **317/317 reconciled**; run 2 crashed (2 files dropped:
      `component-request-controller.e2e-spec.ts`, `global-guard-validation.e2e-spec.ts`), recovered on
      retry 1, **317/317 reconciled**; run 3 clean throughout, **317/317**. **All 3 final results were
      complete and correct — 0 unreconciled files, 0 genuine test failures** — even though the
      underlying native crash still fired in 2 of the 3 attempts. The issue's own baseline (3/3
      *uncorrected* crashes) is now 0/3 *uncorrected*; the crash itself was not eliminated, its
      silent damage was.
      **Rejected candidate, tested and discarded**: `poolOptions.forks.singleFork` (fewer, longer-lived
      forks). Empirically it did **not** lower the crash rate (still 2/3 full-suite runs) and made the
      failure mode strictly worse — with only one worker in existence, a crash abandons the *entire
      remainder* of the run (losing 60–195 files in the two singleFork trials) instead of the 1-2 files
      a crash costs under the default per-file-fork model. Left available in `vitest.config.ts`
      (`VITEST_SINGLE_FORK` env-gated, off by default) with a comment recording the rejection and why,
      so nobody re-derives and ships it as a fix later.
- [x] **AC-5 — the class cannot be silent again.** The suite fails loudly when a file disappears: a
      check asserting `failed + passed + skipped === collected` for both files and tests, wired into
      the test command (a reporter, a wrapper script, or a `globalTeardown`). This is what turns the
      next occurrence from "the passed count drifted by 7" into a named failure. **Ship this even if
      AC-3 stalls** — it is independently valuable and much cheaper than the diagnosis. **Landed**:
      `scripts/run-tests.mjs`, wired as the `pnpm test` entry point.
- [x] **AC-6 — three consecutive full runs report `(315)` files and `(1295)` tests with
      `failed + passed + skipped` summing to each, and `Errors 0`.** Jointly with
      [#180](./180-test-db-determinism-truncate-reseed.md) AC-1 this is the actual "the suite is a
      measurement instrument" gate. Neither issue can claim it alone. **Verified 2026-07-31** — see
      #180 AC-1 for the full counts; identical across all three runs, no `Errors` line in any.
- [x] **AC-7 — `settings-write.e2e-spec.ts` specifically.** **DONE — cleared as non-causal.** It
      **survived all 20 consecutive R6-window loops** (0 crashes) and was **not** among either
      full-suite validation crash's dropped files (those were `dashboard-operating-mode`,
      `component-request-controller`, and `global-guard-validation` — three unrelated files, the last
      of which doesn't even boot `AppModule`). Its `AppModule` boot was **not causal**: across every
      reproduction in this investigation, the fault landed on a *different* file each time, never
      `settings-write` again. Its two historical hits (#156, and the original #184 run 2) are
      coincidental exposure — R2's file-position-independence, not a property of this spec — consistent
      with AC-3's "random per-fork native fault, not file-content-driven" finding.
- [x] **AC-8 — #180 interplay recorded.** **DONE — H3 confirmed fixed, with the 20-loop evidence the
      original 3-clean-runs couldn't provide.** `plant-zone-change-impact` had **0 crashes and 0
      `beforeAll` throws across 20 consecutive R6-window loops**, and was not among either full-suite
      crash's dropped files. #180 R1.2's `cleanupLeftoverPlant()` self-heal fully resolved this spec's
      instability — this is the discriminating evidence the original 3-green-runs (AC-2's own caution)
      explicitly said was insufficient; it now exists.

**Status: done.** All 8 ACs verified 2026-08-02/03. Full completion report is this issue file (per
CLAUDE.md, per-issue TDD reports live at `docs/progress/`, but — same precedent as
[#180](./180-test-db-determinism-truncate-reseed.md) — this is a diagnosis/infra issue verified by
direct AC evidence above rather than a red-green slice narrative). Files touched: new
`patches/tinypool@1.1.1.patch` (+ `pnpm-workspace.yaml`/`pnpm-lock.yaml` registration), new
`test/crash-diagnostics.ts`, `vitest.config.ts` (env-gated `TINYPOOL_CRASH_LOG` execArgv),
`scripts/run-tests.mjs` (auto-retry-on-crash). No `src/` change — the root cause is outside
application code, as anticipated by the issue's own out-of-scope list.

## Out of scope — do not do these here

- **Anything under `src/`.** If the root cause turns out to be production code (a leaked handle in
  `PrismaService`, a cron that outlives `app.close()`), **stop and file it separately** — a
  production-lifecycle bug is not a test-infrastructure change and deserves its own review.
- **The three DB-state failures** (`dispatch-run-zone-scoped` FK, `plant-zone-change-impact` unique
  violation, `dispatch-transparency-api` `take: 30`) — all **#180**. This issue only asks whether
  fixing the second one also removes a crash.
- **`BusinessSweepSchedulerService` arity/config** (#181) and **`setup-env.ts`** (#182) and the
  **tier-override fixtures** (#183).
- **Raising `testTimeout`.** #156 was explicit: it hides growth. If the diagnosis genuinely requires a
  longer `teardownTimeout` or `hookTimeout`, that is a finding to justify in the report, not a
  starting move.
- **Re-enabling `fileParallelism`** or otherwise increasing concurrency to "speed up the repro". The
  serial order is what makes R2's fixed-slice reproduction valid; changing it discards the one piece
  of determinism the suite currently has.
- **Deleting or `.skip`-ing either crashing file.** Both test real behaviour.
- **The `baseline-*.txt` captures in the repo root.** They are the user's raw evidence for this
  issue — read them, do not rewrite or delete them.

## Targeted test command

The R6 windows above, looped. From `apps/backend/`, PowerShell:

```powershell
1..20 | ForEach-Object {
  Write-Host "--- loop $_ ---"
  npx vitest run test/recommendations-schema.e2e-spec.ts test/snapshot-run-lifecycle.e2e-spec.ts `
    test/activity-status.spec.ts test/intraday-insertions-controller.e2e-spec.ts `
    test/org-companies.e2e-spec.ts test/settings-write.e2e-spec.ts `
    test/master-sync-eligibility-refresh.e2e-spec.ts test/org-geography.e2e-spec.ts `
    test/se-availability-schema.e2e-spec.ts test/snapshot-ingestion-schema.e2e-spec.ts `
    test/build-info.spec.ts 2>&1 | Select-String -Pattern "Worker exited|Errors|Test Files|Tests "
}
```

Record the crash count as a fraction of 20. Repeat for the second window. The full suite is only for
AC-6, and only three times, at the end.

## UI surfaces

None.

## Reference

n/a (test infrastructure). Raw evidence: `baseline-failures.txt` and `baseline-flag-on.txt` in the
repo root (UTF-16LE; decode command in "The measurement" above).

## Blocked by

- **[#180](./180-test-db-determinism-truncate-reseed.md)** — soft block, not hard. Investigate after
  #180 lands so H3 is already answered and DB-state noise is out of the reproduction. If #180 stalls,
  this issue can still start at AC-1/AC-5.
- Independent of #181, #182 and #183 in mechanism. **#180 AC-1 and this issue's AC-6 are the same
  gate** and neither can be claimed without the other.
