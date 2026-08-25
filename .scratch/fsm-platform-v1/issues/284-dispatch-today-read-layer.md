# 284 — The thin read layer the cockpit needs: today, changes-today, decision stream

Status: **done** (2026-08-25) — §A/§B in [`docs/progress/284-285-dispatch-today-cockpit.md`](../../../docs/progress/284-285-dispatch-today-cockpit.md), §C/§D in [`docs/progress/284-decision-stream-and-date-filter.md`](../../../docs/progress/284-decision-stream-and-date-filter.md)
Type: AFK · Backend
Decision: [#282](./282-decision-todays-dispatch-crew-deck.md) R1/R5/R6 — compose existing services;
no duplicate domain representation, no scheduler logic in React.
Evidence: [`audit/scheduler-engine-forensics-2026-08-25.md`](../../../audit/scheduler-engine-forensics-2026-08-25.md) §D/§G.

## Objective

Three reads that do not exist, each assembled from services that already do. **Nothing here computes
a scheduling decision** — it reports what the engine already decided and what humans already did.

## Current behaviour (verified)

- **There is no operating-day read.** `GET /schedules` (`zm-schedule-query.service.ts:98-110`)
  filters on `LIVE_SCHEDULE_STATUSES` and **has no date predicate at all**, so it mixes today's plans
  with stale never-closed ones — while nav, page copy and `DispatchTimelineNote` all promise "today".
  `DayPlanQueryService.getDayPlan` (`day-plan-query.service.ts:37`) *does* carry
  `dateFrom <= today <= dateTo` and its docstring says so — but it is per-engineer and SE-facing.
- **The changes-today ledger reads an action no UI writes.** `listIntradayUpdates`
  (`same-day-update.service.ts:104-106`) selects `audit_logs WHERE action='MANUAL_ZM_UPDATE'`, written
  only by `POST /intraday-updates/*` — which **no admin code calls**. Real overrides audit as
  `BATCH_OVERRIDE_*` (`override.service.ts:1044`) and never appear. Neither that query nor
  `IntradayInsertionService.listForScope` (`:440`) is date-bounded or limited.
- **Replay has no run-level read.** Per-ticket trace exists
  (`GET /dispatch-runs/:runId/tickets/:ticketId/trace`); nothing returns a run's decisions in the
  order the engine made them, though `recommendations.processing_rank` persists exactly that.

## Required change

### A. `GET /dispatch/today?zoneId=` — the cockpit's one read

Composed, not re-implemented, from: `ZmScheduleQueryService.listSchedules`/`getScheduleDetail`
(stops already ordered `stopSequence asc` / `sortOrder asc`, hollow stops already dropped),
`committedDayPlan` (**one batched query for all engineers** — never per-engineer),
`listZoneEngineers`, `DispatchTransparencyQueryService` for the current run's unassignable rows,
`SchedulerPreviewService.holdsInForce`'s predicate, `IntradayInsertionService.listForScope`
filtered to `ESCALATION_REQUIRED`, and `istDate` for the operating day.

Returns: `{ operatingDay, zone, run: {runId, status, trigger, startedAt, finishedAt} | null,
engineers: [{ seId, name, coverageType, committed, dailyCapacity, availability, stops: [{ batchId,
stopSequence, plantId, plantName, status, tickets: [{ ticketId, sortOrder, slaBucket, companyTier,
addSource, addedBy, coverageAtAssign, returnDueToday }] }] }], situation: { placed, unassignable,
held, criticalNeedsYou, overCapacity, changesToday }, rails: { unassignable[], held[],
policyWithheld: {count, itemised: false} }, escalations[] }`.

**The day predicate is `dateFrom <= day <= dateTo`** — the `DayPlanQueryService` rule, not
`LIVE_SCHEDULE_STATUSES` alone. An engineer with no plan today appears with `stops: []`, because an
empty lane is a fact the deck must show, not a row to omit.

### B. `GET /dispatch/changes-today?zoneId=`

IST-day-bounded (`istDayStartInstant` for the `removed_at` timestamptz, `istDate` for date columns),
zone-scoped, returning `{ adds[], removes[], swaps[], counts }`. **After #283 this is a single-table
read** over `batch_assignment_tickets` — `added_by`/`add_source`/`add_reason` on one leg,
`removed_by`/`removal_reason` on the other — instead of a three-way UNION across free-shape JSONB.
A swap is one `REASSIGNED` removal paired with its `MANUAL_REASSIGN` add on the same ticket inside
the window; pair them so a swap is not double-counted as an add plus a remove.

### C. `GET /dispatch-runs/:runId/decisions?zoneId=` — Replay's stream

`recommendations` + `dispatch_decision_traces` for the run, **ordered by `processing_rank`** — the
engine's own processing order, which is what makes this Replay and not a report. Paginated.
No new storage (#282 open-question 2 — full-input snapshotting is not a v1 goal).

### D. Date filter on `GET /schedules`

`?date=YYYY-MM-DD`, defaulting to today, with an explicit opt-out for the current all-live behaviour.
Makes the page's own label true. `istWindowStart` + the existing `INVALID_DATE` error shape.

## Existing code to reuse

Everything named above, plus: `resolveManagerScope`/`@CurrentScope()` for acting-zone-aware clamping
(the newer standard — **not** `schedules.controller.ts`'s local `scopeFor`), `ZoneScopeGuard` for the
`zoneId` query param, `dashboard.controller.ts` as the read-controller model (hand-rolled param
validation throwing `{ code, hint }`, no class-validator DTOs), and the bigints-as-strings convention.

## Explicitly NOT in scope

No new scheduling computation. No recomputation of eligibility, capacity or tier for display — every
number is either persisted or produced by the existing shared function. Policy-withheld stays a
**count** and says so in the payload (`itemised: false`); itemising it is a real backend change and is
deferred, not faked (#282 R6).

## Acceptance criteria

- [x] AC1 — `GET /dispatch/today` returns the shape above for a zone, with stops in persisted order
      and **no fabricated times or ETAs** anywhere in the payload (#258 Q6).
- [x] AC2 — The operating day is the IST day; a plan whose `dateFrom..dateTo` does not cover today is
      absent, and a stale never-closed plan from last week does **not** appear (the `/schedules` bug,
      pinned so the cockpit cannot inherit it).
- [x] AC3 — An engineer with no plan today appears with `stops: []`.
- [x] AC4 — Capacity comes from `committedDayPlan` in **one** query for the whole zone; a spec asserts
      the endpoint's per-engineer `committed` equals `GET /schedules/engineers` engineer-for-engineer
      (one definition, #269/#272 R9).
- [x] AC5 — ZM is zone-clamped server-side; a ZM cannot read another zone (403/empty per the existing
      convention), and acting-zone is honoured.
- [x] AC6 — `changes-today` reports a ZM override made through `POST /batches/:id/override` — the case
      the current Intra-day Queue structurally cannot see. Pinned as a regression.
- [x] AC7 — `changes-today` is IST-day-bounded: yesterday's identical change is absent.
- [x] AC8 — A swap counts once as a swap, not as one add plus one remove.
- [x] AC9 — The decision stream returns a run's decisions in `processing_rank` order, zone-clamped.
- [x] AC10 — `GET /schedules?date=` filters; the existing no-param behaviour is preserved for callers
      that depend on it, and the change is additive.
      **Note on the §D prose:** the Required-change text says "defaulting to today"; this AC says the
      no-param behaviour is preserved. The AC governs — a today default would silently narrow every
      existing caller. The *page* passes the parameter (and defaults to today, operator-ruled
      2026-08-25, with an `All live plans` toggle so a never-closed plan stays findable).
- [x] AC11 — Full backend suite green; no existing endpoint's response shape changes.
