import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { SourceSnapshotRow } from './source-reader';

/**
 * Writes raw telemetry chunks into `raw_device_snapshots`.
 *
 * Chunk re-runs are idempotent: `createMany({ skipDuplicates: true })` emits
 * `INSERT … ON CONFLICT DO NOTHING`, and the `(device_id, gps_datetime)` UNIQUE means a re-processed
 * chunk inserts nothing the second time (AC#4). `inserted` is the count of rows actually written
 * (Postgres excludes the skipped duplicates), so the worker can report real progress per chunk.
 * Telemetry is mapped verbatim — no normalization here beyond passing values through (AC#3).
 */
@Injectable()
export class SnapshotIngestionService {
  constructor(private readonly prisma: PrismaService) {}

  async ingestChunk(
    runId: bigint,
    rows: readonly SourceSnapshotRow[],
  ): Promise<{ inserted: number }> {
    if (rows.length === 0) return { inserted: 0 };

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

    return { inserted: result.count };
  }
}
