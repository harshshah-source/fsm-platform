# 287 — The run knows whether its eligibility data is fresh

Status: **ready-for-agent**
Type: AFK · Backend
Evidence: [`audit/scheduler-engine-forensics-2026-08-25.md`](../../../audit/scheduler-engine-forensics-2026-08-25.md) §C/§E.

## Objective

A dispatch run that consumes a stale floating-eligibility view says so. Today it cannot know.

## Current behaviour (verified)

`plant_eligible_floating_se` is refreshed at 04:30 IST
(`plant-eligibility-refresh-scheduler.service.ts:71-89`). The tick **swallows its own failure**
(`:91-93`, returns `{ran:false, reason:'ERROR'}`; nothing escalates). The 05:00 run performs **no
freshness check** — grep confirms the MV's only readers are `refresh()` and
`eligibleSeIdsForPlant()` — and `captureConfigSnapshot` (`dispatch-run.service.ts:939-993`)
records weights, thresholds, capacity, cron and tier overrides but **not** MV state. A failed refresh
therefore produces a silently wrong FLOATING candidate pool with zero signal.

## Required change

Record the refresh outcome (succeeded-at / failed-at) in durable state; read it during pre-check;
stamp it into the run's `config_snapshot` alongside the other frozen inputs; and surface a warning
on the run when the data is older than the operating day. **Non-blocking** — the run proceeds, per
the codebase's existing posture toward degraded inputs; it just stops being silent.

## Acceptance criteria

- [ ] AC1 — A successful refresh records its outcome; a failed one records the failure rather than
      swallowing it.
- [ ] AC2 — `config_snapshot` carries MV freshness for every run.
- [ ] AC3 — A run whose MV is stale is flagged, and the flag is readable through the existing run
      detail API (so #285 can show it).
- [ ] AC4 — The run still completes — staleness warns, never blocks.
- [ ] AC5 — Backend suite green.