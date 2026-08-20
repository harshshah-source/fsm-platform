# 260 — The 05:00 run waits out brief contention instead of skipping a zone until tomorrow

Status: ready-for-agent
Type: AFK · Backend
Decision: #258 Q8.6 (G2)

## Objective

A seconds-long collision at scheduler start must not cost a zone its daily dispatch. The automatic
run retries contended zones within a bounded window; humans still get instant refusals.

## Current behaviour

`dispatchTick` calls `runForActiveZones` once; on CONFLICT it logs and returns
`{ran:false, reason:'RUN_IN_PROGRESS'}` (`dispatch-scheduler.service.ts:70-75`). Nothing retries;
the next attempt is tomorrow's cron. With #259 the refusal shrinks to per-zone, but a contended
zone would still silently get nothing.

## Required change

Asymmetric acquisition, in the shared path so G8 holds:

- **CRON trigger**: after the first pass, re-attempt admission for zones that came back CONTENDED,
  on a bounded schedule — default every 60s until a deadline (default 15 min after fire; both
  env-tunable `DISPATCH_RETRY_INTERVAL_MS` / `DISPATCH_RETRY_DEADLINE_MS`, read once like the other
  scheduler config). Each successful late admission dispatches under the SAME `dispatch_runs` row;
  zones still contended at deadline keep their CONTENDED ledger row — visible, not silent (G7).
- **MANUAL trigger**: unchanged — try-once, informative 409/CONTENDED outcome. An operator wants an
  answer, not a queue.
- Retry loop must respect the single-in-flight tick guard and never overlap the next day's tick.

## Existing code to reuse

#259's per-zone admission; `runGuarded`-style single-flight; `SchedulerTickOutcome`.

## Data model / API / UI surfaces

None / none / n/a (ledger already shows the outcome).

## Acceptance criteria

- [ ] Zone held for 90s at 05:00 (fake timers): cron's first pass records CONTENDED, retry admits
      and dispatches within the window, same runId, run finalizes with the zone DONE.
- [ ] Zone held past the deadline: zone stays CONTENDED on the ledger; run PARTIAL; a log line
      states the give-up.
- [ ] Manual runs never wait (timing-asserted).
- [ ] Retry never starts a second `dispatch_runs` row.

## Tests

Unit (fake-timer retry policy) + e2e with a claim held by a second connection, released mid-window.

## Dependencies / Blocked by

**#259 then #261, in that order.** #261 is now a hard prerequisite (pre-implementation review): the
reaper is what frees a crashed holder, so patience without reaping merely makes the cron wait its
full deadline behind a zombie claim before giving up.

## Risks

A long-held claim (crashed run) makes the cron wait the full deadline — bounded by design; #261's
reaper is what actually frees it.

## Rollback

Config-defaulting the deadline to 0 restores try-once behaviour.
