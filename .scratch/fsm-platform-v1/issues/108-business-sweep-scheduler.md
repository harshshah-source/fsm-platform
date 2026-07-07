# 108 — Business-sweep scheduler: the SE/manager-facing periodic loops never run unattended
Status: done
Type: AFK

> **Done (2026-07-07, TDD):** new `BusinessSweepSchedulerService` (`src/scheduling/business-sweep-scheduler.service.ts`)
> mirrors `IntegrationSchedulerService` — env-gated master switch `BUSINESS_SWEEPS_ENABLED` (default OFF),
> one `@Cron` handler per sweep, a uniform `runGuarded` body (dormant-gate → per-sweep single-in-flight
> guard → try/catch → structured `SchedulerTickOutcome`, never throws out of cron). No external-source
> gate — the sweeps run against local Postgres, so the only dormant reason is `DISABLED`. Ten ticks wired:
> verification (`runVerification`), install-verification (`runInstallVerification`), intraday timeouts
> (`sweepTimeouts`), cross-zone (`sweepAutoEscalations`), repeat escalation (`runEscalationScan`),
> soft-inactive (`recompute`), system-efficiency (`computeDay` — finalises the **previous** UTC day),
> and the three month-start cubes fleet-uptime/root-cause/zm-performance (`computeMonth` — finalise the
> **previous** UTC month). Each tick threads its clock into the sweep so tests stay sweep-driven; the
> existing authenticated HTTP triggers remain as manual overrides, unchanged.
>
> Wired via a **leaf** `BusinessSweepSchedulerModule` (imports Verification/Intraday/CrossZone/Ticketing/
> Reports for DI, factory-provided like the ingestion scheduler) — deliberately NOT in `SchedulingModule`,
> which Intraday/CrossZone already depend on (would cycle). `ScheduleModule.forRoot()` (IngestionModule)
> discovers the `@Cron` handlers app-wide, so no second registration. Cadence defaults documented in one
> place (the `DEFAULT_*_CRON` constants); every cron is `BUSINESS_SWEEP_*_CRON`-overridable.
>
> **Tests (4 new specs, all green; full backend suite 913 pass / 5 skip, tsc clean):**
> `business-sweep-scheduler.e2e-spec.ts` (config defaults/override/OFF-by-default, dormant, ERROR never
> throws, per-sweep single-in-flight guard, clock/period arg-threading incl. previous-day/month + year
> boundary, all-ten cron registration); `-intraday` (AC#5a — real offer rerouted by the tick, no HTTP;
> dormant leaves it untouched); `-install` (AC#5b — real ACTIVATED ticket CLOSED by the tick + verified
> push; dormant); `-wiring` (boots the real module graph, resolves the scheduler via DI, all ten jobs
> register — proves exports + arg order + no cycle). AC#5c (throw → ERROR, next tick still runs) covered
> in the unit spec. Per-sweep idempotence for the HTTP-vs-tick overlap case (AC#3) is owned+asserted by
> each sweep's own existing e2e suite (kept green by AC#6); the scheduler adds the tick-vs-tick guard.
>
> **To activate (ops):** set `BUSINESS_SWEEPS_ENABLED=true` (a deliberate ops step, same posture as the
> ingestion scheduler). Ticket creation (`createForInactiveEligible`) is intentionally NOT scheduled here.

> Source: 2026-07-07 independent re-audit (new finding — not in the 2026-07-03 audit's issue set,
> and **not** covered by #97, whose `IntegrationSchedulerService` deliberately schedules only the
> ingestion pipeline: telemetry tick + masters tick).

## Evidence

Grep across `src/` (2026-07-07): the only `@Cron` handlers are `integration-scheduler.service.ts`
(telemetry/masters) and `partition-maintenance.service.ts`. Every *business* sweep is reachable only
via an authenticated HTTP POST:

- `VerificationService.runSweep` — GPS three-phase verification; doc comment says "a 5-min cron wires
  to it when scheduling lands".
- `IntradayInsertionService.sweepTimeouts` — the **10-minute acceptance-timeout contract** (Issue 30);
  only caller is `POST /api/intraday-insertions/sweep-timeouts` (`intraday-insertion.controller.ts:60`).
- `CrossZoneEscalationService.sweepAutoEscalations` — Platinum 1h/4h auto-escalation; only caller is
  the controller (`cross-zone.controller.ts:50`) — today fired from an **admin-page button**.
- `InstallLifecycleService.runInstallVerification` — first-ping install closure; "safe to run every
  few minutes; a BullMQ cron wires to it when scheduling lands".
- `RepeatEscalationService` — same posture per its doc comment.
- `SoftInactiveCountService` twice-daily snapshot; `FleetUptime`/`RootCause`/`ZmPerformance`
  month-end and `SystemEfficiency` daily recomputes — all "cron deferred", OH-triggered only.

## Root cause

Each issue (18/29/30/32/34/39–43) shipped its sweep as an on-demand worker with "cron deferred", but
no issue ever owned the deferral. #97 closed the gap for ingestion only and explicitly scoped the
rest out.

## Production impact

Deployed today with the scheduler enabled, telemetry flows and device states age correctly — but:
intraday CRITICAL offers **never time out** (an SE who ignores an offer blocks the ticket forever
unless an admin presses the sweep button every 10 minutes); troubleshoot verifications never
resolve, so tickets sit VERIFICATION_PENDING and PRE_VERIFICATION van-stock rows never settle;
Platinum SLA breaches never auto-escalate; install tickets never auto-close or fail activation;
report cubes go permanently stale. The core field loop only works if a human drives it on a timer.

## What to build

Extend the existing in-process `@nestjs/schedule` posture (arch pre-decided by the #97 review — no
Redis/BullMQ) with a `BusinessSweepSchedulerService` mirroring `IntegrationSchedulerService`:
env-gated master switch (`BUSINESS_SWEEPS_ENABLED`), per-sweep cron expressions with sane defaults
(verification + install-verification + intraday timeouts: minutes-scale; cross-zone + repeat
escalation: ~15 min; soft-inactive: twice daily; system-efficiency: daily; monthly cubes:
month-start), a tick that never throws out of cron context, and overlap-safety per sweep (each sweep
is already documented idempotent/re-entrant — verify per sweep, add a single-in-flight guard where it
is not). Existing HTTP triggers remain as manual overrides; injected clocks keep tests sweep-driven.

## Acceptance criteria

- [x] With `BUSINESS_SWEEPS_ENABLED=true`, each sweep above runs on its cadence with no HTTP call; disabled/unset ⇒ dormant no-op ticks (dev/test/CI unaffected).
- [x] A tick failure is logged and returns a structured outcome — it never throws out of the cron context and never halts sibling sweeps.
- [x] Concurrency: a tick overlapping a manual HTTP trigger of the same sweep degrades to a skip or a safe re-entrant run — verified per sweep (documented idempotence is asserted by a test, not assumed).
- [x] Cron expressions are env-overridable; defaults documented in one place.
- [x] Regression tests: (a) intraday offer created, clock advanced past `ACCEPTANCE_TIMEOUT_MIN`, scheduler tick fires → offer rerouted with no HTTP call; (b) ACTIVATED install ticket + first ping → tick closes it; (c) a sweep that throws → tick reports ERROR, next tick still runs.
- [x] Existing sweep e2e suites stay green (HTTP triggers unchanged).

## UI surfaces
n/a (backend; existing admin sweep buttons keep working)

## Reference
n/a

## Blocked by
None — can start immediately. Deliberately excludes ticket creation (`createForInactiveEligible`),
which stays gated on the eligibility HITL decision (review B7, empty `pgi_history`) recorded in
INDEX.md's flagged-not-filed note.
