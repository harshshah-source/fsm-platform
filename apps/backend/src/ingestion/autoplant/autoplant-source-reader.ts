import { AUTOPLANT_UTC_OFFSET_MIN, mapVehicleMasterRow, type VehicleMasterRow } from './mapping';
import type { SourceChunk, SourceReader, SourceSnapshotRow } from '../source-reader';

/**
 * The production `SourceReader` over AutoPlant `ap_widgets.tb_vehiclemaster` (Phase 3). Swaps in behind
 * the `SOURCE_READER` DI token so the existing `SnapshotIngestionWorker` drives it unchanged.
 *
 * Reads are a keyset page over `(latest_gps_datetime, device_id)` — the R10 design
 * (`ARCHITECTURE-REMEDIATION-PLAN.md`): boundary-tie-safe, resumable, index-friendly. Three cursor
 * modes, all owned here so the worker stays generic (blueprint §6.2 option a):
 *   • `null` at run start → load the last SUCCESS/PARTIAL run's persisted `snapshot_runs.cursor` (the
 *     prior `data_as_of`, a UTC instant) and resume `>=` its source-local wall-clock. Idempotency
 *     (`ON CONFLICT DO NOTHING`) absorbs the boundary re-read. No prior run → cold full backfill.
 *   • an intra-run keyset token `"<wallclock>|<device_id>"` → strict composite `>` continuation.
 * Every row is normalized IST→UTC via `mapping.ts` (which reuses `normalize.ts`); NULL-device /
 * never-pinged / bogus-future rows are dropped (§6.6). The device id is preserved verbatim (String).
 */

const SELECT_COLS =
  'device_id, latest_gps_datetime, latitude, longitude, speed, IGNITION_STATUS, DEVICE_TYPE, gpssignal';

export interface AutoPlantSourceReaderDeps {
  /** Read-only query into `ap_widgets` (satisfied by `AutoPlantMysqlClient.query`). */
  query: <T>(sql: string, params?: readonly unknown[]) => Promise<T[]>;
  /** Last SUCCESS/PARTIAL run's persisted cursor (UTC ISO from `data_as_of`), or null if none. */
  loadResumeCursor: () => Promise<string | null>;
  /** Injectable clock for the future-timestamp guard. */
  now?: () => Date;
  offsetMinutes?: number;
  maxSkewMinutes?: number;
}

/** Opaque intra-run keyset token: the last scanned row's `(source wall-clock, device_id)`. */
export function encodeCursor(sourceWallClock: string, deviceId: string): string {
  return `${sourceWallClock}|${deviceId}`;
}

/** Shift a UTC instant into the source's naive wall-clock (`YYYY-MM-DD HH:mm:ss`) for the resume `>=`. */
export function utcIsoToSourceWallClock(utcIso: string, offsetMinutes: number): string {
  const shifted = new Date(new Date(utcIso).getTime() + offsetMinutes * 60_000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())} ` +
    `${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}`
  );
}

export class AutoPlantSourceReader implements SourceReader {
  private readonly query: AutoPlantSourceReaderDeps['query'];
  private readonly loadResumeCursor: AutoPlantSourceReaderDeps['loadResumeCursor'];
  private readonly now: () => Date;
  private readonly offsetMinutes: number;
  private readonly maxSkewMinutes: number | undefined;

  constructor(deps: AutoPlantSourceReaderDeps) {
    this.query = deps.query;
    this.loadResumeCursor = deps.loadResumeCursor;
    this.now = deps.now ?? (() => new Date());
    this.offsetMinutes = deps.offsetMinutes ?? AUTOPLANT_UTC_OFFSET_MIN;
    this.maxSkewMinutes = deps.maxSkewMinutes;
  }

  async readChunk(cursor: string | null, chunkSize: number): Promise<SourceChunk> {
    // A null cursor is the worker starting a run → resolve the cross-run resume watermark here.
    const effective = cursor ?? (await this.loadResumeCursor());
    const { predicate, params } = this.buildPredicate(effective);
    const limit = Math.max(1, Math.floor(chunkSize));

    const sql =
      `SELECT ${SELECT_COLS} FROM tb_vehiclemaster ` +
      `WHERE latest_gps_datetime IS NOT NULL AND device_id IS NOT NULL AND TRIM(device_id) <> ''${predicate} ` +
      `ORDER BY latest_gps_datetime, device_id LIMIT ${limit}`;

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

    // Advance the cursor from the last DB row actually scanned (not the mapped/filtered set), so skipped
    // rows never cause a re-read loop. A short page means the source is exhausted.
    const exhausted = rows.length < limit;
    const last = rows[rows.length - 1];
    const nextCursor =
      exhausted || !last ? null : encodeCursor(String(last.latest_gps_datetime), String(last.device_id));

    return { rows: mapped, nextCursor };
  }

  private buildPredicate(effective: string | null): { predicate: string; params: unknown[] } {
    if (effective === null) return { predicate: '', params: [] };
    if (effective.includes('|')) {
      const i = effective.indexOf('|');
      const ts = effective.slice(0, i);
      const deviceId = effective.slice(i + 1);
      return {
        predicate: ' AND (latest_gps_datetime > ? OR (latest_gps_datetime = ? AND device_id > ?))',
        params: [ts, ts, deviceId],
      };
    }
    // Persisted UTC watermark (prior run's data_as_of) → resume `>=` its source-local wall-clock.
    return {
      predicate: ' AND latest_gps_datetime >= ?',
      params: [utcIsoToSourceWallClock(effective, this.offsetMinutes)],
    };
  }
}
