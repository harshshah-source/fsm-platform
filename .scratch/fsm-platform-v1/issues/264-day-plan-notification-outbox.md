# 264 — Durable day-plan notification outbox (executes #189)

Status: ready-for-agent
Type: AFK · Backend
Decision: #258 Part 7 (G5, G7). This is #189's build issue under the ratified decision; #189 stays
as the defect record and is marked superseded-by-#264.

## Objective

A committed dispatch can never lose its "Day Plan is live" notification to a crash, and a
notification failure can never make a successful dispatch look failed.

## Current behaviour

- Events buffer in a process-local array inside the dispatch tx (`batch-assignment.service.ts:58`,
  pushed `:189`) and fire post-commit (`:234-236`). Crash between commit and the loop = silent
  permanent loss (re-run is a no-op: recs already DISPATCHED).
- A notifier THROW propagates out of `dispatchForZone` after commit, so `dispatch-run.service.ts:278-282`
  records a zone error for a zone that actually dispatched — the sharpest observability inversion
  in the engine.
- The spine notifier (`day-plan-notifier.ts:57-78`) writes real notification rows now, raising the
  stakes vs. when #189 was filed. Override/same-day notifier calls share the fragility
  (`override.service.ts` post-tx `dayPlanOverridden` calls).

## Required change

1. `day_plan_notification_outbox` table: `(id, event_type, se_id, schedule_id, zone_id, payload
   JSONB, created_at, sent_at NULL, attempts INT, last_error TEXT NULL)`.
2. Dispatch writes outbox rows **inside** each per-SE transaction (#262) — the intent commits with
   the plan or not at all. Override/`assignTicket`/same-day paths write their `dayPlanOverridden`
   intents inside their existing `withAudit` transactions.
3. Post-commit drain: immediately after commit, attempt delivery for the rows just written; success
   stamps `sent_at`. Any delivery exception is caught, stamped on the row, and NEVER propagates
   into dispatch/override outcomes.
4. Re-drain sweep: a `business-notification-outbox` tick (reuse `runGuarded`, gated by
   `BUSINESS_SWEEPS_ENABLED`, minute-cadence family, unpinned tz — it is not a wall-clock job)
   retries unsent rows with bounded `attempts`; exhausted rows stay visible (`last_error`).
5. `scheduler-wiring.e2e-spec.ts` pin goes 18 → 19 — update deliberately.

## Existing code to reuse

`SpineDayPlanNotifier` (delivery target, unchanged); `NotificationService` spine honesty
(ATTEMPTED-not-SENT); `runGuarded`; #262's per-SE tx boundaries.

## Data model

Outbox table + index on `(sent_at) WHERE sent_at IS NULL`. Retention: prune sent rows >30 days via
the partition-maintenance daily tick (append-only-with-retention posture, #104 family).

## API / UI surfaces

None required. Mobile: n/a. (Build-health/ops surfacing of stuck outbox rows may ride #148 slice 3.)

## Acceptance criteria

- [ ] Kill between commit and drain (simulated: write rows, skip drain): the sweep delivers; the SE
      notification exists exactly once.
- [ ] A notifier that throws: dispatch summary and zone row stay SUCCESS; the outbox row carries
      the error; the run ledger shows no zone error (kills the misreport inversion).
- [ ] Rolled-back SE tx leaves no outbox row (no ghost "plan is live").
- [ ] Duplicate drain (sweep racing post-commit drain) delivers once — guard the send with a
      conditional `sent_at IS NULL` claim update, the `transitionOrConflict` idiom.
- [ ] **`dayPlanOverridden` is covered too**: a ZM override/assign/same-day update writes its
      notification intent inside the existing `withAudit` transaction (`override.service.ts`), and a
      notifier throw on that path leaves the override committed and successful — these calls share
      the dispatch path's post-commit fragility and must not be left on the old mechanism.

## Tests

e2e: outbox-crash spec, notifier-throw spec, drain-race spec; update `dispatch-*` specs that assert
notifier calls.

## Dependencies / Blocked by

#262 (per-SE tx is where intents are written). Can be built against the zone tx if #262 slips, but
do not ship the sweep before intents are transactional.

## Risks

Cron-count pin churn; retention growth if the sweep is disabled while dispatch runs (bounded by
prune).

## Rollback

Additive table; disabling the sweep + reverting write sites restores today's behaviour.
