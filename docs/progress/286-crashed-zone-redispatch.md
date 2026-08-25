# #286 — A crashed zone gets its day back · completion report

**Landed 2026-08-25.** Owning decision: [#282](../../.scratch/fsm-platform-v1/issues/282-decision-todays-dispatch-crew-deck.md) R3
(operator ruling: same-day, bounded, automatic, through the normal admission path).
Constrained by [#258](../../.scratch/fsm-platform-v1/issues/258-scheduler-engine-ratification.md) Q8 + G1–G8,
which this issue does not weaken in any respect.

## What was wrong

#261 taught the system to recognise its own wreckage and stop being wedged by it: the reaper aborts a
run whose process stopped reporting and frees the zone claims it left RUNNING. It deliberately went no
further — `dispatch-scheduler.service.ts:122-125`, "a reaper that dispatched the zones it freed would
be an unscheduled dispatch run at an arbitrary minute of the day".

That reasoning is sound and is unchanged here. The problem was that **nothing else claimed the job**.
The freed zone was simply not asked for again until 05:00 the next morning, so a run that died at
05:02 cost that zone its entire field day — every engineer in it idle, every ticket unplaced, and no
signal anywhere that it had happened. G5's letter was kept (no permanent RUNNING); its spirit was not.

Compounding it: `clearFinalizedOrphans` **deleted** the aborted run's `SUGGESTED` recommendations, and
`dispatch_decision_traces` cascades on that delete. So the first act of the next run for that zone was
to destroy the only record of what the dead run had intended — the question an operator asks first was
answered by deletion before anyone could ask it.

## What landed

**The reaper marks; it still does not dispatch.** The split is the design, not an implementation
detail: the janitor records that a zone is owed a day, and a separate, bounded, recorded decision gives
it back.

- **Migration** `20260825140000_dispatch_zone_recovery` — `dispatch_zone_recoveries`, one row per
  `(zone, operating day)`, plus the `dispatch_recovery_state` enum
  (`PENDING` | `RECOVERED` | `EXHAUSTED` | `EXPIRED`). A table rather than in-process state because
  the event being recorded *is* process death (#258 Q8).
- **`reapStaleDispatchRuns` now finds orphan claims by predicate**, not by the run-id list it had just
  aborted: `status = RUNNING AND run.status <> RUNNING`. That is the whole population of stranded
  claims — this pass's and any earlier crashed pass's — and it is what finally makes the method's own
  documented promise ("the next reap pass finds and finishes it") true rather than aspirational. Its
  return shape is unchanged (`{runs, claims}`); the mark is a side effect, observable in the ledger.
- **`DispatchRunService.recoverMarkedZones`** — the collector. Every zone goes through
  `runForActiveZones` with no privileges: same tick claim upstream, same per-zone claim row, same per-SE
  transactions, same idempotency guards.
- **`DispatchSchedulerService.dispatchRecoveryTick`** — `business-dispatch-recovery`, `*/5 * * * *`
  IST, gated by the shared `BUSINESS_SWEEPS_ENABLED` master switch and its own #263 tick claim.
- **`clearFinalizedOrphans` and `clearFailedSeOrphans` retire instead of deleting** —
  `RETIRED`, defined with the rest of the status vocabulary in `src/recommender/recommendation-status.ts`.

## Four decisions worth recording

**A refusal does not spend an attempt.** The budget bounds a zone that keeps *failing*. A zone that is
merely *busy* — some live run holds it — is left PENDING and unbilled, because charging for contention
would exhaust a perfectly healthy zone during a slow morning. What bounds the contended case instead is
the operating-day cutoff, which terminates it for a reason an operator can read.

**The budget is per zone per day, not per crash.** A zone that crashes three times before noon draws
from one budget. Re-arming with a fresh budget on each incident would make "bounded" a property of the
incident rather than of the day, and a zone whose every run dies would loop until midnight. So a
`RECOVERED` mark *is* re-armed by a second crash (it is a new day owed) with its attempt count carried
over, while an `EXHAUSTED` or `EXPIRED` one is left alone.

**The collector is never patient.** #260's patience exists for a run that has one chance today. This one
gets another chance in five minutes, and a fifteen-minute wait inside a five-minute tick would only hold
its own window shut. It passes `deadlineMs: 0` explicitly rather than relying on the CRON default.

**`RETIRED` frees the partial unique exactly as `DELETE` did.** `recommendations_one_suggested_per_ticket`
is `WHERE status = 'SUGGESTED'`, so a retired row is invisible to it. What actually prevents a double
dispatch is that index plus the in-transaction re-read — never the DELETE — which is why removing the
DELETE costs nothing. Two readers needed the corresponding guard, and both are restorations of the
answer they gave when the row was deleted rather than new behaviour:
`zm-schedule-query.reasoningByTicket` (latest-wins, which a retired row would have started winning) and
`dispatch-transparency-query`'s batch detail (which would otherwise see two rows for one ticket).

## Surfacing

`GET /dispatch/today` gains `recovery: { state, attempts, markedAt, lastAttemptAt, lastError } | null`,
scoped to the operating day — yesterday's crash is history, and a rail that kept showing it would train
the operator to ignore the rail. The cockpit renders it above the deck as `RecoveryNotice`: neutral for
`RECOVERED`/`PENDING`, warning-weighted for `EXHAUSTED`/`EXPIRED`, always carrying the attempt count and
the last failure. A bound nobody is told about is not a bound, it is a silent outage.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `DISPATCH_RECOVERY_MAX_ATTEMPTS` | 3 | Re-dispatch runs one zone may draw per operating day. `0` disables recovery — marks are still written, and the collector retires them EXHAUSTED without dispatching. |
| `DISPATCH_RECOVERY_CUTOFF_HOUR_IST` | 18 | After this IST hour outstanding marks EXPIRE rather than dispatch. A plan produced at 19:00 is work nobody will do. |

## Tests

New:

- `test/dispatch-crashed-zone-recovery.e2e-spec.ts` (12) — the mechanism over stubs: marking, the
  collector, the attempt budget, re-arming, the cutoff, the tick's three gates, and AC6/AC7 across
  **two connection pools** (a live run on the other pool refuses the collector; a MANUAL run is still
  refused immediately and by name, and the mark is untouched by it).
- `test/dispatch-recovery-guarantees.e2e-spec.ts` (2) — the same sequence on **real tickets** through
  the real recommender and dispatcher, because G1/G2/G5 are properties of what lands on day plans and
  a stub reporting `{tickets: 0}` cannot disagree with any of them. The crash is staged by rewinding a
  run that genuinely committed its per-SE transactions, which is the only version of AC3 worth testing.
- `test/dispatch-aborted-run-evidence.e2e-spec.ts` (1) — AC8: the next run re-evaluates freshly *and*
  the dead run's trace is still readable.

Amended: `test/dispatch-today-read.e2e-spec.ts` (+3, the recovery rail),
`test/todays-dispatch.test.tsx` (+3, the notice), `test/scheduler-wiring.e2e-spec.ts` (the cron
decision-record list, 20 → 21 — updating it in the same commit is what that list is for).

One stub grew: `dispatch-run-containment.spec.ts` hand-builds a fake Prisma, and the reap now calls
`dispatchRunZone.findMany` on it. One added method, no assertion touched.

Unchanged and green: `dispatch-run-reaper`, `dispatch-zone-wedge`, `dispatch-zone-claim-admission`,
and the rest of the dispatch surface. This issue adds behaviour; it does not alter the concurrency
model.

## Not done here

**History is not backfilled** — there is no record of which zones lost days before this existed, and
inventing one would be a fabrication.

**Retiring keeps rows the delete used to remove.** `recommendations` and `dispatch_decision_traces`
carry a documented 90-day retention (`schema.prisma`) that **nothing implements** — the only sweep in
the app is `partition-maintenance`, which owns telemetry partitions, the cron-claim table and the
notification outbox, and none of the three touches these. DISPATCHED rows have therefore always
accumulated; what changes here is that a crashed or rolled-back run's orphans join them instead of
being deleted. That is a small addition to an already-unbounded table (orphans exist only when a run
dies or an SE transaction rolls back), and it is the price of AC8 — but it is a real one, and the
retention gap is now load-bearing rather than merely untidy.

**Nothing re-plans across days.** A zone that expires at the cutoff is not queued for tomorrow: the
05:00 run will pick its work up as ordinary unassigned work, which is the correct and already-existing
behaviour. Carrying a recovery across the day boundary would be a second scheduler.
