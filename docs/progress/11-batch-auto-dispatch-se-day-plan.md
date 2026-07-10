# Progress — Issue 11: Batch auto-dispatch → SE Day Plan

> Build date: 2026-06-21 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **DONE**. All 6 acceptance criteria green. Backend **220 tests / 69 files**, `tsc --noEmit`
> clean (PostgreSQL 16 + PostGIS on :5433). Migrations: **18 applied**.

## Scope & decisions

Turns the Recommender's per-ticket `recommendations` (Issue 10) into a dispatched, plant-clustered
SE Day Plan (LLD §13.1 step 6, §3.6). Three HITL forks were resolved up front via `AskUserQuestion`:

1. **Stop ordering → deterministic, geo-ready seam.** Stops are ordered by the canonical processing
   rank of each plant's lead ticket (recommendations arrive in canonical order, so plant insertion
   order already encodes it). `orderPlantStops` is the documented seam that swaps to PostGIS
   route-distance when day-plan geo lands (Issue 14). Distance-from-previous-stop stays
   deferred-neutral (Issue 10).
2. **Mobile surface → backend API + contract tests.** Built `/api/schedules/me` (ordered,
   plant-clustered Day Plan payload + empty-state) with e2e contract tests. The React Native Day Plan
   screen is deferred to a mobile-focused issue; this keeps Issue 11 backend-only, matching the
   recommender/dispatch lineage.
3. **Dispatch trigger → invokable service method.** `BatchAssignmentService.dispatchForZone` is an
   invokable method (no cron) — same posture as `RecommenderService.runForZone`,
   `runAutoRecovery`, MV `refresh()`. The scheduler/BullMQ remains its own forthcoming work.

**No approval gate (ADR-0007/0019 superseded, Decision §7):** `work_schedules` has no
`DRAFT`/`PENDING_REVIEW`/`APPROVED`; batches dispatch directly as `AUTO_ASSIGNED`; the ZM overrides
post-hoc (`OVERRIDDEN`). The "Day Plan is live" push fires through a `DayPlanNotifier` seam because
the notification spine (Issue 03) isn't built yet.

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | Auto-dispatch as `AUTO_ASSIGNED`, no approval gate/pending lock | 🟢 | `dispatchForZone` → ACTIVE/SYSTEM_GENERATED schedule + AUTO_ASSIGNED batch; schema has no gate states. `batch-dispatch.e2e-spec.ts`, `scheduling-schema.e2e-spec.ts`. |
| 2 | Schedule Cadence configurable; no fixed 08:00 gate | 🟢 | Invokable method takes an arbitrary `dateFrom..dateTo` range (daily/alternate/weekly/on-demand); no cron. `batch-dispatch-cadence.e2e-spec.ts`. |
| 3 | Plant-clustered, ordered by stop sequence, device count per stop | 🟢 | `orderPlantStops` seam → deterministic `stop_sequence`; `deviceCount` in the Day-Plan payload. `batch-stop-order.e2e-spec.ts`, `day-plan-query.e2e-spec.ts`. |
| 4 | Push notification on dispatch | 🟢 | `DayPlanNotifier.dayPlanDispatched` fired once per SE schedule (seam; default logs). `batch-dispatch-notify.e2e-spec.ts`. |
| 5 | Ordered Day Plan rendered, actions enabled; empty-state pre-dispatch | 🟢 (backend) | `DayPlanQueryService.getDayPlan` + `GET /api/schedules/me` (ordered stops + empty-state, SE role-gated). `day-plan-query.e2e-spec.ts`, `schedules-controller.e2e-spec.ts`. **RN screen deferred.** |
| 6 | `work_schedules`/`plant_batch_assignments`/`batch_assignment_tickets` persisted | 🟢 | Migration `20260621180000_add_scheduling_dispatch` + models. `scheduling-schema.e2e-spec.ts`, `batch-dispatch.e2e-spec.ts`. |

## Slice-by-slice RED→GREEN report

- **Slice 1 — scheduling schema.**
  - RED: `scheduling-schema.e2e-spec.ts` (4 tests) — three tables/enums/FK chain/indexes/partial-unique absent.
  - GREEN: 3 enums (`work_schedule_status`/`schedule_source`/`batch_status`) + 3 models + migration `20260621180000_add_scheduling_dispatch` (FK chain + read indexes + `(ticket_id) WHERE removed_at IS NULL` partial-unique). `migrate deploy` + `generate`. 4/4.
