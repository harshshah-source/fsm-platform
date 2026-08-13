# 231 — `run-pipeline` is an ungated write path: every "gated by INGESTION_SCHEDULER_ENABLED" claim in the repo is only half true

Status: needs-triage
Type: HITL (backlog-ownership / ops-safety) · Backend
Filed: 2026-08-10
Origin: [#229](./229-auto-recovery-sweep-unwired.md) shipped behind the belief that
`INGESTION_SCHEDULER_ENABLED=false` made its new stage unreachable. It closed 200 tickets the same day.
Coordinates with: [#230](./230-partial-ingest-manufactures-inactivity.md) (the run this trigger started)
· [#228](./228-guard-pattern-remediation.md) (same class: a guard believed to cover more than it does)
· [#149](./149-armed-footgun.md)

## Problem

`IntegrationSyncService` has **two** entry points into the same write pipeline:

| Path | Reached by | Gated by |
|---|---|---|
| `ingestTelemetry()` | `IntegrationSchedulerService` `@Cron` | `INGESTION_SCHEDULER_ENABLED` (**`false`**) |
| `runPipeline()` | `POST /integration/run-pipeline` (Operations Head) | **nothing** |

Both run master sync → snapshot ingest → device-state recompute → **auto-recovery pre-check** →
ticket creation. Every one of those stages writes.

So the repo's standing shorthand — *"ingestion is off, `INGESTION_SCHEDULER_ENABLED` is `false`"*,
which appears in `SYSTEM-STATE` §1.2/§6, in `.env.example`, and in #229's own design section — is
**true of the cron and false of the system**. The pipeline is one authenticated button press from
running, at any time, with no flag consulted.

## How it surfaced

2026-08-10. #229 wired the auto-recovery pre-check into *both* entry points (correctly — the LLD puts
it in the pipeline, not in a cron) and reasoned that the code "lands inert" because the scheduler flag
is `false`. An operator pressed the OH trigger. Master sync 117 → snapshot run 153 → the pre-check
closed **200** tickets → ticket creation opened **3,439** cycles.

Nothing malfunctioned. The stage did exactly what it was built to do. **The gating claim was simply
about the wrong thing** — it named a flag instead of enumerating the callers, so a second caller that
predates it by two issues went unconsidered.

**What actually bounded the event was `AUTO_RECOVERY_MAX_PER_PASS` (default 200)** — a limit added for
"the operator turns the scheduler on someday", which instead caught an unplanned same-day execution.
The lesson generalises: *the bound in the code held; the bound in the prose did not.*

## Why this is not simply "remove the endpoint"

The manual trigger is deliberate and useful — it is how first-light integration has been run all along
(`integration-sync.controller.ts`), and #218c's departure catch-up is designed around an operator
driving a pass by hand. The defect is that it is **indistinguishable from a safe read** at the point
of use: it is a `POST` behind an OH role check and nothing more. No confirmation, no dry-run, no
statement of what it is about to write, no record of who pressed it.

## What to build

1. **Make the write scope explicit at the call site.** `POST /integration/run-pipeline` should require
   an explicit body acknowledging the stages it will run (e.g. `{ confirm: 'RUN_PIPELINE', stages: [...] }`),
   and default to **excluding** state-changing business stages (auto-recovery, ticket creation) unless
   named. Sync-only should be the easy path; opening thousands of tickets should not be the default.
2. **Audit the trigger.** An `audit_logs` row for who invoked it and which stages ran. Today the only
   evidence run 153 was human-triggered is inference from the run ledger's timing.
3. **One honest switch for the whole subsystem.** Either rename `INGESTION_SCHEDULER_ENABLED` to what
   it gates (`INGESTION_CRON_ENABLED`) and add a separate master `INGESTION_WRITES_ENABLED` consulted
   by *both* paths, or accept the manual path as always-live and **correct every doc that implies
   otherwise**. The current naming invites exactly the mistake #229 made.
4. **Sweep the claim, not just this instance.** Grep for assertions that a subsystem is "off" and check
   each against its *callers* rather than its flag — the #228 property, applied to gating rather than
   to scheduling. Known instances to re-check: `SYSTEM-STATE` §1.2/§6.2, `.env.example` ingestion
   block, #229 §5.1, `autoplant-window-preflight.ts` (which checks the flag and reports the subsystem
   safe — it would have said "✅ ingestion scheduler OFF" ten minutes before run 153).

## Acceptance criteria

- A test asserts that **every** caller of a state-changing pipeline stage is enumerated, and fails when
  a new caller appears without being added — the callers-not-flags rule made mechanical.
- `run-pipeline` cannot open Failure Cycles or close tickets without explicit opt-in in the request.
- The trigger writes an audit row naming the actor and the stages executed.
- `autoplant-window-preflight` reports the manual path's status, not only the cron's.
- Docs claiming the ingestion subsystem is "off" either name the caller set they cover, or are corrected.

## Blocked by

Nothing.
