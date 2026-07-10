# Progress — Issue 13a: ZM Monitoring & Override engine + API

> Build date: 2026-06-21 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **DONE**. All 6 acceptance criteria green. Backend **253 tests / 81 files**, `tsc --noEmit`
> clean (PostgreSQL 16 + PostGIS on :5433). No migration (override fields already on the Issue 11
> tables; audit via existing `audit_logs`).

## Scope & decisions

Issue 13 was **split** (HITL-confirmed) into **13a** (this issue — backend override engine + API +
contract tests) and **13b** (the React admin ZM monitoring/override UI; `13b-...` in the backlog).
The monitoring/override surface is **monitoring + override only, no approval gate** (ADR-0007/0019
superseded). Three forks resolved up front:

1. **ON_SITE conflict → seam, default no-conflict.** `soft_states` lands in Issue 15, so the conflict
   check runs through a `SoftStateConflictPort` that reports no active ON_SITE until then. The
   conflict + confirm + `OVERRIDE_AFTER_ON_SITE` audit logic is real and unit-tested by injecting a
   fake that reports a held ON_SITE.
2. **All six override actions** built this pass (Swap SE / Split Batch / Remove Ticket / Reorder /
   Defer Ticket / Reassign) — they share one endpoint, the OVERRIDDEN-flip, audit, and push path.
3. **Backend engine + API + contract tests**; the admin UI is 13b.

No new tables: the override fields (`status=OVERRIDDEN`, `override_reason`, `last_overridden_by/at`,
`removed_at/by`, `deferred_to_date`, `stop_sequence`, `sort_order`) already exist from Issue 11, and
audit uses `AuditService.withAudit` (in-transaction) over the existing `audit_logs`.

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | `GET /api/schedules` per-SE rows, status badges, no approval/countdown | 🟢 | `ZmScheduleQueryService.listSchedules` (batch/ticket counts, zone-scoped). `zm-schedule-query.e2e-spec.ts`, `zm-schedules-controller.e2e-spec.ts`. |
| 2 | `GET /api/schedules/:engineerId` ordered stops + "Why suggested?" reasoning | 🟢 | `getScheduleDetail` (stops + per-ticket recommendation reasoning: tier/bucket/rank/clusterMultiplier). same specs. |
| 3 | Six override actions commit immediately, flip OVERRIDDEN | 🟢 | `OverrideService` REMOVE/DEFER/REORDER/SWAP_SE/REASSIGN/SPLIT_BATCH. `batch-override-remove`, `batch-override-defer-reorder`, `batch-override-swap-split` specs. |
| 4 | Override propagates to the SE Day Plan + fires a push | 🟢 | Moves re-point the batch onto the target SE's schedule (Day Plan reads by `schedule.se_id`); `DayPlanNotifier.dayPlanOverridden` fires. override specs. |
| 5 | ON_SITE → conflict + confirm + mandatory reason (audited `OVERRIDE_AFTER_ON_SITE`) | 🟢 | `SoftStateConflictPort` gate; `CONFLICT_ON_SITE` (no mutation) without confirm; confirm proceeds + writes `OVERRIDE_AFTER_ON_SITE`. `batch-override-onsite.e2e-spec.ts`. |
| 6 | Critical-queue one-click assign creates a Formal Assignment | 🟢 | `OverrideService.assignTicket` + `POST /api/schedules/assign` (ensures schedule+batch, flips FORMALLY_ASSIGNED). `critical-assign.e2e-spec.ts`. |

## Slice-by-slice RED→GREEN report

- **Slice 1 — ZM monitoring reads.** `ZmScheduleQueryService` (list + detail w/ reasoning, zone-scoped)
  + `GET /api/schedules` & `GET /api/schedules/:engineerId` on `SchedulesController`.
  `zm-schedule-query.e2e-spec.ts` (3), `zm-schedules-controller.e2e-spec.ts` (initial 4).
- **Slice 2 — override engine + REMOVE_TICKET.** `OverrideService` + `POST /api/batches/:id/override`
  (`BatchesController`); REMOVE marks removed, returns ticket to UNASSIGNED, flips OVERRIDDEN, audits,
  pushes. Extended `DayPlanNotifier` with `dayPlanOverridden`. `batch-override-remove` (4), `batches-controller` (3).
- **Slice 3 — DEFER_TICKET + REORDER.** Defer stamps `deferred_to_date`; reorder re-sequences stops.
  `batch-override-defer-reorder` (2).
- **Slice 4 — SWAP_SE / REASSIGN / SPLIT_BATCH.** Shared `ensureSchedule` + `moveTickets`: work moves
  onto the target SE's (ZM_MANUAL) schedule; source flips OVERRIDDEN; tickets stay FORMALLY_ASSIGNED.
  `batch-override-swap-split` (3).
- **Slice 5 — ON_SITE conflict seam.** `SoftStateConflictPort` + `CONFLICT_ON_SITE` outcome (→ 409) +
  `OVERRIDE_AFTER_ON_SITE` audit on confirm. `batch-override-onsite` (2).
- **Slice 6 — critical-queue assign.** `assignTicket` + `POST /api/schedules/assign`.
  `critical-assign` (2) + 2 controller tests.

Test counts added by this issue: **+25 tests / +8 files** (backend 228→253 / 73→81).

## Deviations / deferred (read before extending)

1. **Admin UI is Issue 13b** — all ACs here are backend + contract tests; the React monitoring/override
   pages (list/detail, override controls, drag-reorder, conflict banner, wiring the inert
   `CriticalQueue` Assign button) are tracked separately.
2. **ON_SITE conflict is a seam** — `NoConflictSoftStatePort` until Issue 15 wires `soft_states`; the
   adapter swaps in without touching the engine. Conflict/confirm/audit logic is final and tested.
3. **REORDER is per-batch** — sets this batch's `stop_sequence` and renumbers the schedule's stops;
   the LLD endpoint is batch-scoped (`POST /api/batches/:id/override`). A full drag-reorder payload is
   a UI concern (13b).
4. **DEFER does not yet drop the ticket from the current Day Plan view** — it stamps
   `deferred_to_date` + OVERRIDDEN; day-plan filtering by deferred date is a small follow-up.
5. **Push is the same `DayPlanNotifier` seam** (logging default) until the Issue 03 notification spine.

## How to run / verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run     # 253 green (PG16 + PostGIS on :5433)
# focused: node node_modules/vitest/vitest.mjs run test/zm-schedule-query.e2e-spec.ts \
#   test/zm-schedules-controller.e2e-spec.ts test/batches-controller.e2e-spec.ts \
#   test/batch-override-remove.e2e-spec.ts test/batch-override-defer-reorder.e2e-spec.ts \
#   test/batch-override-swap-split.e2e-spec.ts test/batch-override-onsite.e2e-spec.ts \
#   test/critical-assign.e2e-spec.ts
```
