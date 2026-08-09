import { Injectable, Logger } from '@nestjs/common';
import { buildStampFields } from '../build-info/run-stamp';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { assertDepartureInvariant } from './departure-invariant';
import { DEFAULT_PGI_WINDOW_DAYS, parseEligibilityMode } from './eligibility';
import { evaluateRecomputeCanary } from './recompute-canary';
import { slaBucketCaseSql } from './sla-bucket';

const DEFAULT_INACTIVITY_THRESHOLD_HOURS = 24;
const DEFAULT_CANARY_THRESHOLD_PCT = 5;

/** What drove a recompute — recorded on the ledger row for attribution (#130 L5). */
export type RecomputeTrigger = 'api' | 'cron' | 'autoplant-sync' | 'test';

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
 *     - `is_departed` (Issue 128) from the FSM-owned `device_departures` side table; a departed device
 *       is excluded from inactive / SLA / eligibility in BOTH eligibility modes. The exclusion is
 *       explicit rather than left to the `all-deployed` status mirror alone, because it must also cover
 *       the MISSING_FROM_SOURCE case (a vanished device_id whose mirror status nobody can refresh).
 *     - vehicle / plant / company / transporter denormalised off the device's current fitment.
 *
 * `has_open_failure_cycle` is owned by ticket creation and is deliberately left untouched here.
 */
