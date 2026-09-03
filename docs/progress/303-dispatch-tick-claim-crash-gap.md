# #303 — The dispatch day survives a crash between tick claim and run admission

**Landed 2026-09-02** · branch `feat/autoplant-integration` · issue
[`.scratch/fsm-platform-v1/issues/303-dispatch-tick-claim-crash-gap.md`](../../.scratch/fsm-platform-v1/issues/303-dispatch-tick-claim-crash-gap.md)
· finding RC-3, `audit/2026-09-01-scheduler-engine-forensics.md` §8

## What was wrong

`claimTick` is `INSERT … ON CONFLICT DO NOTHING` on `(job_name, UTC-minute)` with no TTL, no
heartbeat and no reaper on the claim itself — and the claim is burned **before** `admit` writes
anything durable. An instance that dies in that gap leaves a claim and nothing else: the dispatch
reaper and the #286 collector both key off run and claim rows that were never written, and every
other instance already no-oped with `TICK_CLAIMED`.

At minute cadence that costs one tick, which is fine. `business-dispatch` fires once, at 05:00 IST,
so it costs the entire field day — silently, until a human notices and presses Run Now. It was the
one crash point in the dispatch lattice with no recovery story.

## What was built — and what it deliberately did not need

The issue offered two designs: make the run evidence atomic with the claim, or give
`cron_tick_claims` a heartbeat and reaper. Neither turned out to be necessary, because the evidence
already exists: **a tick that ran dispatched zones.** So the detection is a read, not a new column.

`DispatchRunService.recoverAbandonedDispatchTick(now)`:

1. Find the newest `business-dispatch` claim for **today's IST operating day**, older than the grace
   period.
2. Ask, **per zone**, whether anything has dispatched it since that claim (`dispatch_run_zones`
   started at or after the claim's window).
3. Mark the zones that have not, via the existing `markZonesForRecovery`, and let the 5-minute
   `dispatchRecoveryTick` collect them.

It is wired into `dispatchReaperTick` (every 3 minutes) rather than given a job of its own: that tick
is already the short-cadence janitor for this class of wreckage, and the collector it feeds is the one
that follows it. **The janitor still does not dispatch** — #261's rule — it records that a day is owed.

### Three decisions worth stating

**The grace period is derived, not invented.** `readAbandonedTickGraceMs` = the #260 retry deadline +
the dispatch stale-run threshold (15 + 10 = 25 min by default). A patient tick holds its claim for the
whole deadline while every zone is contended, and #259's rule is that a run which never happened
leaves no history — so during that window "claim, no run" is the **healthy** state. Anything shorter
would mistake patience for death and re-dispatch zones somebody is still working. Adding the stale-run
threshold on top leaves a full reap cycle of slack, the same margin `DEFAULT_DISPATCH_STALE_RUN_MIN`'s
own comment reasons about.

**Today only.** `markZonesForRecovery` stamps `businessDate = istDate(now)`, so acting on an older
abandoned claim would mark *today's* zones for a day that is long over. This is not hypothetical — I
inspected `cron_tick_claims` before designing (4,410 rows; `business-dispatch` has 5, all from past
days), and that inspection is what killed the first design, which was to add a nullable `completed_at`:
every pre-existing row would have read as "never completed". A lost day is lost; this recovers the
current one or nothing.

**The evidence is per zone, not per run.** The first implementation counted `dispatch_runs` started
after the claim, fleet-wide. That is both too coarse — a run that crashed after admitting three of five
zones leaves two owed, and a run-level count says the tick was fine — and too loose: *any* later run,
including a manual single-zone one, silenced the whole check. The existing suite caught it immediately
(`dispatch-run-tier-override-snapshot` and three of my own cases failed when the dispatch specs ran
together, because other specs' runs were suppressing the janitor). `dispatch_run_zones.started_at` is
the row that actually answers "was this zone worked", and it is also what makes the janitor
self-limiting **per zone**: the moment the collector re-dispatches zone Z, Z has a row after the window
and is never marked again, while a zone still owed keeps being seen.

## Tests

`test/dispatch-abandoned-tick.e2e-spec.ts` (new, 7). No fault injection is needed — the wreckage *is* a
claim row with no run behind it, so the spec writes exactly that and asks the janitor what it makes of
it.

- **AC1** — a claim past the grace period with no dispatch since marks the zone `PENDING`, attempts 0,
  `markedByRunId` null (there is no run to name — the point of this path), business date today.
- A tick that did dispatch the zone writes no mark for it.
- **The false positive that would matter most** — a claim *inside* the grace period is left alone.
- An abandoned claim from a previous operating day is ignored.
- Self-limiting: once the zone has a dispatch after the window the janitor goes quiet, and an
  `EXHAUSTED` mark is not re-armed (so a 3-minute janitor cannot loop on an unrecoverable zone).
- **AC1 end-to-end** — `dispatchReaperTick` actually runs it.
- **AC3** — only `business-dispatch` claims are inspected, so no other sweep's tick semantics change.

Every assertion is scoped to the file's own zone. The janitor is fleet-wide by design and the shared
test database holds other specs' zones that may genuinely be owed a day, so `out.marked` is not this
file's number to assert — a distinction the first draft got wrong and the suite caught.

**Red before green**: neutering the janitor turns **4 of 7 red**; the three "nothing should happen"
cases stay green, which is the right split.

**AC2** (no interleaving produces two live dispatch runs for one zone) needed no new code: recovery
goes through `runForActiveZones` and the per-zone claim partial-unique is unchanged. It is pinned by
the existing `dispatch-zone-claim-admission` suite, which stays green.

### Two collaborator stubs the change invalidated

`cron-tick-claim-wiring` and `dispatch-scheduler` both stub `DispatchRunService` with only
`reapStaleDispatchRuns`. The reaper tick now calls a second method, so the missing function threw
inside the tick's own catch and turned `ran: true` into `ERROR`. The scheduler swallowing it is
correct; both stubs were extended (and `dispatch-scheduler` now asserts the janitor is called with the
tick clock). Following the #141 discipline: the widening is intended, so the test moves, not the code.

## Validation

- Targeted: 7/7. Every dispatch-touching e2e spec run together: **122 files / 716 tests green**.
- `tsc --noEmit` clean.
- Full backend suite: recorded with the dispatch chain's combined run in
  [`INDEX.md`](../../.scratch/fsm-platform-v1/INDEX.md)'s session log.

## Follow-ups

None. No schema change, no migration, no new env knob — the grace period is composed from the two that
already existed.
