-- #286 — a crashed zone gets its day back (decision #282 R3, constrained by #258 Q8 + G1-G8).
--
-- #261 gave the reaper the power to free a dead run's zone claims and deliberately stopped there: "a
-- reaper that dispatched the zones it freed would be an unscheduled dispatch run at an arbitrary
-- minute of the day". Correct — but nothing else claimed the job either, so a run that dies at 05:02
-- leaves its zones freed and unasked-for until 05:00 tomorrow. The zone loses a whole field day.
--
-- This table is the seam between the two halves. The reaper still does not dispatch; it MARKS, and a
-- bounded collector re-dispatches marked zones through the ordinary admission path. The mark is a row
-- rather than a field on the process that noticed, because the event being recorded IS process death
-- (#258 Q8: recovery state must survive it).
--
-- One row per (zone, operating day), NOT one per crash. The attempt budget is per zone per day, so a
-- zone that crashes twice before lunch draws from one budget and cannot loop by crashing repeatedly.

CREATE TYPE "dispatch_recovery_state" AS ENUM ('PENDING', 'RECOVERED', 'EXHAUSTED', 'EXPIRED');

CREATE TABLE "dispatch_zone_recoveries" (
  "id"               BIGSERIAL PRIMARY KEY,
  "zone_id"          BIGINT NOT NULL REFERENCES "zones" ("zone_id") ON DELETE CASCADE,
  "business_date"    DATE NOT NULL,
  "state"            "dispatch_recovery_state" NOT NULL,
  "attempts"         INTEGER NOT NULL DEFAULT 0,
  "marked_at"        TIMESTAMPTZ(6) NOT NULL,
  "marked_by_run_id" BIGINT,
  "last_attempt_at"  TIMESTAMPTZ(6),
  "resolved_at"      TIMESTAMPTZ(6),
  "last_error"       TEXT
);

-- The upsert key. It is what makes the budget per zone per day rather than per crash.
CREATE UNIQUE INDEX "ux_dispatch_zone_recoveries_zone_day"
  ON "dispatch_zone_recoveries" ("zone_id", "business_date");

-- The collector's only read: today's outstanding marks. Partial, because PENDING is a vanishingly
-- small slice of this table's lifetime contents and the other states are never scanned for.
CREATE INDEX "dispatch_zone_recoveries_pending"
  ON "dispatch_zone_recoveries" ("business_date") WHERE "state" = 'PENDING';

COMMENT ON TABLE "dispatch_zone_recoveries" IS
  'Zones owed a same-day re-dispatch after the run holding them was reaped (#286). One row per (zone, operating day).';
COMMENT ON COLUMN "dispatch_zone_recoveries"."attempts" IS
  'Re-dispatch runs actually made for this zone today. A refusal (the zone was contended) is not an attempt — the bound on contention is the operating-day cutoff, not the budget.';
COMMENT ON COLUMN "dispatch_zone_recoveries"."marked_by_run_id" IS
  'The reaped run whose death produced this mark. Plain BIGINT, no FK: a run purge must not be able to rewrite the record of what was recovered.';
COMMENT ON COLUMN "dispatch_zone_recoveries"."state" IS
  'PENDING = owed. RECOVERED = re-dispatched. EXHAUSTED = the attempt budget is spent, and nothing further will be tried today. EXPIRED = the operating-day cutoff passed before it could be recovered.';
