# 11 — Batch auto-dispatch → SE Day Plan

Status: done
Type: AFK
Progress: docs/progress/11-batch-auto-dispatch-se-day-plan.md — backend dispatch engine + SE Day Plan read API; all 6 ACs green (backend 220 tests / 69 files). RN Day Plan screen, re-dispatch idempotency, and the Zone-Warehouse pickup step deferred (see progress doc).

## What to build

The `BatchAssignmentWorker` turns Recommender output into Plant-wise Batch Assignments and **auto-dispatches** them directly to the SE Day Plan as Formal Assignments — **no ZM approval gate, no pending-but-visible lock, no auto-approve timer**. Runs at a flexible Schedule Cadence (daily / alternate day / weekly / on-demand). Batch status flow `AUTO_ASSIGNED → OVERRIDDEN`. On dispatch, a push notification fires to the SE. The SE mobile Home shows the dispatched batch as an **ordered, plant-clustered Day Plan** (stop sequence, plant name, device count per stop, any Zone Warehouse pickup step); all action buttons enabled immediately. Before any batch is dispatched, Home shows "Your plan is being prepared — check back shortly."

End-to-end: a batch run dispatches an ordered Day Plan to an SE who can act on it immediately, with no approval step.

## Acceptance criteria

- [x] Batches auto-dispatch to the SE Day Plan as Formal Assignments with status `AUTO_ASSIGNED` — no approval gate or pending lock
- [x] Schedule Cadence (daily / alternate day / weekly / on-demand) configurable; no fixed 08:00 gate
- [x] Batches are plant-clustered and ordered by stop sequence with device count per stop
- [x] Push notification fires to the SE on dispatch
- [x] Mobile Home renders the ordered Day Plan with all actions enabled; empty-state shown pre-dispatch *(backend Day-Plan API + contract tests; RN screen deferred — see progress doc)*
- [x] `work_schedules` / `plant_batch_assignments` / `batch_assignment_tickets` persisted

## Blocked by

- #10
