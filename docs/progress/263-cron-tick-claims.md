# 263 — DB-side cron tick claims: a second sweeps-enabled instance is a safe no-op

**Status:** DONE · 2026-08-24 · branch `feat/autoplant-integration`
**Issue:** `.scratch/fsm-platform-v1/issues/263-cron-tick-claims.md` · **Decision:** #258 Q8.7 (G6, G7)
**Suite at completion:** backend **409 files / 2033 passed / 5 skipped / 0 failed** (four foreground
chunks, all exit 0). No admin/mobile surface — this issue has none.

---

## 1. What was wrong

Correctness depended on an operational convention nobody enforced: `BUSINESS_SWEEPS_ENABLED` /
`INGESTION_SCHEDULER_ENABLED` being `"true"` on **exactly one** instance.

Every `@Cron` in the app fires wherever its flag is truthy. The guards that stop a tick overlapping its
own successor are all process-local — a `Set` on the `BusinessSweepSchedulerService` singleton
(`runGuarded`), a `private inFlight = false` on four others — and are invisible to a second process. So
two enabled instances ran every sweep twice, and the failure was silent in every case:

- report cubes racing delete-then-insert on the same month;
- doubled notification sends;
- duplicate dispatch runs, degraded to `LOCK_CONTENDED` noise rather than to an error;
- the recommender's `P2002 → continue`, which drops the recommendation without a trace.

None of that fails loudly. The system looks like it is working, right up to the point somebody counts
rows.

## 2. What was built

A row. `cron_tick_claims (job_name, window_start)` with a composite primary key, written with
`INSERT … ON CONFLICT DO NOTHING` — the insert **is** the admission test, not a check followed by an
act — so exactly one instance can win a `(job, minute)` window regardless of how many are running.

```
tick fires
  ├─ dormant gate      (enabled? source configured?)   ← unchanged, and FIRST (see §4)
  ├─ single-in-flight  (is THIS process still in the previous tick?)   ← unchanged
  ├─ claimTickOrLog(jobName, firedAt)                  ← #263, the new step
  │     won  → run the sweep
  │     lost → log the holder, return { ran: false, reason: 'TICK_CLAIMED' }
  └─ sweep
```

| Piece | File |
|---|---|
| Window derivation, claimant id, the two ports (`TickClaimant`, `TickClaimPruner`) | `src/scheduling/cron-tick-claim.ts` |
| `claimTick` / `claimTickOrLog` / `pruneExpiredClaims` | `src/scheduling/cron-tick-claim.service.ts` |
| Leaf DI module (imports nothing — cannot cycle) | `src/scheduling/cron-tick-claim.module.ts` |
| Table + composite PK + `window_start` index | `prisma/migrations/20260823150000_cron_tick_claims/` |

**Wired into the seven shared guard layers, not the nineteen handlers** — `runGuarded` (covers all
eleven business sweeps at once), `DispatchSchedulerService` (both ticks), `ScheduleClosureScheduler`,
`PlantEligibilityRefreshScheduler`, `VehicleReturnResumeScheduler`, `IntegrationSchedulerService` (both
ticks), `PartitionMaintenanceService`. A sweep added to any of them inherits cross-instance safety
without its author having to know the property exists, which is the only way a guarantee like this
survives contact with the next issue.

## 3. Decisions worth keeping

**`TICK_CLAIMED` is its own outcome, and deliberately neither `ERROR` nor `RUN_IN_PROGRESS`.** Not
`ERROR` because G7 says a no-op is not a failure — with two instances deliberately enabled, a refusal
happens every single tick, and a scheduler that reported `ERROR` for behaving correctly would train an
operator to ignore the channel. Not `RUN_IN_PROGRESS` either, which means something genuinely
different: *this* process is still inside its previous tick, i.e. a sweep is overrunning its cadence.
Collapsing the two would make "we are running two instances, as designed" indistinguishable from the
one signal on that channel worth waking up for. The refusal is logged at `log`, not `warn`, for the
same reason.

