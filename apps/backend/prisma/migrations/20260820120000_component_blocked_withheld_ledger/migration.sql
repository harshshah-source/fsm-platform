-- #177 AC-3 — count the component-blocked work the automatic pools now decline to hand out.
--
-- A ticket whose failure cycle is WAITING_COMPONENT stays OPEN by design (ADR-0008): the failure is
-- real, the part is on order, and the ticket waits for it. Until this issue the recommender's
-- selection looked at `work_type + status + assignment_state + deferral` and never at the cycle, so
-- the moment such a ticket was also UNASSIGNED it was dispatched like any other — the SE drove out,
-- could not finish, and resubmitted `component_unavailable` on site, opening a SECOND live
-- `component_request` (that table's only unique is `submission_id`).
--
-- Excluding it fixes the visit and creates a reporting duty. Before, the ticket at least appeared on
-- the run as a recommendation; excluded and uncounted it would appear nowhere, while the plant still
-- has work nobody is going to. That is quieter than the bug and no more honest, so the exclusion is
-- counted at the point it happens.
--
-- Kept apart from both columns beside it, because the three name different people's problems:
--   `unassignable`             — the engine looked and found nobody. Ops: a coverage or capacity gap.
--   `withheld_below_threshold` — it deliberately did not look yet (#238). Nobody: policy working.
--   `component_blocked_withheld` — it will not look until a part arrives. The warehouse's clock.
-- Folding this into the first would file every part-on-order into the coverage-gap queue and make a
-- supplier delay read as a dispatch outage.
--
-- NULLABLE, following #242's `bucketless_dropped` rather than #238's `withheld_below_threshold`.
-- #238's column defaults to 0 honestly, because a run predating its gate genuinely withheld nothing.
-- This population was being DISPATCHED all along, not withheld, so 0 on a historical row would assert
-- a measurement nobody took. NULL reads as "not recorded"; every run from here on carries a number.
ALTER TABLE "dispatch_runs"
  ADD COLUMN "component_blocked_withheld" INTEGER;

ALTER TABLE "dispatch_run_zones"
  ADD COLUMN "component_blocked_withheld" INTEGER;
