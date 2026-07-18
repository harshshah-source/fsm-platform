import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { SourceSnapshotRow } from './source-reader';

export interface IngestChunkResult {
  /** Journal rows actually written (Postgres excludes ON CONFLICT skips). */
  inserted: number;
  /** `device_states` rows created/advanced this chunk (= distinct known devices in the chunk). */
  deviceStatesUpserted: number;
  /** Distinct device_ids whose telemetry was skipped because the device is not yet mastered in `devices`. */
  unknownDevices: number;
}

/**
 * Writes raw telemetry chunks into `raw_device_snapshots` AND maintains `device_states.latest_gps_datetime`
 * + `device_states.trip_creation_datetime` incrementally from the same in-memory chunk (R4-A).
 *
 * `trip_creation_datetime` is here — on the 30-min telemetry tick — rather than in the daily master sync
 * because it is live trip state: it tracks `active_trip_id`, and 18.4% of the DEPLOYED fleet changes it
 * per day (measured 2026-07-17), so a daily mirror would be stale for ~2,600 vehicles at a time. It is
 * per-device CURRENT state, so it belongs on the hot `device_states` row, not in the per-ping
 * `raw_device_snapshots` journal (which is partitioned + retention-dropped).
 *
 * Chunk re-runs are idempotent: `createMany({ skipDuplicates: true })` emits
 * `INSERT … ON CONFLICT DO NOTHING`, and the `(device_id, gps_datetime)` UNIQUE means a re-processed
 * chunk inserts nothing the second time (AC#4). `inserted` is the count of rows actually written.
 * Telemetry is mapped verbatim — no normalization here beyond passing values through (AC#3).
 *
 * The device_states upsert is the R4 move that lets the derive pass stop folding the entire (growing)
 * telemetry table just to find each device's newest ping: the newest ping is written here as it arrives.
 * It is set-based (one statement over an `unnest`), deduped per device to the chunk-max (so a single
 * statement never hits one conflict key twice), `GREATEST`-guarded (replayed/out-of-order chunks never
 * regress the watermark), and INNER JOINed to `devices` so a ping for an unmastered device is skipped
 * rather than violating the `device_states.device_id → devices` FK. Skipped ids are counted for visibility.
 */
@Injectable()
export class SnapshotIngestionService {
  private readonly logger = new Logger(SnapshotIngestionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async ingestChunk(
    runId: bigint,
    rows: readonly SourceSnapshotRow[],
    now: Date = new Date(),
  ): Promise<IngestChunkResult> {
    if (rows.length === 0) return { inserted: 0, deviceStatesUpserted: 0, unknownDevices: 0 };

    const data = rows.map((r) => ({
      runId,
      deviceId: r.deviceId,
      gpsDatetime: r.gpsDatetime,
      lat: r.lat ?? null,
      lon: r.lon ?? null,
      mainsStatus: r.mainsStatus ?? null,
      mainsVoltage: r.mainsVoltage ?? null,
      gpsValidity: r.gpsValidity ?? null,
      gpsMode: r.gpsMode ?? null,
      ignitionStatus: r.ignitionStatus ?? null,
      speed: r.speed ?? null,
      creg: r.creg ?? null,
      cgreg: r.cgreg ?? null,
      csq: r.csq ?? null,
      ipAddress: r.ipAddress ?? null,
      portNo: r.portNo ?? null,
      simSubscriberName: r.simSubscriberName ?? null,
      unitNo: r.unitNo ?? null,
      deviceType: r.deviceType ?? null,
    }));

    const result = await this.prisma.rawDeviceSnapshot.createMany({
      data,
      skipDuplicates: true,
    });

    const { deviceStatesUpserted, unknownDevices } = await this.upsertDeviceStates(rows, now);

    return { inserted: result.count, deviceStatesUpserted, unknownDevices };
  }

  /**
   * Set-based `device_states.latest_gps_datetime` maintenance for one chunk. Dedupes to the per-device
   * chunk-max, then one `INSERT … SELECT unnest(...) JOIN devices … ON CONFLICT DO UPDATE` with
   * `GREATEST`. The affected-row count equals the number of *known* devices touched; the rest are
   * unmastered ids skipped by the JOIN.
   */
  private async upsertDeviceStates(
    rows: readonly SourceSnapshotRow[],
    now: Date,
  ): Promise<{ deviceStatesUpserted: number; unknownDevices: number }> {
    const maxByDevice = new Map<string, Date>();
    const tripByDevice = new Map<string, Date>();
    for (const r of rows) {
      const cur = maxByDevice.get(r.deviceId);
      if (!cur || r.gpsDatetime > cur) maxByDevice.set(r.deviceId, r.gpsDatetime);
      // Trip creation dedupes to the chunk-max independently of the ping watermark: trips are only ever
      // created forward, so the newest stamp is the current trip. A null (no trip yet) never displaces a
      // known one — same "never regress" rule the ping watermark follows.
      const trip = r.tripCreationDatetime ?? null;
      if (trip) {
        const curTrip = tripByDevice.get(r.deviceId);
        if (!curTrip || trip > curTrip) tripByDevice.set(r.deviceId, trip);
      }
    }
    const deviceIds = [...maxByDevice.keys()];
    if (deviceIds.length === 0) return { deviceStatesUpserted: 0, unknownDevices: 0 };
    const timestamps = deviceIds.map((d) => maxByDevice.get(d)!);
    const tripCreations = deviceIds.map((d) => tripByDevice.get(d) ?? null);

    // `trip_creation_datetime` rides this existing statement — no second write, no extra round trip.
    // GREATEST ignores NULLs in Postgres, so a chunk that carries no trip stamp for a device leaves the
    // stored one intact rather than clearing it (a vehicle between trips must not lose its last trip).
    const deviceStatesUpserted = await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO device_states (device_id, latest_gps_datetime, trip_creation_datetime, computed_at)
      SELECT u.device_id, u.latest_gps, u.trip_created, ${now}
        FROM unnest(${deviceIds}::text[], ${timestamps}::timestamptz[], ${tripCreations}::timestamptz[])
          AS u(device_id, latest_gps, trip_created)
        JOIN devices d ON d.device_id = u.device_id
      ON CONFLICT (device_id) DO UPDATE
        SET latest_gps_datetime = GREATEST(device_states.latest_gps_datetime, EXCLUDED.latest_gps_datetime),
            trip_creation_datetime = GREATEST(device_states.trip_creation_datetime, EXCLUDED.trip_creation_datetime),
            computed_at = EXCLUDED.computed_at`);

    const unknownDevices = deviceIds.length - deviceStatesUpserted;
    if (unknownDevices > 0) {
      this.logger.warn(
        `ingest chunk: ${unknownDevices} device_id(s) not yet in devices — telemetry journalled, ` +
          `device_states deferred until master-sync mirrors them`,
      );
    }
    return { deviceStatesUpserted, unknownDevices };
  }
}
