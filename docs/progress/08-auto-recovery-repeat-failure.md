# Progress — Issue 08: Auto-recovery + Repeat-failure detection

> Build date: 2026-06-20→21 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **DONE**. All 6 acceptance criteria green. Backend **167 tests / 50 files**, `tsc --noEmit`
> clean (local PostgreSQL 18, no Docker). Backend-only issue — Issue 07's `InlineBadges` already
> renders the ESCALATED / AUTO_RECOVERY / REPEAT conditions, so no admin work was needed.

## Decisions taken (HITL, this issue)

1. **Repeat detection is event-driven; escalation is a daily scan** (ADR-0021). New-cycle creation
   sets `repeat_failure` immediately (no lag); the 3-in-7-days escalation runs as a batch method
   `RepeatEscalationService.runEscalationScan(now)`. **No cron yet** — scheduling is deferred, the
   same posture as Issue 04's BullMQ worker.
2. **Invariant I1 widened to cover REPEAT + ESCALATED.** The active-episode partial-unique originally
   guarded only `OPEN/WAITING_COMPONENT/SUBMITTED`. A REPEAT cycle is the device's current repeat
   episode (opened with an OPEN ticket), and an ESCALATED cycle is a still-down device flagged to
   ZM+WM — LLD §10.2 lists ESCALATED among the **non-closed** ticket statuses. Both are active
   episodes, so the DB partial-unique now rejects a second active cycle for the device, behind the
   `has_open_failure_cycle` application fast-path. VERIFIED/FAILED stay excluded (genuine closures).
   *(This resolved the I1/REPEAT open decision carried in the 2026-06-21 handoff.)*

## Summary

Self-healing + recurrence detection on the failure-cycle layer:

- **Auto-recovery** — `AutoRecoveryService.runAutoRecovery` scans open TROUBLESHOOT tickets; a device
  that resumed pinging (≥3 pings spanning ≥15 min after the cycle opened, pure
  `meetsRecoveryCriteria`) with **no SE form** closes its ticket `CLOSED_AUTO_RECOVERY`, drives the
  cycle VERIFIED, clears `has_open_failure_cycle`, and records a lifecycle event — one transaction.
  The distinct `CLOSED_AUTO_RECOVERY` status keeps these separable from SE-repaired `CLOSED` so
  productivity/component reports aren't inflated.
- **Manual auto-recovery** — `manualClose` lets a ZM (zone-scoped) / CSM / OpsHead mark an open ticket
  `CLOSED_AUTO_RECOVERY`, exposed at `POST /api/tickets/:id/auto-recovery-close` (200 / 404 / 409).
- **Repeat detection** — `TicketCreationService` checks for a prior VERIFIED cycle on the same device
  closed within 24h; if found, the new cycle opens `state=REPEAT`, `repeat_failure=true`,
  `previous_failure_cycle_id` linked. The prior VERIFIED cycle is never mutated.
- **Escalation** — `RepeatEscalationService.runEscalationScan` counts each device's `repeat_failure`
  cycles opened in the last 7 days (the immutable flag means closed episodes still count); at ≥3 it
  drives the device's active cycle + ticket to ESCALATED with a lifecycle event. Idempotent (an
  already-ESCALATED device has no active non-escalated cycle to transition). Escalation does **not**
  close the episode — the device is still down, so `has_open_failure_cycle` stays set.

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | Resuming device auto-closes ticket `CLOSED_AUTO_RECOVERY`, no form | 🟢 | `recovery-criteria.ts` + `AutoRecoveryService.runAutoRecovery`. `recovery-criteria.spec.ts`, `auto-recovery.e2e-spec.ts`. |
| 2 | Auto-recovery closures separable from SE-repaired | 🟢 | Distinct `CLOSED_AUTO_RECOVERY` status (vs `CLOSED`). `auto-recovery.e2e-spec.ts`. |
| 3 | ZM can manually mark `CLOSED_AUTO_RECOVERY` | 🟢 | `manualClose` (zone-scoped) + `POST /api/tickets/:id/auto-recovery-close`. `auto-recovery-manual.e2e-spec.ts`. |
| 4 | Repeat detection flags new cycles, links previous | 🟢 | `TicketCreationService` prior-VERIFIED-≤24h → REPEAT + `previous_failure_cycle_id`. `repeat-failure.e2e-spec.ts`. |
| 5 | ESCALATED tickets flagged distinctly | 🟢 | `RepeatEscalationService.runEscalationScan` (3-in-7d) + I1 widening. `repeat-escalation.e2e-spec.ts`, `i1-repeat-escalated-guard.e2e-spec.ts`. Issue 07 `InlineBadges` renders the ESCALATED badge. |
| 6 | VERIFIED cycles immutable; repeat opens a new cycle | 🟢 | Prior cycle stays VERIFIED; a new REPEAT cycle is created. `repeat-failure.e2e-spec.ts`. |

## Slices delivered

- **1 — recovery criteria**: pure `meetsRecoveryCriteria` (≥3 pings, ≥15-min span). `recovery-criteria.spec.ts`.
- **2 — auto-recovery scan**: `runAutoRecovery` + `closeAsAutoRecovery`. `auto-recovery.e2e-spec.ts`.
- **3 — manual close**: `manualClose` (zone scope) + controller endpoint. `auto-recovery-manual.e2e-spec.ts`.
- **4 — repeat detection**: `TicketCreationService` retrofit (REPEAT cycle + link). `repeat-failure.e2e-spec.ts`.
- **5a — I1 widening**: migration `20260621011500_i1_active_cycle_covers_repeat_escalated` adds
  REPEAT + ESCALATED to the partial-unique. `i1-repeat-escalated-guard.e2e-spec.ts`.
- **5b — escalation scan**: `RepeatEscalationService.runEscalationScan` (3-in-7d → ESCALATED + event).
  `repeat-escalation.e2e-spec.ts`.

## Deviations / deferred (read before extending)

1. **No scheduler.** Both `runAutoRecovery` and `runEscalationScan` are invokable service methods with
   no cron/worker yet — wiring them to the LLD's `RepeatFailureScanWorker` (daily) and the
   verification-driven auto-recovery cadence lands with the scheduling/BullMQ work (Issue 04 lineage).
2. **No SE-form guard yet.** `runAutoRecovery` assumes no troubleshooting form was submitted; the
   `troubleshooting_submissions` table is Issue 16. The guard comment marks where it slots in.
3. **Escalation notifications deferred.** ESCALATED is set + a lifecycle event recorded, but the
   ZM + Warehouse Manager notification fires when the notification/audit spine lands (Issue 03).
4. **`ticket_events.actor_id`** for the escalation event is null (system batch); the users FK +
   immutability trigger come with Issue 03, same as the creation event.

## How to run / verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run     # 167 green
cd apps/backend && node node_modules/typescript/bin/tsc --noEmit
# focused: node node_modules/vitest/vitest.mjs run test/auto-recovery.e2e-spec.ts \
#   test/auto-recovery-manual.e2e-spec.ts test/repeat-failure.e2e-spec.ts \
#   test/repeat-escalation.e2e-spec.ts test/i1-repeat-escalated-guard.e2e-spec.ts
```

Note: `pnpm exec` triggers a network deps-check that FortiGate blocks; run the vitest/prisma/tsc
binaries directly via `node node_modules/...`. Prisma partial-uniques are hand-written raw SQL in the
migration (`migrate deploy` applies them); `migrate dev` alone won't.