@Injectable()
export class DeviceStateService {
  private readonly logger = new Logger(DeviceStateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** Recompute `device_states` for all known devices (set-based; no telemetry scan). `now` injectable. */
  async recompute(now: Date = new Date(), trigger: RecomputeTrigger = 'api'): Promise<{ upserted: number }> {
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
    //
    //    #223 — `hours` gained a SECOND source. A device that has never reported has no last ping to
    //    measure from, and the original `dr.hours IS NOT NULL` guard below was written knowing that:
    //    whoever wrote it decided (correctly, locally) that "never heard from it" is not "it went
    //    silent". The failure was that the guard was never followed through to the consumers — the
    //    device, having been excluded from `inactive`, was swept into `healthy` by the negation, and
    //    913 fitted-and-dead trackers were counted as the healthiest devices in the fleet.
    //
    //    So a never-reported device is now aged from its INSTALL date instead
    //    (`device_commissioning.installed_at`, MIN per device). Operator decision P1 (2026-08-07): *"a
    //    tracker that is fitted and has never reported is a fault, not a pipeline state … a vehicle
    //    running untracked since the day it was fitted is exactly the thing this platform exists to
    //    catch."* Measuring from install rather than adding a new SLA band is deliberate: it is
    //    semantically honest ("this device has been broken for 602 days"), the existing SLA_BANDS work
    //    unchanged because the top band is open-ended, and it needs no enum migration.
    //
    //    MIN, not MAX: the question a never-reported device answers is "how long has it been broken",
    //    and it has produced nothing under ANY fitment, so the honest anchor is the first time it was
    //    fitted. MAX would restart the clock on every re-map — and `tb_vehiclemaster` rewrites fitment
    //    in place (10,565 devices have had `first_installed_dt` moved, 1,757 by more than a year), so
    //    MAX would let a device that has never worked look freshly commissioned indefinitely.
    //
    //    The grace window falls out of the existing `hours >= threshold` comparison for free —
    //    operator decision P2: 24 h, reusing `inactivity_threshold_hours`, no new setting. A device
    //    with neither a ping nor an install date keeps `hours = NULL` and stays out entirely (the 6
    //    source-orphans of #227); that case is unchanged and still unrepresentable, deliberately.
    const bucketCase = Prisma.raw(slaBucketCaseSql('dr.hours'));
    // A departed device (Issue 128) is NOT broken — it is in a warehouse. It must therefore leave the
    // operational derivations entirely rather than age through the SLA bands: no inactivity, no bucket,
    // no eligibility. `latest_gps_datetime` keeps updating if it still pings (it is raw observation,
    // not a judgement), so a re-deployed device resumes with real history. Same exclusion shape as the
    // Non-Op marking below: an EXISTS on the FSM-owned side table, keyed on the ACTIVE row.
    const departedExists = Prisma.sql`EXISTS (
      SELECT 1 FROM device_departures dd
       WHERE dd.device_id = ds.device_id AND dd.restored_at IS NULL
    )`;
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
    // #130 L2 decision 4 — the UPDATE and the recompute invariant assertion run in ONE transaction: a
    // violation (a device with an active departure somehow still shown operational — the run-65 shape)
    // throws, which rolls back the UPDATE atomically rather than committing corrupted state
    // (rollback-and-throw, not log-and-alert; L5's canary below warns on softer swings elsewhere).
    const upserted = await this.prisma.$transaction(async (tx) => {
      const count = await tx.$executeRaw(Prisma.sql`
        WITH install AS (
          SELECT device_id, MIN(installed_at) AS installed_at
            FROM device_commissioning
           WHERE installed_at IS NOT NULL
           GROUP BY device_id
        ),
        derived AS (
          SELECT ds.device_id,
            CASE WHEN ds.latest_gps_datetime IS NOT NULL
                   THEN GREATEST(0, EXTRACT(EPOCH FROM (${now}::timestamptz - ds.latest_gps_datetime)) / 3600.0)
                 WHEN ic.installed_at IS NOT NULL
                   THEN GREATEST(0, EXTRACT(EPOCH FROM (${now}::timestamptz - ic.installed_at)) / 3600.0)
                 ELSE NULL
            END AS hours,
            ${departedExists} AS departed
          FROM device_states ds
          LEFT JOIN install ic ON ic.device_id = ds.device_id
        )
        UPDATE device_states ds SET
          inactivity_hours = dr.hours,
          is_departed = dr.departed,
          is_inactive = (NOT dr.departed AND dr.hours IS NOT NULL AND dr.hours >= ${threshold}),
          sla_bucket = CASE WHEN dr.departed THEN NULL ELSE ${bucketCase} END,
          eligible_for_uptime = (
            NOT dr.departed
            AND ${eligibilityBase}
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
      await assertDepartureInvariant(tx);
      return count;
    });

    // #130 L5 — append the recompute ledger row (attribution the incident's write class never had) and
    // run the semantic canary. Only reached if the transaction above committed. Counts come from the
    // just-updated device_states in one FILTER pass.
    await this.recordRecomputeAndCanary(now, trigger);

    return { upserted };
  }

  /**
   * #130 L5 — ledger + canary. Reads the operational counts, compares the eligible count against the
   * previous ledger row (relative swing > threshold, either direction → one LOUD warn), then appends
   * this recompute's row. WARNS, never throws: hard-failing true corruption is L2's recompute invariant.
   */
  private async recordRecomputeAndCanary(now: Date, trigger: RecomputeTrigger): Promise<void> {
    const [counts] = await this.prisma.$queryRaw<
      Array<{ total: bigint; eligible: bigint; inactive: bigint; departed: bigint }>
    >(Prisma.sql`
      SELECT count(*) AS total,
             count(*) FILTER (WHERE eligible_for_uptime) AS eligible,
             count(*) FILTER (WHERE is_inactive) AS inactive,
             count(*) FILTER (WHERE is_departed) AS departed
      FROM device_states`);
    const total = Number(counts.total);
    const eligible = Number(counts.eligible);
    const inactive = Number(counts.inactive);
    const departed = Number(counts.departed);

    // Read the previous baseline BEFORE inserting this run's row.
    const previous = await this.prisma.deviceStateRecompute.findFirst({
      orderBy: { computedAt: 'desc' },
      select: { eligibleCount: true, buildFingerprint: true },
    });

    const stamp = buildStampFields();
    await this.prisma.deviceStateRecompute.create({
      data: {
        computedAt: now,
        eligibleCount: eligible,
        inactiveCount: inactive,
        departedCount: departed,
        totalCount: total,
        trigger,
        ...stamp,
      },
    });

    const thresholdPct =
      (await this.settings.get<number>('recompute_canary_threshold_pct')) ?? DEFAULT_CANARY_THRESHOLD_PCT;
    const verdict = evaluateRecomputeCanary(previous?.eligibleCount, eligible, thresholdPct);
    if (verdict?.breached) {
      this.logger.warn(
        `[recompute-canary] eligible-count swing ${verdict.deltaPct.toFixed(1)}% exceeds ±${thresholdPct}%: ` +
          `${previous!.eligibleCount} (build ${previous!.buildFingerprint ?? 'unknown'}) → ` +
          `${eligible} (build ${stamp.buildFingerprint}). Trigger=${trigger}. ` +
          `Investigate a possible stale build / env mismatch / config change before trusting this recompute.`,
      );
    }
  }
}
