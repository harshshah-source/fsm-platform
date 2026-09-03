# 345 — Plant deactivation reaches the SE's day-plan notice
Status: ready-for-agent
Type: AFK
Wave: 1 · Severity: P2 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

`plant-deactivation/plant-deactivation.service.ts:222-232` strips `batchAssignmentTicket` rows
inside the deactivate transaction and enqueues nothing; spine edge E-26 ("plant deactivation → SE
plan", PRD story 51) is carried by "a human remembers". Reactivation restores nothing (`:97-120`).

## Current code

- `plant-deactivation/plant-deactivation.service.ts:222-232` — strips `batchAssignmentTicket` rows
  in-tx, no outbox row
- `plant-deactivation/plant-deactivation.service.ts:97-120` — reactivation restores nothing
- `scheduling/day-plan-notification-outbox.ts` — `queueDayPlanOverridden` and the action vocabulary
- `scheduling/day-plan-notifier.ts` — notice copy

## What to build

- `plant-deactivation.service.ts` — per affected batch, `queueDayPlanOverridden(tx, {seId,
  scheduleId, batchId, action:'PLANT_DEACTIVATED'})` inside the deactivate transaction; needs a
  batch → schedule → SE read
- `scheduling/day-plan-notification-outbox.ts` — add `PLANT_DEACTIVATED` to the action vocabulary
- `day-plan-notifier.ts` — copy for the new action, naming the plant
- Tests: `plant-deactivation.e2e-spec.ts`, `day-plan-notification-outbox-writers.e2e-spec.ts`
- Reactivation behaviour is not changed

## Acceptance criteria

- [ ] AC1 — every SE whose live plan lost a stop gets one outbox row in the same transaction
- [ ] AC2 — the message names the plant
- [ ] AC3 — reactivation behaviour is **unchanged**, and the "restore" question is recorded as a
      decision item (§7 AC-03), not built

## Verification

e2e: deactivate a plant on today's plan → one outbox row per SE; no row when there is no live stop.

## UI surfaces

n/a (backend only; the notice reaches the SE through the existing day-plan channel)

## Reference

n/a

## Blocked by

— (none)

## Absorbs / supersedes

- survey ids: AC-02, SCH-02 (spine edge E-26)
- existing issues: none named

## Decisions recorded

- **AC-03** — Should reactivating a plant restore the tickets/stops it cancelled? Default assumed:
  **No**; a fresh cycle opens on the next pipeline run (current behaviour). Recorded here as a
  Strategic HITL decision item; it does not block this slice.
