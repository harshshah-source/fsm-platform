# 113 — Daily recommender → batch-dispatch scheduler: tickets are created but never reach an SE unattended
Status: ready-for-agent
Type: AFK

> Source: 2026-07-07 follow-up surfaced while closing #108 ("will ticket scheduling of inactive
> devices work?"). #97 automated ingestion, #112 chained ticket **creation** into the telemetry tick,
> #108 automated the downstream field-loop sweeps — but the middle of the funnel (score + dispatch)
> was never scheduled by anyone.

## Evidence

Grep across `src/` (2026-07-07): `RecommenderService.runForZone` (`recommender.service.ts:76`) and
`BatchAssignmentService.dispatchForZone` (`batch-assignment.service.ts:40`) have **no production
callers at all** — no controller, no cron, nothing. Both are e2e-tested and invokable only. The doc
comment says it outright (`batch-assignment.service.ts:27`): *"Invokable method (no cron yet — same
posture as RecommenderService.runForZone)."*

## Root cause

Issues 10/11 shipped the Recommender and the BatchAssignmentWorker as invokable services with "cron
deferred", and — unlike the sweeps #108 collected — they never even received a manual HTTP trigger,
so no later issue tripped over the gap.

## Production impact

With #97 + #112 + #108 all enabled, an inactive eligible device gets a Ticket automatically — and the
Ticket then sits `OPEN`/`UNASSIGNED` forever. No SE Day Plan is ever generated. The entire P2 layer
(scoring, canonical sort, plant-cluster batching, Day-Plan dispatch, ZM override queue) is dead code
in an unattended deployment. The funnel is: ingest ✅ → create ✅ (gated on `eligibility_mode`) →
**score/dispatch ❌** → field loop ✅.

## What to build

A `dispatchTick` on (or beside) `BusinessSweepSchedulerService` — same posture as #108: env-gated
(`BUSINESS_SWEEPS_ENABLED` master switch; per-sweep `BUSINESS_SWEEP_DISPATCH_CRON` override, default
early-morning daily per the Schedule Cadence in CONTEXT), single-in-flight guard, structured
`SchedulerTickOutcome`, never throws out of cron. The tick loops zones (active zones with plants) and
per zone runs `runForZone(zoneId, { now })` then `dispatchForZone(zoneId, { dateFrom: today,
dateTo: today, now })` — daily cadence ⇒ `dateFrom === dateTo` (Schedule Cadence: daily).

Also add the missing **manual HTTP trigger** (`POST /api/schedules/dispatch-run`, OH/CSM) mirroring
the other sweeps' manual-override posture, so Ops can force a re-run without waiting for the cron.

## Acceptance criteria

- [ ] With the scheduler enabled, an OPEN UNASSIGNED TROUBLESHOOT ticket in a zone with an eligible SE ends up on a dispatched Day Plan (WorkSchedule + AUTO_ASSIGNED batch) after a single tick — no HTTP call.
- [ ] Disabled/unset ⇒ dormant no-op tick; per-zone failure is contained (one bad zone logs ERROR, remaining zones still dispatch).
- [ ] The tick is overlap-safe (single-in-flight guard) and a re-run on the same day does not double-dispatch the same ticket.
- [ ] Manual HTTP trigger exists, role-guarded, and reuses the same code path.
- [ ] Existing recommender/dispatch e2e suites stay green.

## UI surfaces

n/a (backend; the existing `/schedules` admin pages render the dispatched Day Plans)

## Reference

n/a

## Blocked by

**#100 (batch dispatch: transactional + recommendation-consuming + partial uniques + advisory lock).**
Today `dispatchForZone` re-reads **every** `SUGGESTED` recommendation with a chosen SE and never
consumes them (audit #2): put on a daily timer as-is, yesterday's stale SUGGESTED rows re-dispatch
every morning and the same ticket lands on multiple Day Plans. #100 must land first (or as slice 1 of
this issue). The `eligibility_mode` flip (creation volume) is a separate Ops/HITL decision owned by
#112's runbook and does not block this issue.
