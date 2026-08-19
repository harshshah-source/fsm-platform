-- #242 AC-5 — count the population the recommender has always dropped in silence.
--
-- `runForZone` ranks with the canonical sort, which needs an SLA bucket, so it drops every candidate
-- whose `device_states.sla_bucket` is NULL (or whose device has no state row at all) BEFORE any
-- decision is taken: no recommendation, no UNASSIGNABLE row, no decision trace, no ledger figure. On
-- the run report those tickets do not exist — neither dispatched, nor unassignable, nor withheld.
--
-- #242's recycling makes that blind spot grow instead of sitting still: an unworked ticket now returns
-- to UNASSIGNED every night, so one whose device state stops being computed cycles back into the gap
-- indefinitely. Recycling volume is counted (`ScheduleClosureOutcome.recycled`); the exposure it grows
-- has to be counted beside it.
--
-- Kept apart from `unassignable` for #238's reason: unassignable means the engine looked and found
-- nobody (an Ops coverage/capacity failure); this means the engine never looked (a data failure — an
-- un-recomputed device state). Two different queues, and folding them together would send the wrong
-- team.
--
-- NULLABLE, unlike `withheld_below_threshold`. That column defaults to 0 honestly, because a run
-- predating #238's gate genuinely withheld nothing. This drop has been happening all along and simply
-- went unmeasured, so 0 on a historical row would assert something nobody counted. NULL means "not
-- recorded"; every run from here on carries a number.
ALTER TABLE "dispatch_runs"
  ADD COLUMN "bucketless_dropped" INTEGER;

ALTER TABLE "dispatch_run_zones"
  ADD COLUMN "bucketless_dropped" INTEGER;
