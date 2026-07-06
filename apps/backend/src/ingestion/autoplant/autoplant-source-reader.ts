import { AUTOPLANT_UTC_OFFSET_MIN, mapVehicleMasterRow, type VehicleMasterRow } from './mapping';
import type { SourceChunk, SourceReader, SourceSnapshotRow } from '../source-reader';

/**
 * The production `SourceReader` over AutoPlant `ap_widgets.tb_vehiclemaster` (Phase 3). Swaps in behind
 * the `SOURCE_READER` DI token so the existing `SnapshotIngestionWorker` drives it unchanged.
 *
 * TWO scan modes, chosen by whether a resume watermark exists — the fix for the cold-start pathology
 * (`tb_vehiclemaster` is a latest-state table the live fleet mutates forward):
 *
 *   • COLD scan (no prior SUCCESS/PARTIAL run → no resume watermark): page by the **stable, immutable
 *     `device_id`** key (`ORDER BY device_id`, keyset `device_id > ?`). A device that re-pings mid-scan
 *     keeps its device_id, so it never sorts back ahead of the cursor and is never re-read — the scan
 *     touches each of ~N devices exactly once and terminates deterministically in ⌈N/chunk⌉ queries,
 *     regardless of how actively the fleet pings. Ordering by the mutating `latest_gps_datetime` here
 *     is exactly what made a first sync never finish (re-pinged devices harvested as new rows forever).
 *   • INCREMENTAL scan (a prior run's persisted `snapshot_runs.cursor` = its `data_as_of`, a UTC
 *     instant): resume `>=` its source-local wall-clock, then keyset over `(latest_gps_datetime,
 *     device_id)` — boundary-tie-safe (R10). This returns only the devices that changed since the last
 *     tick, which is what an incremental poll wants. Idempotency (`ON CONFLICT DO NOTHING`) absorbs the
 *     `>=` boundary re-read.
 *
 * Cursor tokens are self-tagging so the run stays in one mode: cold continuation = `encodeColdCursor`
 * (`"dev>"` + device_id); incremental continuation = `encodeCursor` (`"<wallclock>|<device_id>"`).
 * Every row is normalized IST→UTC via `mapping.ts` (which reuses `normalize.ts`); NULL-device /
 * never-pinged / bogus-future rows are dropped (§6.6). The device id is preserved verbatim (String).
 *
 * NOTE (verify before enabling against production): the cold scan's `ORDER BY device_id` needs an index
 * on `tb_vehiclemaster.device_id`, else each page filesorts the whole table on the source. Confirm with
 * `SHOW INDEX FROM tb_vehiclemaster` (read-only) before the first live cold run; if device_id is
 * unindexed, page by the table's actual PK instead (same keyset shape, different sort column).
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

/** Opaque intra-run keyset token (incremental mode): the last scanned row's `(source wall-clock, device_id)`. */
export function encodeCursor(sourceWallClock: string, deviceId: string): string {
  return `${sourceWallClock}|${deviceId}`;
}

/** Cold-scan token prefix — tags a device-keyset continuation so mode survives across `readChunk` calls. */
const COLD_CURSOR_PREFIX = 'dev>';

/** Opaque intra-run keyset token (cold mode): the last scanned row's `device_id`, stable-key ordered. */
export function encodeColdCursor(deviceId: string): string {
  return `${COLD_CURSOR_PREFIX}${deviceId}`;
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
    // No watermark ⇒ cold scan (page by device_id); a watermark ⇒ incremental (page by timestamp keyset).
    const effective = cursor ?? (await this.loadResumeCursor());
    const { predicate, params, orderBy, mode } = this.buildScan(effective);
    const limit = Math.max(1, Math.floor(chunkSize));

    const sql =
      `SELECT ${SELECT_COLS} FROM tb_vehiclemaster ` +
      `WHERE latest_gps_datetime IS NOT NULL AND device_id IS NOT NULL AND TRIM(device_id) <> ''${predicate} ` +
      `ORDER BY ${orderBy} LIMIT ${limit}`;

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
    // rows never cause a re-read loop. A short page means the source is exhausted. The token carries the
    // mode's keyset so the next `readChunk` continues in the same scan mode.
    const exhausted = rows.length < limit;
    const last = rows[rows.length - 1];
    const nextCursor =
      exhausted || !last
        ? null
        : mode === 'cold'
          ? encodeColdCursor(String(last.device_id))
          : encodeCursor(String(last.latest_gps_datetime), String(last.device_id));

    return { rows: mapped, nextCursor };
  }

  private buildScan(effective: string | null): {
    predicate: string;
    params: unknown[];
    orderBy: string;
    mode: 'cold' | 'incremental';
  } {
    // COLD first page: no prior watermark → stable-key scan, no continuation bound.
    if (effective === null) {
      return { predicate: '', params: [], orderBy: 'device_id', mode: 'cold' };
    }
    // COLD continuation: `device_id > ?`. Checked BEFORE the `|` test so a device_id containing '|'
    // is never misread as an incremental composite token.
    if (effective.startsWith(COLD_CURSOR_PREFIX)) {
      const deviceId = effective.slice(COLD_CURSOR_PREFIX.length);
      return { predicate: ' AND device_id > ?', params: [deviceId], orderBy: 'device_id', mode: 'cold' };
    }
    // INCREMENTAL continuation: the R10 boundary-tie-safe composite keyset over (ts, device_id).
    if (effective.includes('|')) {
      const i = effective.indexOf('|');
      const ts = effective.slice(0, i);
      const deviceId = effective.slice(i + 1);
      return {
        predicate: ' AND (latest_gps_datetime > ? OR (latest_gps_datetime = ? AND device_id > ?))',
        params: [ts, ts, deviceId],
        orderBy: 'latest_gps_datetime, device_id',
        mode: 'incremental',
      };
    }
    // INCREMENTAL first page: persisted UTC watermark (prior run's data_as_of) → resume `>=` source-local.
    return {
      predicate: ' AND latest_gps_datetime >= ?',
      params: [utcIsoToSourceWallClock(effective, this.offsetMinutes)],
      orderBy: 'latest_gps_datetime, device_id',
      mode: 'incremental',
    };
  }
}