**The window is the UTC minute, and it is timezone-free.** Two instances never fire at the identical
millisecond, so the claim has to key on a bucket. A minute is the finest bucket that cannot split one
logical fire in two (nothing in this app fires more often than every two minutes) and the coarsest that
cannot merge two distinct fires. `timeZone: BUSINESS_TIMEZONE` (#240) decides *when* a job fires; once
it has fired the only thing left is an instant, and an instant has no timezone — which is also why DST
cannot produce a seam here. `Math.floor` on epoch milliseconds, not `%`.

**The registered cron-job name is the claim key.** It had to be globally unique — one table serves
nineteen jobs — and the registered name already is, since `scheduler-wiring.e2e-spec.ts` pins the exact
set. Re-deriving a second literal beside the first is how the two drift, so the eleven literals inside
`@Cron` options objects became `BUSINESS_SWEEP_JOBS`, and the other eight became exported constants
shared by the decorator and the claim.

**Gate order: dormant → in-flight → claim.** Each position is load-bearing.
- Dormant first, so an instance that is **not going to run** never takes a window. A claim taken and
  abandoned would silence the instance that *would* have run — the exact inverse of the bug. This is
  what makes the `INGESTION_SCHEDULER_ENABLED`-but-`UNCONFIGURED` case (dev box, lost VPN) safe, and it
  is pinned by a test.
- In-flight second, so a process still inside its own previous tick does not spend a database round
  trip to learn it.
- Claim last, immediately before the work.

**One round trip on both paths.** A CTE runs the insert and, only when it inserted nothing, reads back
the holder for the log line — the winner pays one indexed insert and the loser does not pay for a
second statement. **A caveat that is stated in the code rather than hidden:** in READ COMMITTED the
trailing `SELECT` uses the statement's snapshot, so if the conflicting insert commits *after* this
statement began, the query returns zero rows. That is still an unambiguous refusal (our insert did not
land) and is reported as one, with an unknown holder. Treating a zero-row result as a win is the single
mistake here that would reintroduce the double-run.

**The dispatch tick claims once, covering #260's patience loop.** Waiting out a contended zone can
carry the tick past a minute boundary; re-claiming per retry would hand a second instance the very
window this one is still working. The zone claim (#259) arbitrates the retries themselves — this
arbitrates whether a second instance starts a parallel run at all.

**Manual HTTP triggers are not tick-claimed** (issue §5), and this holds structurally rather than by
convention: no controller calls a `*Tick` method — the manual paths (`POST /api/schedules/dispatch-run`,
`POST /api/integration/run-pipeline`, the per-sweep POSTs) invoke the underlying services directly, and
are arbitrated by the guards the run itself carries. Verified by grep across `src/**/*.controller.ts`.
An operator pressing the button must not be silenced because the cron fired in the same minute.

**Retention rides the `partition-maintenance` tick (AC-4), adding no cron.** A twentieth job would have
to be added to `scheduler-wiring.e2e-spec.ts`, and that list is a decision record — a table of a few
thousand rows a week does not justify an entry in it. That tick is the natural host: it is already the
daily janitor and already owns a retention horizon. The prune runs after the DDL, so it is skipped on a
day the DDL throws — the right trade, because a day of unpruned claims is invisible and a partition
that never got created is not. Re-claimability after a prune is intended and tested: nothing reads a
claim once its tick is over, and seven days is far outside any window two instances could still race
for.

**Schedulers depend on a `TickClaimant` port, not on `CronTickClaimService`.** Most specs that build a
scheduler are testing dormancy, cadence or the sweep itself, and handing those a connection pool would
be actively harmful — the real service writes rows, so a spec driving one handler ten times would start
refusing *itself* the moment two calls landed in the same minute. `test/support/tick-claims.ts` gives
them a two-line `alwaysClaims()`. `PartitionMaintenanceService` is the one exception and takes the
concrete class: it is plain-DI rather than factory-provided, and Nest resolves a constructor param by
its emitted class token, so a structural type would leave nothing to inject.

## 4. Two corrections to the issue text

1. **`scheduler-wiring.e2e-spec.ts` pins 19 jobs, not 18.** The issue's AC-4 was written before #261
   added `business-dispatch-reaper`. The substance of the criterion — *this issue adds no cron* — holds
   and is asserted; the number in the issue file is stale.
2. **There is no #111 runbook to note the NTP assumption in** (`docs/runbooks/` holds only
   `local-development-login.md` and `mobile-android-build.md`). Recorded in
   `docs/SYSTEM-STATE-2026-07.md` §3g instead, which is the current-state document the reading order
   actually points a session at.

## 5. The residual risk, stated

Clock skew above 60 s between instances puts two of them in **different** windows, and both would run.
Nothing in the code enforces NTP, so this is an assumption, not a guarantee — it is recorded in §3g.
The failure mode when it happens is duplicated *work*, not corrupted state: every downstream claim still
holds (the #259 per-zone dispatch claim, `recommendations_one_suggested_per_ticket`,
`batch_assignment_tickets_one_active_per_ticket`, `work_schedules_one_active_per_se_zone_day`). This
issue removes the *routine* double-run; the partial uniques remain the backstop for the pathological one.

## 6. Tests

| File | What it pins |
|---|---|
| `test/cron-tick-window.spec.ts` (5) | Minute truncation, idempotence, bucket boundaries, DST-irrelevance, the retention constant |
| `test/cron-tick-claims.e2e-spec.ts` (7) | The claim itself over **two Prisma pools** — first asker wins, holder is named, one row per (job, window), next window is free, per-job scoping, exactly one winner under a real race, prune horizon + re-claimability |
| `test/cron-tick-claim-wiring.e2e-spec.ts` (12) | **AC-1/AC-2** — all seven guard layers, each as a pair of independently constructed services over two pools, asserted on the **sweep's own side effect** (a wiring that claimed the window and then ran anyway satisfies a row count and fails this). Plus: per-job independence, the loser winning the next window, a DISABLED instance leaving the window free, and AC-4's prune riding the maintenance tick |
| `test/scheduler-wiring.e2e-spec.ts` (unchanged) | **AC-3** — still exactly 19 registered cron names |

`test/support/tick-claims.ts` is the new shared stub. Eleven existing scheduler specs were updated for
the new constructor collaborator; none of their assertions changed.

**A test-method trap worth recording:** `vi.spyOn(prisma.workSchedule, 'findMany')` with no
implementation records the call and then returns `undefined` to the caller — a Prisma delegate accessed
off the client is a fresh object each time, so the pass-through does not survive. It surfaced here as
`zones is not iterable` inside a `catch` that turned it into `reason: 'ERROR'`. `mockResolvedValue([])`
is both the fix and the right fixture.

## 7. Files

**New:** `src/scheduling/cron-tick-claim.ts` · `cron-tick-claim.service.ts` · `cron-tick-claim.module.ts` ·
`prisma/migrations/20260823150000_cron_tick_claims/migration.sql` · three specs · `test/support/tick-claims.ts`.

**Modified (source):** the seven scheduler services above, plus five module files
(`scheduling`, `business-sweep-scheduler`, `org`, `ticketing`, `ingestion`) and `prisma/schema.prisma`.

**Rollback:** drop the seven `claimTickOrLog` calls; the table goes inert and every scheduler returns to
its pre-#263 behaviour. The migration need not be reverted.
