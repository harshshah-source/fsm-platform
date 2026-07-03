-- Phase 2b — device identity BigInt → String (breaking; approved in prior review).
-- AutoPlant `tb_vehiclemaster.device_id` is varchar(255): real data has leading-zero IMEIs
-- (`0869925073271551`), alphanumeric vendor ids (`AP03TC0959`), and NULLs. A BigInt key silently
-- corrupts leading zeros and cannot store the rest, so the whole device spine moves to TEXT.
-- Greenfield (book data being retired, no prod rows) makes this low-risk; existing numeric ids cast
-- cleanly to their text form via `::text`.
--
-- device_id is the `devices` PK referenced by five FKs — Postgres forbids altering a column type while
-- a FK depends on it, so we drop the five FKs, retype the PK + the five child columns, then re-add the
-- FKs verbatim. The three device_id columns WITHOUT a FK to devices (raw_device_snapshots — RANGE
-- partitioned, verification_runs, device_downtime_summary_monthly — composite PK) are retyped directly;
-- Postgres rebuilds their partition/PK/unique/partial indexes automatically on the type change.

-- ── 1. Drop the five FKs that reference devices.device_id ─────────────────────────────────────────
ALTER TABLE "device_states"            DROP CONSTRAINT "device_states_device_id_fkey";
ALTER TABLE "failure_cycles"           DROP CONSTRAINT "failure_cycles_device_id_fkey";
ALTER TABLE "tickets"                  DROP CONSTRAINT "tickets_device_id_fkey";
ALTER TABLE "pgi_history"              DROP CONSTRAINT "pgi_history_device_id_fkey";
ALTER TABLE "non_operational_markings" DROP CONSTRAINT "non_operational_markings_device_id_fkey";

-- ── 2. Retype the PK column, then every referencing device_id column ──────────────────────────────
ALTER TABLE "devices"                  ALTER COLUMN "device_id" TYPE TEXT USING "device_id"::text;
ALTER TABLE "device_states"            ALTER COLUMN "device_id" TYPE TEXT USING "device_id"::text;
ALTER TABLE "failure_cycles"           ALTER COLUMN "device_id" TYPE TEXT USING "device_id"::text;
ALTER TABLE "tickets"                  ALTER COLUMN "device_id" TYPE TEXT USING "device_id"::text;
ALTER TABLE "pgi_history"              ALTER COLUMN "device_id" TYPE TEXT USING "device_id"::text;
ALTER TABLE "non_operational_markings" ALTER COLUMN "device_id" TYPE TEXT USING "device_id"::text;

-- ── 3. Re-add the five FKs, identical clauses to 20260620124718_add_device_ticket_spine ───────────
ALTER TABLE "device_states"            ADD CONSTRAINT "device_states_device_id_fkey"            FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "failure_cycles"           ADD CONSTRAINT "failure_cycles_device_id_fkey"           FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tickets"                  ADD CONSTRAINT "tickets_device_id_fkey"                  FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pgi_history"              ADD CONSTRAINT "pgi_history_device_id_fkey"              FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "non_operational_markings" ADD CONSTRAINT "non_operational_markings_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 4. The device_id columns with no FK to devices (retyped in place; indexes rebuilt automatically).
-- raw_device_snapshots is RANGE-partitioned by gps_datetime — the ALTER on the partitioned parent
-- cascades to every partition and rebuilds the UNIQUE(device_id, gps_datetime) + DESC index.
ALTER TABLE "raw_device_snapshots"           ALTER COLUMN "device_id" TYPE TEXT USING "device_id"::text;
ALTER TABLE "verification_runs"              ALTER COLUMN "device_id" TYPE TEXT USING "device_id"::text;
-- device_downtime_summary_monthly.device_id is part of the composite PK (device_id, month).
ALTER TABLE "device_downtime_summary_monthly" ALTER COLUMN "device_id" TYPE TEXT USING "device_id"::text;
