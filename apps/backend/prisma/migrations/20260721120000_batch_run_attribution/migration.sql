-- Same-day re-run now APPENDS new work onto an SE's existing ACTIVE (se, zone, day) schedule instead
-- of creating a colliding one (which used to P2002 and roll back the whole zone, dropping every fresh
-- recommendation). A WorkSchedule can therefore span more than one dispatch run, so run-attribution of
-- dispatched work moves DOWN to the batch: each plant_batch_assignment is stamped with the run that
-- created it. Nullable + FK SET NULL, mirroring work_schedules.run_id. Pre-existing batches stay NULL —
-- their owning run is the (unshared) schedule's run_id, which the transparency read falls back to.
ALTER TABLE "plant_batch_assignments" ADD COLUMN "run_id" BIGINT;

ALTER TABLE "plant_batch_assignments"
  ADD CONSTRAINT "plant_batch_assignments_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "dispatch_runs"("run_id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "plant_batch_assignments_run_id_idx" ON "plant_batch_assignments"("run_id");
