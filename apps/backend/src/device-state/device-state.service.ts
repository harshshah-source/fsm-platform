import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { DEFAULT_PGI_WINDOW_DAYS, parseEligibilityMode } from './eligibility';
import { slaBucketCaseSql } from './sla-bucket';

const DEFAULT_INACTIVITY_THRESHOLD_HOURS = 24;

/**
 * DeviceStateService — derives every `device_states` row from time + reference data (schema D5).
 *
 * `latest_gps_datetime` is maintained incrementally at INGEST (R4-A: `SnapshotIngestionService`), so
 * this recompute no longer folds the entire (ever-growing, partitioned) telemetry table — the load-the-
 * world `groupBy` + per-device upsert loop is replaced by two set-based statements (R4-B). It still runs
 * on a schedule (the telemetry tick) because the derived fields are functions of *wall-clock time*: a
 * device that has gone silent must keep advancing WARNING→CRITICAL→SEVERE with no new telemetry arriving,
 * so ingest-driven updates alone can never age a silent device.
 *
 *  1. Ensure a row exists for every device (never-pinged devices included) — one INSERT … ON CONFLICT.
 *  2. Derive, in one UPDATE:
 *     - `inactivity_hours = now − latest_gps_datetime`, clamped ≥0 (clock skew → 0).
 *     - `is_inactive` against the configurable `inactivity_threshold_hours` setting (canonical 24h).
 *     - `sla_bucket` via {@link slaBucketCaseSql} — generated from the SAME `SLA_BANDS` as the TS
 *       classifier, so the SQL and TS bucket boundaries cannot drift. NULL for the 0–4h ACTIVE band.
 *     - `eligible_for_uptime` per the `eligibility_mode` setting (Issue 112): `pgi` = active PGI
 *       within the window; `all-deployed` = interim proxy off the vehicle deployment-status mirror.
 *       A CONFIRMED/ACTIVE Non-Op marking excludes the device in both modes.
 *     - vehicle / plant / company / transporter denormalised off the device's current fitment.
 *
 * `has_open_failure_cycle` is owned by ticket creation and is deliberately left untouched here.
 */
@Injectable()
export class DeviceStateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** Recompute `device_states` for all known devices (set-based; no telemetry scan). `now` injectable. */
  async recompute(now: Date = new Date()): Promise<{ upserted: number }> {
    const threshold =
      (await this.settings.get<number>('inactivity_threshold_hours')) ??
      DEFAULT_INACTIVITY_THRESHOLD_HOURS;
    const eligibilityMode = parseEligibilityMode(await this.settings.get('eligibility_mode'));

    // 1. Guarantee one row per device (never-pinged devices get a row with a null latest ping).
    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO device_states (device_id, computed_at)
      SELECT d.device_id, ${now} FROM devices d
      ON CONFLICT (device_id) DO NOTHING`);

    // 2. Derive every field from latest_gps_datetime (maintained at ingest) + reference data, in one
    //    pass. The `derived` CTE computes clamped inactivity hours once; the SLA-bucket CASE is projected
    //    from SLA_BANDS so it stays in lockstep with classifySlaBucket.
    const bucketCase = Prisma.raw(slaBucketCaseSql('dr.hours'));
    // Eligibility base per `eligibility_mode` (Issue 112 / review B7); the Non-Op exclusion below
    // applies in both modes. `all-deployed` reads the vehicle deployment-status mirror off the
    // already-joined current fitment — COALESCE so no fitment / null status is ineligible, not NULL.
    const eligibilityBase =
      eligibilityMode === 'all-deployed'
        ? Prisma.sql`COALESCE(v.status IN ('ACTIVE', 'DEPLOYED'), false)`
        : Prisma.sql`EXISTS (
            SELECT 1 FROM pgi_history p
             WHERE p.device_id = ds.device_id
               AND ${now}::timestamptz - (p.pgi_date::timestamp AT TIME ZONE 'UTC')
                     <= make_interval(days => ${DEFAULT_PGI_WINDOW_DAYS})
          )`;
    const upserted = await this.prisma.$executeRaw(Prisma.sql`
      WITH derived AS (
        SELECT ds.device_id,
          CASE WHEN ds.latest_gps_datetime IS NULL THEN NULL
               ELSE GREATEST(0, EXTRACT(EPOCH FROM (${now}::timestamptz - ds.latest_gps_datetime)) / 3600.0)
          END AS hours
        FROM device_states ds
      )
      UPDATE device_states ds SET
        inactivity_hours = dr.hours,
        is_inactive = (dr.hours IS NOT NULL AND dr.hours >= ${threshold}),
        sla_bucket = ${bucketCase},
        eligible_for_uptime = (
          ${eligibilityBase}
          AND NOT EXISTS (
            SELECT 1 FROM non_operational_markings n
             WHERE n.device_id = ds.device_id AND n.state::text IN ('CONFIRMED', 'ACTIVE')
          )
        ),
        vehicle_id = v.vehicle_id,
        plant_id = v.plant_id,
        company_id = v.company_id,
        transporter_id = v.transporter_id,
        computed_at = ${now}
      FROM derived dr
      JOIN devices d ON d.device_id = dr.device_id
      LEFT JOIN vehicles v ON v.vehicle_id = d.current_vehicle_id
      WHERE ds.device_id = dr.device_id`);

    return { upserted };
  }
}
