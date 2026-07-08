import { AUTOPLANT_UTC_OFFSET_MIN, mapVehicleMasterRow, type VehicleMasterRow } from './mapping';
import type { SourceChunk, SourceReader, SourceSnapshotRow } from '../source-reader';

/**
 * The production `SourceReader` over AutoPlant `ap_widgets.tb_vehiclemaster` (Phase 3). Swaps in behind
 * the `SOURCE_READER` DI token so the existing `SnapshotIngestionWorker` drives it unchanged.
 *
 * ONE deterministic scan engine — no cold/incremental split. `tb_vehiclemaster` is a latest-state table
 * (exactly one row per immutable `device_id`) that the live fleet mutates forward. The scan pages by the
 * **stable `device_id`** key (`ORDER BY device_id`, keyset `device_id > ?`) and applies **no
 * `latest_gps_datetime` predicate**. Two consequences make this the only correct shape:
 *
 *   • Termination: `device_id` is immutable and finite, so the keyset walks a strictly-increasing key
 *     space once and finishes in ⌈N / chunk⌉ queries — independent of how actively the fleet pings.
 *   • No lost / re-harvested updates: because scan membership and order ride the immutable key and never
 *     the mutating telemetry timestamp, a device that re-pings (advancing `latest_gps_datetime`) or
 *     backdates mid-scan can neither sort ahead of the cursor to be re-read, nor fall below a watermark
 *     to be skipped. Every device is visited exactly once per run with whatever value it holds at scan
 *     time; the next run re-reads it. `ON CONFLICT DO NOTHING` on `(device_id, gps_datetime)` makes the
 *     unchanged re-reads free.
 *
 * There is deliberately NO cross-run resume cursor: correctness must not depend on a persisted
 * watermark. `snapshot_runs.data_as_of` (max ingested `gps_datetime`) is computed for the freshness
 * banner only and never gates which rows are scanned. Every row is normalized IST→UTC via `mapping.ts`;
 * NULL-device / never-pinged / bogus-future rows are dropped (§6.6). The device id is preserved verbatim.
 *
 * NOTE: the `ORDER BY device_id` scan needs an index on `tb_vehiclemaster.device_id` (present as
 * `idx_device_id`), else each page filesorts the whole table on the source. `device_id` is verified
 * effectively unique on production, so the plain `device_id > ?` keyset never skips a row at a page
 * boundary — no composite tiebreak is required.
 */

const SELECT_COLS =
  'device_id, latest_gps_datetime, latitude, longitude, speed, IGNITION_STATUS, DEVICE_TYPE, gpssignal';

export interface AutoPlantSourceReaderDeps {
  /** Read-only query into `ap_widgets` (satisfied by `AutoPlantMysqlClient.query`). */
  query: <T>(sql: string, params?: readonly unknown[]) => Promise<T[]>;
  /** Injectable clock for the future-timestamp guard. */
  now?: () => Date;
  offsetMinutes?: number;
  maxSkewMinutes?: number;
}

/** Opaque intra-run keyset token: the last scanned row's immutable `device_id`. */
export function encodeDeviceCursor(deviceId: string): string {
  return deviceId;
}

export class AutoPlantSourceReader implements SourceReader {
  private readonly query: AutoPlantSourceReaderDeps['query'];
  private readonly now: () => Date;
  private readonly offsetMinutes: number;
  private readonly maxSkewMinutes: number | undefined;

  constructor(deps: AutoPlantSourceReaderDeps) {
    this.query = deps.query;
    this.now = deps.now ?? (() => new Date());
    this.offsetMinutes = deps.offsetMinutes ?? AUTOPLANT_UTC_OFFSET_MIN;
    this.maxSkewMinutes = deps.maxSkewMinutes;
  }

  async readChunk(cursor: string | null, chunkSize: number): Promise<SourceChunk> {
    const limit = Math.max(1, Math.floor(chunkSize));
    // A null cursor is the worker starting a run → first page, no continuation bound. Otherwise continue
    // strictly after the last scanned device_id. No telemetry watermark is ever consulted.
    const predicate = cursor === null ? '' : ' AND device_id > ?';
    const params = cursor === null ? [] : [cursor];

    const sql =
      `SELECT ${SELECT_COLS} FROM tb_vehiclemaster ` +
      `WHERE latest_gps_datetime IS NOT NULL AND device_id IS NOT NULL AND TRIM(device_id) <> ''${predicate} ` +
      `ORDER BY device_id LIMIT ${limit}`;

    const rows = await this.query<VehicleMasterRow>(sql, params);

    const mapped: SourceSnapshotRow[] = [];
    for (const r of rows) {
      const row = mapVehicleMasterRow(r, {
        now: this.now(),
        offsetMinutes: this.offsetMinutes,
        maxSkewMinutes: this.maxSkewMinutes,
      });
      if (row) mapped.push(row);
    }

    // Advance the cursor from the last DB row actually scanned (not the mapped/filtered set), so dropped
    // rows never cause a re-read loop. A short page means the source is exhausted.
    const exhausted = rows.length < limit;
    const last = rows[rows.length - 1];
    const nextCursor = exhausted || !last ? null : encodeDeviceCursor(String(last.device_id));

    return { rows: mapped, nextCursor };
  }
}
