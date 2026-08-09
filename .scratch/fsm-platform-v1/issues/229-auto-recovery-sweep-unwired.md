# 229 — `AutoRecoveryService.runAutoRecovery` has no production caller; 11,042 open tickets are already closable

Status: needs-triage
Type: HITL (wiring it is a step change in every auto-recovery / SE-productivity metric) · Backend
Filed: 2026-08-09
Origin: measured while satisfying the operator's pre-application gate on
[#222](./222-telemetry-staleness.md) — *"tell me the expected closure count for the auto-recovery sweep
before it runs."* Answering that question is what surfaced the fact that it never runs.
Coordinates with: [#222](./222-telemetry-staleness.md) · [#223](./223-ndd-counted-healthy.md) ·
[#228](./228-guard-pattern-remediation.md) (same class: a mechanism that fails toward "fine")

## Problem

Auto-recovery is built, documented, tested and unreachable.

`AutoRecoveryService.runAutoRecovery()` (`apps/backend/src/ticketing/auto-recovery.service.ts:27`) is
called from exactly one place in the repository:

```
test/auto-recovery.e2e-spec.ts:99   await service.runAutoRecovery(NOW);
test/auto-recovery.e2e-spec.ts:119  await service.runAutoRecovery(NOW);
```

There is **no `@Cron`, no controller route and no CLI script**. The service is provided and exported by
`ticketing.module.ts`, and `TicketsController` injects it — but only reaches `manualClose`, the
per-ticket ZM endpoint `POST /tickets/:id/auto-recovery-close`. Eleven other business sweeps have
`@Cron` wiring in `business-sweep-scheduler.service.ts` (verification, install-verification, intraday
timeout, cross-zone, repeat escalation, tier-override expiry, soft-inactive, system efficiency, fleet
uptime, root cause, ZM performance). Auto-recovery is not among them.

**Confirmed at the data, not inferred from the code.** Across 42,955 recorded transitions in
`ticket_events`:

| `to_state` | Rows | First | Last |
|---|---:|---|---|
| `OPEN` | 31,162 | 2026-07-09 | 2026-08-07 |
| `CLOSED` | 11,792 | 2026-07-14 | 2026-08-07 |
| `CRITICAL_INSERTION_ACCEPTED` | 1 | 2026-07-09 | 2026-07-09 |
| **`CLOSED_AUTO_RECOVERY`** | **0** | — | — |

The state has never been written. `ticket.status` holds only `OPEN` (12,571) and `CLOSED` (11,792).

## Measured impact, 2026-08-09

Evaluating the sweep's own predicate — ≥3 pings spanning ≥15 min with
`gps_datetime > cycle.opened_at` — over the live `fsm` database:

| | Tickets |
|---|---:|
| Open TROUBLESHOOT tickets | 12,571 |
| **Already satisfy the auto-recovery criterion** | **11,042 (87.8%)** |
| …of those, on devices that are **healthy right now** (`is_inactive = false`) | **9,888** |
| …of those, on devices still inactive (flapping — pinged after the cycle opened, then went silent) | 1,154 |
| …of those, on departed devices | 0 |

**The open TROUBLESHOOT queue overstates real field work by roughly 9,888 tickets.** Every ticket
whose device came back on its own stays open forever, because the only mechanism that closes it is
unwired. The 12,571 figure is quoted as a baseline in #222 and #223; it is not a count of broken
devices.

## Why it failed silently

The same shape as [#228](./228-guard-pattern-remediation.md)'s specimens: **absence of the mechanism is
indistinguishable from the mechanism finding nothing to do.** A sweep that runs and closes zero tickets
and a sweep that never runs produce identical observable output — no log line, no metric, no row. The
e2e spec proves the service works when called, which is exactly the evidence that stops anyone asking
whether it *is* called. Nothing asserts the wiring.

Compare `INGESTION_SCHEDULER_ENABLED` / `autoplant:window-preflight` (#218), where the *presence* of a
binding is asserted programmatically against the real `AppModule`. That pattern is the fix template.

## What to build

1. **Wire the sweep** — a `@Cron` on `business-sweep-scheduler.service.ts` alongside the other eleven,
   with an env-overridable expression and the same enable flag posture the module already uses.
2. **Make the wiring assertable** — a spec that boots the real `AppModule` and asserts a registered cron
   named `business-auto-recovery` exists, in the shape of the window-preflight assertion. A comment is
   not a guard (#228).
3. **Decide and record the first-run posture** (below) before the first sweep executes.
4. **Backfill decision** for the 11,042 — one bulk closure, staged, or left to the cron's natural first
   pass (which closes all of them at once anyway).

## Open questions / decisions needed

- **D1. Does the first sweep close 11,042 tickets in one pass, or is the backlog closed under a
  distinct status?** `CLOSED_AUTO_RECOVERY` exists specifically to keep SE-repaired closures out of
  productivity reporting, so 11,042 auto-closures do *not* inflate SE productivity — but they do
  produce an 88% single-day collapse of the open queue and a spike in every auto-recovery metric and
  monthly uptime aggregation that reads closure counts
  (`fleet-uptime-aggregation.service.ts` splits auto vs SE closures explicitly).
- **D2. Cron cadence.** The ping evidence is already months old for most of the backlog, so nothing is
  time-critical; the natural cadence is the telemetry tick or daily.
- **D3. Should the 1,154 flapping devices auto-close?** They meet the criterion (pings after the cycle
  opened) but are inactive *now*, so closing the ticket immediately re-opens a new cycle on the next
  ticket-creation sweep. That is churn, not recovery. The criterion may need an "and is not currently
  inactive" clause — a behaviour change to `meetsRecoveryCriteria`'s caller, not to the pure predicate.
- **D4.** Does the same class of unwired-sweep defect exist elsewhere? `FleetUptimeAggregationService`
  documents itself as *"On-demand (no scheduler)"* and `VerificationService` shares that posture — both
  are deliberate and documented, unlike this one. A sweep of every `@Injectable` sweep-shaped service
  for unwired callers is worth one pass.

## Acceptance criteria

- `runAutoRecovery` has a production caller and a test that asserts the binding on the real `AppModule`.
- D1–D3 answered and recorded here before the first sweep runs.
- The expected first-run closure count is re-measured and recorded **before** execution (the same gate
  the operator set on #222).
- `docs/SYSTEM-STATE-2026-07.md` stops describing auto-recovery as an operating mechanism if it does
  not yet operate; corrected in place per CLAUDE.md.

## UI surfaces

n/a — backend wiring. The *effect* is visible on every ticket queue and the auto-recovery/uptime
reports, but this issue creates no new surface.

## Reference

n/a

## Blocked by

Nothing technically. **Deliberately NOT bundled into the #222 + #223 slice** — see #222's
"Expected auto-recovery closure count" section: an 11,042-closure event has nothing to do with the
timestamp fix (which moves the number by 5) and must not be attributed to it.
