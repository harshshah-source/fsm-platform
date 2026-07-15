-- Deletion posture for the dispatch-transparency ledger (#104 retention runs these deletes):
--   * deleting a dispatch_run (400d window) must never be blocked by — or destroy — operational
--     rows: recommendations.run_id / work_schedules.run_id detach via SET NULL;
--   * dispatch_run_zones are pure children of the ledger row → CASCADE;
--   * a decision trace is a 1:1 appendage of its recommendation (same 90d window) → CASCADE,
--     so the existing recommendations purge needs no reordering.

ALTER TABLE "recommendations"
  DROP CONSTRAINT "recommendations_run_id_fkey",
  ADD CONSTRAINT "recommendations_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "dispatch_runs"("run_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "work_schedules"
  DROP CONSTRAINT "work_schedules_run_id_fkey",
  ADD CONSTRAINT "work_schedules_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "dispatch_runs"("run_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "dispatch_run_zones"
  DROP CONSTRAINT "dispatch_run_zones_run_id_fkey",
  ADD CONSTRAINT "dispatch_run_zones_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "dispatch_runs"("run_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dispatch_decision_traces"
  DROP CONSTRAINT "dispatch_decision_traces_recommendation_id_fkey",
  ADD CONSTRAINT "dispatch_decision_traces_recommendation_id_fkey"
    FOREIGN KEY ("recommendation_id") REFERENCES "recommendations"("recommendation_id") ON DELETE CASCADE ON UPDATE CASCADE;
