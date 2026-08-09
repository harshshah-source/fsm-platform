-- Commissioning capture (feasibility assessment §7.2/§7.3). Two independent pieces:
--   1. `device_states.first_reported_at` -- the perishable one. Nothing in FSM stores a first-ever
--      ping: `latest_gps_datetime` is overwritten every tick and `raw_device_snapshots` is retained,
--      so every day this is not captured is a day of commissioning history that cannot be recovered.
--   2. `device_commissioning` -- an append-only fact, one row per (device, vehicle, installed_at).
--
-- REQUIRES POSTGRESQL 15 OR LATER, for `NULLS NOT DISTINCT` on the unique index below. On 14 and
-- earlier that clause is a SYNTAX ERROR and this migration fails immediately -- which is the
-- intended outcome. DO NOT "fix" such a failure by deleting the clause: without it, every row with
-- a NULL `installed_at` or `vehicle_id` (~20% of 2026 rows carry a NULL install date, and unmapped
-- fitments carry a NULL vehicle) re-inserts on EVERY daily sync, because NULL <> NULL. That is
-- unbounded silent duplication on a cron. The guard below turns the syntax error into a stated one.
--
-- TIMEZONE (settled by probe, 2026-08-09, and this is the load-bearing decision here):
-- `AUTOPLANT_UTC_OFFSET_MIN = 330` is wrong (#222) -- AutoPlant writes UTC into naive DATETIME
-- columns. Both timestamps below are therefore written at offset 0 -- the convention #222 will
-- adopt -- NOT at the ingest constant. A COALESCE column is written once and never revisited, so a
-- value frozen under the wrong constant would carry the 5.5h error permanently; inheriting the bug
-- "for consistency" would poison exactly the rows this table exists to measure. Writing in the
-- corrected convention means these columns are right on the day they are written and right after
-- #222 lands, with no correction pass for anyone to remember. Precedent for a second, differently-
-- offset timestamp on the same source row: `TRIP_CREATION_UTC_OFFSET_MIN = 0` in mapping.ts.
--
-- `FIRST_INSTALLED_DATE_TIME` is a MySQL DATETIME (naive), so its type alone proves nothing. It was
-- MEASURED against `device_installation_date` (a TIMESTAMP -> true UTC on read) in the same row:
-- 17,985 devices at exactly 0 minutes' difference, ZERO at +/-330, no step across 2025-2026.
-- The `*_offset_min` columns record what was applied per row, because the offset is runtime-
-- overridable (`AUTOPLANT_SOURCE_UTC_OFFSET_MIN`) -- the constant in source is not evidence of what
-- a given row got. Any future correction is then arithmetic, not archaeology.

DO $$
BEGIN
    IF current_setting('server_version_num')::int < 150000 THEN
        RAISE EXCEPTION
            'device_commissioning requires PostgreSQL 15+ (found %). It needs NULLS NOT DISTINCT; '
            'without it, NULL installed_at/vehicle_id rows duplicate on every sync. Upgrade rather '
            'than dropping the clause.', current_setting('server_version');
    END IF;
END
$$;

-- AlterTable
ALTER TABLE "device_states"
    ADD COLUMN "first_reported_at" TIMESTAMPTZ(6),
    ADD COLUMN "first_reported_offset_min" SMALLINT;

COMMENT ON COLUMN "device_states"."first_reported_at" IS
    'First GPS ping ever observed for this device, in TRUE UTC (offset 0, per #222''s corrected '
    'convention). Write-once: set by COALESCE in the SnapshotIngestionService upsert and never '
    'updated. NOTE: until #222 lands, latest_gps_datetime on the same row is still 5.5h early, so '
    'this column may read LATER than it -- correct, and self-healing when the constant flips. Do '
    'NOT add a first_reported_at <= latest_gps_datetime CHECK before then.';

COMMENT ON COLUMN "device_states"."first_reported_offset_min" IS
    'The source UTC offset applied when first_reported_at was frozen (expected 0). Recorded because '
    'AUTOPLANT_SOURCE_UTC_OFFSET_MIN is runtime-overridable, so the row must describe itself.';

-- CreateTable
-- Append-only by construction, not by convention: the UNIQUE below is the fitment identity and the
-- writer is INSERT .. ON CONFLICT DO NOTHING -- the same idiom `raw_device_snapshots` uses, where a
-- re-processed chunk is a no-op. There is no UPDATE path. A re-mapping changes vehicle_id (or
-- installed_at), which is a NEW identity, so it appends and the prior row is never touched.
CREATE TABLE "device_commissioning" (
    "commissioning_id" BIGSERIAL NOT NULL,
    "device_id" TEXT NOT NULL,
    "vehicle_id" BIGINT,
    "installed_at" TIMESTAMPTZ(6),
    "installed_at_offset_min" SMALLINT,
    "installed_by" TEXT,
    "installation_remark" TEXT,
    "plant_id" BIGINT,
    "company_id" BIGINT,
    "first_reported_at" TIMESTAMPTZ(6),
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "run_id" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_commissioning_pkey" PRIMARY KEY ("commissioning_id")
);

-- CreateIndex
--
-- ############################################################################################
-- ## STOP. `NULLS NOT DISTINCT` BELOW IS LOAD-BEARING. DO NOT LET `prisma migrate dev`      ##
-- ## AUTHOR A REPLACEMENT INDEX WITHOUT IT.                                                 ##
-- ############################################################################################
--
-- Prisma 7.8.0 has NO syntax for this modifier (`nullsNotDistinct:` is rejected as "No such
-- argument"), so `schema.prisma`'s `@@unique([deviceId, vehicleId, installedAt])` is NECESSARILY
-- WEAKER than this database object. That is a permanent, known divergence -- not drift to tidy up.
--
-- The consequence, stated plainly: `prisma migrate dev` compares the schema against the database,
-- SEES this index as different, and will helpfully offer a migration that DROPs and RECREATEs it
-- WITHOUT the clause. Accepting that prompt silently destroys append-only-ness. Under the default
-- NULLS DISTINCT, `NULL <> NULL`, so every row with a NULL `installed_at` (~13% of source rows) or
-- a NULL `vehicle_id` (every unmapped fitment) FAILS to conflict and RE-INSERTS on EVERY daily
-- sync -- unbounded silent growth on a cron, with no error, no failed run, and nothing in the
-- ledger to notice. The table stops being a fact and becomes a leak.
--
-- If you are here because migrate dev offered you that migration: DELETE the generated migration,
-- do not apply it. If the index must genuinely be rebuilt, hand-write the DDL with the clause and
-- keep it. If the working tree is ever reset, restore THIS file rather than regenerating it.
--
-- This is not guarded by comment alone -- `device-commissioning.e2e-spec.ts` asserts
-- `pg_index.indnullsnotdistinct = true` against the live database, so a regenerated index fails a
-- test instead of corrupting data. If you drop the clause, that test is the thing that will break;
-- fix the index, not the test.
--
-- (See also the PostgreSQL 15 guard at the top of this file, which is the OTHER way this clause
-- gets lost: on PG 14 and earlier it is a syntax error, and deleting it "to make it apply" is the
-- same mistake arrived at from the opposite direction.)
CREATE UNIQUE INDEX "device_commissioning_device_id_vehicle_id_installed_at_key"
    ON "device_commissioning"("device_id", "vehicle_id", "installed_at") NULLS NOT DISTINCT;

-- CreateIndex
CREATE INDEX "device_commissioning_device_id_observed_at_idx"
    ON "device_commissioning"("device_id", "observed_at" DESC);

-- CreateIndex
CREATE INDEX "device_commissioning_installed_at_idx"
    ON "device_commissioning"("installed_at" DESC);

COMMENT ON TABLE "device_commissioning" IS
    'Append-only commissioning fact: one row per (device, vehicle, installed_at), written by the '
    'master sync when a fitment is first seen or when installed_at / the vehicle changes. Immutable '
    'by design -- a re-mapping appends, it does not update, which is the whole reason this is a '
    'table and not columns on `devices`. Deliberately carries NO foreign keys, matching '
    '`master_sync_rejects`: a commissioning fact must still record for a device the mirror has not '
    'caught up on (see #227), and an FK violation inside the sync would be exactly the failure this '
    'write is required not to cause. KNOWN AND ACCEPTED TRADE-OFF: installation_remark is NOT part '
    'of the identity, so a remark-only change (e.g. New Installation -> Re-Mapping with the same '
    'device, vehicle and install date) does NOT append a row -- the stored remark stays as first '
    'observed. Including it would fragment fitment identity, which is worth more than tracking '
    'remark edits. If you need remark history, that is a new column in the key, not an UPDATE here.';
