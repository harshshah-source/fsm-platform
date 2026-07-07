-- Issue 100 — Recommender → Day-Plan dispatch idempotency backstops.
-- Two partial-UNIQUE indexes (raw SQL — partial uniques are not expressible in the Prisma schema, same
-- posture as snapshot_runs_one_in_flight / batch_assignment_tickets_one_active_per_ticket). These are
-- the durable, cross-connection guard behind the per-zone advisory lock + the SUGGESTED→DISPATCHED
-- consume step: even if the lock is bypassed (a second process, a bug), a ticket cannot be dispatched
-- twice.

-- At most one LIVE suggestion per ticket. Two concurrent recommender runs (or a retry) that both
-- suggest the same still-OPEN/UNASSIGNED ticket → the loser hits this index instead of writing a
-- duplicate SUGGESTED row (which would otherwise let dispatch place the same ticket twice).
CREATE UNIQUE INDEX "recommendations_one_suggested_per_ticket"
  ON "recommendations" ("ticket_id") WHERE "status" = 'SUGGESTED';

-- One ACTIVE day-plan per SE per zone per day. zone_id is IN the key deliberately: a floating SE may
-- legitimately hold a plan in more than one zone on the same day (dispatch runs per zone; cross-zone
-- approve assigns a target-zone SE into the ticket's home zone). The constraint is therefore
-- per-(SE, zone, day) — NOT per-(SE, day) — so two concurrent dispatches of the SAME zone collide
-- (the intended backstop) while cross-zone / floating day-plans are allowed.
CREATE UNIQUE INDEX "work_schedules_one_active_per_se_zone_day"
  ON "work_schedules" ("se_id", "zone_id", "date_from") WHERE "status" = 'ACTIVE';
