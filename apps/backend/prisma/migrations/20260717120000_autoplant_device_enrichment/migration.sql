-- AutoPlant enrichment columns (IMSI No / Trip Creation Date Time), split by LIFECYCLE across the two
-- ingestion pipelines that already exist. Both are additive + nullable, so every existing row, read and
-- write keeps working untouched.
--
--   devices.imsi_no                    ← master sync (daily). `tb_vehiclemaster.IMSI_NO` is the fitted
--                                        SIM's subscriber identity — identity data that moves only on a
--                                        SIM swap, so the daily master tick is the right cadence.
--                                        (`devices.device_type` already exists; this migration does not
--                                        touch it — its NULLs are fixed in the source read, not here.)
--
--   device_states.trip_creation_datetime ← snapshot/telemetry path (every 30 min). Measured on the live
--                                        source 2026-07-17: 2,614 of 14,205 DEPLOYED vehicles (18.4%)
--                                        change it per DAY and it tracks `active_trip_id`, vs 0.2%/day
--                                        for a genuine fitment attribute (device_installation_date).
--                                        It is current-trip state, so it belongs on the hot device_states
--                                        row next to latest_gps_datetime — a daily master sync would
--                                        leave ~2,600 vehicles/day stale.

ALTER TABLE "devices" ADD COLUMN "imsi_no" TEXT;

ALTER TABLE "device_states" ADD COLUMN "trip_creation_datetime" TIMESTAMPTZ(6);