- **Slice 2 — dispatch orchestrator.**
  - RED: `batch-dispatch.e2e-spec.ts` (3 tests) — `BatchAssignmentService` missing.
  - GREEN: `dispatchForZone` reads SUGGESTED recs per zone, groups SE→WorkSchedule (ACTIVE/SYSTEM_GENERATED/`dispatchedAt`), plant→PlantBatchAssignment (AUTO_ASSIGNED/`stopSequence`), tickets→BatchAssignmentTicket (`sortOrder`). `SchedulingModule` wired into `AppModule`. 3/3.
- **Slice 3 — deterministic stop ordering.**
  - RED: `batch-stop-order.e2e-spec.ts` (1 test) — multi-plant SE, higher-priority plant must be stop 1.
  - GREEN: passed on the slice-2 canonical insertion order; **REFACTOR** extracted the `orderPlantStops` seam (documented geo-swap hook). 1/1.
- **Slice 4 — "Day Plan is live" push.**
  - RED: `batch-dispatch-notify.e2e-spec.ts` (1 test) — `DayPlanNotifier` seam missing.
  - GREEN: `day-plan-notifier.ts` (interface + `DAY_PLAN_NOTIFIER` token + `LoggingDayPlanNotifier` default); dispatch fires one event per SE schedule; injected `@Optional()`. 1/1.
- **Slice 5 — SE Day Plan read model.**
  - RED: `day-plan-query.e2e-spec.ts` (2 tests) — `DayPlanQueryService` missing.
  - GREEN: `getDayPlan(seId)` → ordered, plant-clustered stops (stop seq, plant name, device count, tickets) + empty-state. 2/2.
- **Slice 6 — `/api/schedules/me` controller.**
  - RED: `schedules-controller.e2e-spec.ts` (3 tests) — endpoint 404.
  - GREEN: `SchedulesController` (`@Roles('SERVICE_ENGINEER')`, AuthGuard/RoleGuard), registered in `AppModule`. empty-state 200 / non-SE 403 / unauth 401. 3/3.
- **Slice 7 — Schedule Cadence.**
  - RED→GREEN: `batch-dispatch-cadence.e2e-spec.ts` (1 test) — a weekly `dateFrom..dateTo` range round-trips onto the schedule; ACTIVE immediately (no 08:00 gate). 1/1.

Test counts added by this issue: **+15 tests / +7 files** (backend 205→220 / 62→69).

## Deviations / deferred (read before extending)

1. **RN Day Plan screen deferred.** AC#5's backend (ordered payload + empty-state + role-gated
   endpoint) is done with contract tests; the Expo Day Plan home screen is a later mobile issue. A
   shared Day-Plan view type for the mobile client can be lifted from `DayPlanView` when that lands.
2. **Re-dispatch idempotency not handled.** `dispatchForZone` consumes SUGGESTED recs but does not
   flip their status, so a second run for the same zone would hit the `(ticket_id) WHERE removed_at
   IS NULL` partial-unique (a safety guard, not graceful regeneration). Graceful re-dispatch /
   supersede-prior-schedule is deferred — lands with the BatchAssignment scheduler (no cron yet).
   *(Note: dispatched tickets now also flip `ticket.assignment_state → FORMALLY_ASSIGNED`, so the
   recommender's `assignmentState: 'UNASSIGNED'` filter won't re-pick them on a subsequent run.)*

> **Update (Issue 12 retrofit, 2026-06-21):** `dispatchForZone` now sets each dispatched ticket's
> `assignment_state → FORMALLY_ASSIGNED` (schema D6 mandated this; Issue 11 originally missed it).
> This is what removes committed work from the SE Shared Pool (Issue 12). Regression coverage:
> `batch-dispatch.e2e-spec.ts` ("flips dispatched tickets to FORMALLY_ASSIGNED").
3. **Stop distance is deferred-neutral.** `orderPlantStops` orders by canonical lead-ticket rank;
   PostGIS route-distance ordering swaps in at Issue 14 (day-plan geo). No anchor point defined yet.
4. **Zone Warehouse pickup step (AC#5) not in the payload** — needs component/expected-component data
   from Issues 21/22; added to `DayPlanView` when that lands.
5. **Notification is a seam.** `LoggingDayPlanNotifier` is the default until the Issue 03 spine
   (push→SMS→WhatsApp→email) replaces it; the dispatch contract is final.

## How to run / verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run     # 220 green (PG16 + PostGIS on :5433)
# focused: node node_modules/vitest/vitest.mjs run test/scheduling-schema.e2e-spec.ts \
#   test/batch-dispatch.e2e-spec.ts test/batch-stop-order.e2e-spec.ts test/batch-dispatch-notify.e2e-spec.ts \
#   test/day-plan-query.e2e-spec.ts test/schedules-controller.e2e-spec.ts test/batch-dispatch-cadence.e2e-spec.ts
```
