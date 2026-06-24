-- Issue 27, slice 2 — zone attribution on audit rows for the backup-cascade report. `acting_zone` is
-- stamped on acted-as (CSM/Ops backup) actions so Operations Head can see, per zone, how routine ZM
-- backup is becoming. Nullable + additive — existing rows and normal (non-acting) actions stay null.

ALTER TABLE "audit_logs" ADD COLUMN "acting_zone" BIGINT;
CREATE INDEX "audit_logs_acted_as_role_acting_zone_created_at_idx"
    ON "audit_logs"("acted_as_role", "acting_zone", "created_at");
