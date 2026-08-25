# 286 — A crashed zone gets its day back: same-day bounded re-dispatch

Status: **ready-for-agent**
Type: AFK · Backend (the policy is ruled — [#282](./282-decision-todays-dispatch-crew-deck.md) R3)
Decision: #282 R3 (operator, 2026-08-25). Constrained by #258 **Q8 + G1-G8**, which this issue may
not weaken in any respect.

## Objective

When a run dies mid-flight, the zones it held are re-dispatched **the same day**, through the normal
admission path — instead of losing their field day until 05:00 tomorrow.

## Current behaviour (verified)

`DispatchSchedulerService` reaps every 3 minutes and **deliberately does not dispatch**
(`dispatch-scheduler.service.ts:122-125`: a reaper that dispatched the zones it freed would be "an
unscheduled dispatch run at an arbitrary minute of the day"). Nothing else claims the job. So
`reapStaleDispatchRuns` (`dispatch-run.service.ts:489-509`) sets the run `ABORTED` and its claims
`ERROR`/`ABANDONED_CLAIM_ERROR`, and the zone simply stops. G5's letter is kept (no permanent
RUNNING); its spirit is not (the plan is never recovered).

Compounding it: `clearFinalizedOrphans` (`recommender.service.ts:986-995`) deletes the aborted
run's `SUGGESTED` recommendations and their traces **cascade** (`schema.prisma:935`) — so the
evidence of what the dead run intended is destroyed by the next run for that zone.

## Required change

1. **Mark, don't dispatch, in the reaper.** Reaping records that the zone needs re-dispatch (a
   status/flag on the zone claim row, or an equivalent that survives process death — it must be DB
   state, not memory, per Q8). The reaper still does not itself dispatch.
2. **A bounded same-day collector** re-dispatches marked zones through
   `runForActiveZones`'s **existing** admission path — same tick claims, same per-zone claim row,
   same per-SE transactions, same idempotency guards. Bounded: an attempt budget per zone per day and
   an operating-day cutoff, both configurable with defaults, so a zone that fails repeatedly stops
   rather than looping. Exhaustion is recorded and surfaced (#285's rail), never silent.
3. **Stop destroying the evidence**: an aborted run's `SUGGESTED` rows are retired, not deleted, so
   "why did the dead run plan this?" remains answerable. Keep `clearFinalizedOrphans`'s actual job
   (nothing may be double-dispatched) — the partial uniques and the in-transaction re-read are what
   guarantee that, not the delete.

## Acceptance criteria

- [ ] AC1 — A zone whose run is reaped is re-dispatched the same day and its engineers get a plan.
- [ ] AC2 — **Other zones are unaffected** by both the crash and the recovery (zone independence, G2).
- [ ] AC3 — **No ticket is dispatched twice** — work already committed by the dead run's finished
      per-SE transactions stands and is not duplicated (G1, effectively-once).
- [ ] AC4 — No permanent `RUNNING` state at any point in the sequence (G5).
- [ ] AC5 — The re-dispatch is bounded: after the configured attempts the zone stops being retried,
      the exhaustion is recorded, and nothing loops.
- [ ] AC6 — A manual `POST /schedules/dispatch-run` still behaves exactly as before (never patient,
      correct 409s) and is not consumed by the new mechanism.
- [ ] AC7 — Concurrency: the collector and a cron tick cannot both admit the same zone (existing
      partial unique proves it); a two-connection spec pins it.
- [ ] AC8 — An aborted run's decision traces survive the next run for that zone.
- [ ] AC9 — Full backend suite green, including every existing reaper/wedge/idempotency spec
      unchanged — this issue adds behaviour, it does not alter the concurrency model.