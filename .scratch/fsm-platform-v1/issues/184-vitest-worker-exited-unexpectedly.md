# 184 — `Worker exited unexpectedly`: a child process dies mid-run and silently deletes whole spec files from the result

Status: ready-for-agent
Type: AFK · Backend (test infrastructure)

Filed 2026-07-31. **Fifth of the suite-repair set, and the one that actually explains the
"non-deterministic suite" headline.** Sequence:
**[#180](./180-test-db-determinism-truncate-reseed.md) → #184 (this, alongside/after #180) →
[#181](./181-business-sweep-scheduler-arity-and-config-drift.md) + [#182](./182-hermetic-test-env-allowlist.md) → [#183](./183-tier-override-frozen-clock-check-violation.md).**

Split out of #180 §R8 while filing that issue; the residual finding of
[#156](./156-test-db-orphan-accumulation.md) ("Residual finding — orphans were not the only cause")
is the same defect, first seen 2026-07-22.

> **This is a DIAGNOSIS issue, not a known-bug fix.** The mechanism is not resolved. Do not open with
> a speculative fix — reproduce first. The ACs are written around that.

---

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

- [ ] **AC-1 — the exit is characterised, not guessed.** The child's **exit code and signal** are
      captured and recorded in the completion report, together with whatever it wrote to stderr. Until
      this exists, no fix may be proposed. (R4: vitest 2 does not print it; instrument
      `test/setup-env.ts` or run the pool with `--pool=forks --poolOptions.forks.singleFork` and
      Node's `--trace-uncaught --trace-warnings`.)
- [ ] **AC-2 — reproduced on demand.** A named command reproduces the crash at a **measured rate**
      (e.g. "3 of 20 loops of the settings-write window"). If it cannot be reproduced in 20 loops of
      both R6 windows, that negative result is recorded and the investigation escalates to bisecting
      the full 315-file order — **do not close the issue on a failure to reproduce.**
- [ ] **AC-3 — root cause named, with the evidence that discriminated it** from the other R5
      hypotheses. "Raised the memory limit and it stopped" is not a root cause unless AC-1 shows an
      OOM exit.
- [ ] **AC-4 — fixed, and the fix is shown to work against the measured rate** from AC-2: the same
      loop count, zero crashes. A fix validated on fewer loops than the repro used is not validated.
- [ ] **AC-5 — the class cannot be silent again.** The suite fails loudly when a file disappears: a
      check asserting `failed + passed + skipped === collected` for both files and tests, wired into
      the test command (a reporter, a wrapper script, or a `globalTeardown`). This is what turns the
      next occurrence from "the passed count drifted by 7" into a named failure. **Ship this even if
      AC-3 stalls** — it is independently valuable and much cheaper than the diagnosis.
- [ ] **AC-6 — three consecutive full runs report `(315)` files and `(1295)` tests with
      `failed + passed + skipped` summing to each, and `Errors 0`.** Jointly with
      [#180](./180-test-db-determinism-truncate-reseed.md) AC-1 this is the actual "the suite is a
      measurement instrument" gate. Neither issue can claim it alone.
- [ ] **AC-7 — `settings-write.e2e-spec.ts` specifically.** It has now crashed twice, nine days apart
      (`156-test-db-orphan-accumulation.md:45` and run 2 here). It survives 20 consecutive runs of the
      R6 window, and the completion report states whether its `AppModule` boot was causal.
- [ ] **AC-8 — #180 interplay recorded.** After #180 R1.2 lands, state whether
      `plant-zone-change-impact` still crashes (H3). If the unique-violation fix removes it, say so —
      that halves the issue and is worth knowing before chasing H1.

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
