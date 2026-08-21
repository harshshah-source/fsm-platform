-- #259 — the dispatch zone claim. Run admission stops being an in-process `Map` and becomes a row.
--
-- Before this, `dispatch_run_zones` rows were written only at zone COMPLETION, and admission was
-- guarded by a private field on the `DispatchRunService` singleton (#213). That guard dies with the
-- process and is invisible to a second instance, so the "clear answer" an operator gets when they
-- press the button twice was only ever true within one process. The row below IS the claim: opened
-- RUNNING at admission, finalized DONE/ERROR where the completion row used to be created, so a
-- refusal is durable, cross-connection and survives a restart.

CREATE TYPE "dispatch_zone_claim_status" AS ENUM ('RUNNING', 'DONE', 'ERROR', 'CONTENDED');

ALTER TABLE "dispatch_run_zones"
  ADD COLUMN "status" "dispatch_zone_claim_status",
  -- The run that held the zone when this run was refused it. A historical breadcrumb, deliberately
  -- NOT a foreign key: the #104 retention matrix purges old runs, and a purge would either cascade
  -- this refusal away or null it, neither of which improves the record of what happened.
  ADD COLUMN "contended_with_run_id" BIGINT;

-- Every historical row was written at completion, so it is terminal by construction: `error IS NULL`
-- is precisely the DONE/ERROR discriminator the finalizer will keep using.
UPDATE "dispatch_run_zones"
   SET "status" = (CASE WHEN "error" IS NULL THEN 'DONE' ELSE 'ERROR' END)::"dispatch_zone_claim_status";

-- No DEFAULT: there is no honest one. A claim starts RUNNING and a completion row starts DONE, so a
-- default would let a future writer omit the one field that says which of the two it wrote.
ALTER TABLE "dispatch_run_zones" ALTER COLUMN "status" SET NOT NULL;

-- The admission itself (#258 Q8.4). Raw SQL because partial uniques are not expressible in the
-- Prisma schema — same posture as the #100 backstops (`recommendations_one_suggested_per_ticket`,
-- `work_schedules_one_active_per_se_zone_day`). This is what makes `INSERT ... ON CONFLICT DO
-- NOTHING` a correct admission test: at most one run may hold a zone at a time, decided by the
-- database rather than by whichever process asked first.
CREATE UNIQUE INDEX "ux_dispatch_run_zones_one_running_per_zone"
  ON "dispatch_run_zones" ("zone_id") WHERE "status" = 'RUNNING';
