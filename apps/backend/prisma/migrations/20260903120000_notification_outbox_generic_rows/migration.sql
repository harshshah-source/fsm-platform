-- #338 — let the notification outbox carry general notices, not only day-plan events.
--
-- `day_plan_notification_outbox` was built by #264 for the two `DayPlanNotifier` events, and its
-- `se_id` / `schedule_id` columns are day-plan-shaped: a cross-zone decision notice, an install or
-- recovery notice, or a bulk-unassign notice belongs to no engineer's schedule. Those two NOT NULLs
-- are the only reason the other twelve `notify()` sites could not use the durable path and had to
-- fire post-commit, where a crash loses them.
--
-- Relaxing them is additive and reversible: every existing row keeps its values, both day-plan
-- writers still supply them, and the drain switches on `event_type` (now also 'NOTIFY') exactly as
-- it already did. The table is deliberately NOT renamed — `notification_outbox` would be the honest
-- name, but the rename churns every call site and its tests for no behavioural gain, against an
-- acceptance criterion that says the day-plan events keep theirs.

ALTER TABLE "day_plan_notification_outbox" ALTER COLUMN "se_id" DROP NOT NULL;
ALTER TABLE "day_plan_notification_outbox" ALTER COLUMN "schedule_id" DROP NOT NULL;
