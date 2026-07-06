-- R3 — real daily partitioning + retention for raw_device_snapshots.
--
-- The original migration (20260619153000) declared `PARTITION BY RANGE (gps_datetime)` but created only
-- the DEFAULT partition, so all telemetry landed in one unbounded heap. This converts that DEFAULT into
-- real per-UTC-day partitions (so retention can drop at day granularity) and keeps an empty DEFAULT as a
-- clock-skew safety net. Done while the table is small; splitting a populated DEFAULT later is a locked
-- rewrite. Ongoing create-ahead + retention (default 7 days, `system_settings.telemetry_retention_days`)
-- is owned by PartitionMaintenanceService; this migration only establishes the initial partition set.
--
-- Partition names/bounds match the service exactly: `raw_device_snapshots_yYYYYmMMdDD`, half-open UTC
-- ranges `['<day> 00:00:00+00', '<day+1> 00:00:00+00')`.

DO $$
DECLARE
  d          date;
  min_d      date;
  max_d      date;
  today_utc  date := (now() AT TIME ZONE 'UTC')::date;
  part_name  text;
BEGIN
  -- Detach the catch-all default so real daily partitions can be created over its range (Postgres
  -- refuses to create a partition whose range overlaps rows still held by an attached DEFAULT).
  ALTER TABLE raw_device_snapshots DETACH PARTITION raw_device_snapshots_default;

  SELECT MIN(gps_datetime AT TIME ZONE 'UTC')::date,
         MAX(gps_datetime AT TIME ZONE 'UTC')::date
    INTO min_d, max_d
    FROM raw_device_snapshots_default;

  IF min_d IS NULL THEN
    -- No existing telemetry: seed a small window around today so ingestion never hits DEFAULT.
    min_d := today_utc;
    max_d := today_utc + 3;
  ELSE
    max_d := GREATEST(max_d, today_utc) + 3;
  END IF;

  d := min_d;
  WHILE d <= max_d LOOP
    part_name := format('raw_device_snapshots_y%sm%sd%s',
                        to_char(d, 'YYYY'), to_char(d, 'MM'), to_char(d, 'DD'));
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF raw_device_snapshots FOR VALUES FROM (%L) TO (%L)',
      part_name,
      to_char(d,     'YYYY-MM-DD') || ' 00:00:00+00',
      to_char(d + 1, 'YYYY-MM-DD') || ' 00:00:00+00');
    d := d + 1;
  END LOOP;

  -- Drain any rows the old default held into the now-existing daily partitions (idempotent).
  INSERT INTO raw_device_snapshots
    SELECT * FROM raw_device_snapshots_default
    ON CONFLICT DO NOTHING;

  -- Replace the populated old default with a fresh empty catch-all (safety net for out-of-range rows).
  DROP TABLE raw_device_snapshots_default;
  CREATE TABLE raw_device_snapshots_default PARTITION OF raw_device_snapshots DEFAULT;
END $$;
