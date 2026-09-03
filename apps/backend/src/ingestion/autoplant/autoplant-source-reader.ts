import { Logger } from '@nestjs/common';
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
 * banner only and never gates which rows are scanned. Every row is normalized via `mapping.ts` (the
 * source column is **UTC**, so no offset is applied — see `AUTOPLANT_UTC_OFFSET_MIN` and #222);
 * NULL-device / never-pinged rows are skipped and skew-guard failures are dropped (§6.6). The device id
 * is preserved verbatim.
 *
 * Skew-guard rejections are counted per chunk and surfaced on {@link SourceChunk.rejected} plus a WARN,
 * because a dropped row is otherwise indistinguishable from a row that never existed (#222 P6).
 *
 * NOTE: the `ORDER BY device_id` scan needs an index on `tb_vehiclemaster.device_id` (present as
 * `idx_device_id`), else each page filesorts the whole table on the source. `device_id` is verified
 * effectively unique on production, so the plain `device_id > ?` keyset never skips a row at a page
 * boundary — no composite tiebreak is required.
 */

// TRIP_CREATION_DATETIME rides this existing scan (no extra query, no extra pass): it is live
// trip state, so the 30-min telemetry tick is its correct cadence — the daily master sync would
// leave 18.4% of the DEPLOYED fleet stale. It lands on `device_states`, not `raw_device_snapshots`.
const SELECT_COLS =
  'device_id, latest_gps_datetime, latitude, longitude, speed, IGNITION_STATUS, DEVICE_TYPE, ' +
  'TRIP_CREATION_DATETIME, gpssignal';

export interface AutoPlantSourceReaderDeps {
  /** Read-only query into `ap_widgets` (satisfied by `AutoPlantMysqlClient.query`). */
  query: <T>(sql: string, params?: readonly unknown[]) => Promise<T[]>;
  /**
   * The `ap_widgets` schema name (from `AutoPlantMysqlConfig.dbWidgets`) — used to schema-qualify
   * `tb_vehiclemaster`. This MUST be passed in production: `tb_vehiclemaster` lives in `ap_widgets`,
   * but the pool's default schema is `ap_masters` (masters is the connect-time-validated live consumer),
   * so an unqualified `FROM tb_vehiclemaster` resolves to `ap_masters.tb_vehiclemaster` and every read
   * fails `ER_NO_SUCH_TABLE`. Omitted only in unit tests that stub `query` and never touch a real schema.
   */
  widgetsSchema?: string;
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
  private readonly logger = new Logger(AutoPlantSourceReader.name);
  private readonly query: AutoPlantSourceReaderDeps['query'];
  private readonly from: string;
  private readonly now: () => Date;
  private readonly offsetMinutes: number;
  private readonly maxSkewMinutes: number | undefined;

  constructor(deps: AutoPlantSourceReaderDeps) {
    this.query = deps.query;
    // Backtick-qualify the telemetry table with the configured widgets schema (defence-in-depth against
    // the pool's default schema, which is `ap_masters`). Unqualified only when no schema is supplied —
    // unit tests stubbing `query`; a real MySQL pool would then fail ER_NO_SUCH_TABLE against ap_masters.
    this.from = deps.widgetsSchema ? `\`${deps.widgetsSchema}\`.tb_vehiclemaster` : 'tb_vehiclemaster';
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
      `SELECT ${SELECT_COLS} FROM ${this.from} ` +
      `WHERE latest_gps_datetime IS NOT NULL AND device_id IS NOT NULL AND TRIM(device_id) <> ''${predicate} ` +
      `ORDER BY device_id LIMIT ${limit}`;

    const rows = await this.query<VehicleMasterRow>(sql, params);

    const mapped: SourceSnapshotRow[] = [];
    // #222 P6 — the skew guard's drops are tallied and logged, not swallowed. `FUTURE_SKEW` in
    // particular is the IST-writer signature: a non-zero count here is the fleet telling us a device
    // writes a different timezone into this column, which is the only way that fact becomes visible.
    // #299 adds `UNPARSEABLE_TIMESTAMP` to the same channel — also a dropped row — and a SECOND,
    // separate tally for fields nulled with their row kept, because those two are not the same event.
    const rejected: Record<string, number> = {};
    const repaired: Record<string, number> = {};
    const first: Record<string, string> = {};
    const onReject = (deviceId: string, reason: string): void => {
      rejected[reason] = (rejected[reason] ?? 0) + 1;
      first[reason] ??= deviceId;
    };
    const onRepair = (deviceId: string, reason: string): void => {
      repaired[reason] = (repaired[reason] ?? 0) + 1;
      first[reason] ??= deviceId;
    };
    for (const r of rows) {
      const row = mapVehicleMasterRow(r, {
        now: this.now(),
        offsetMinutes: this.offsetMinutes,
        maxSkewMinutes: this.maxSkewMinutes,
        onReject,
        onRepair,
      });
      if (row) mapped.push(row);
    }
    // A device id per distinct reason, so the WARN is actionable against the source rather than merely
    // alarming: "3 rows rejected" cannot be chased, "UNPARSEABLE_TIMESTAMP first seen on 0869…" can.
    const tally = (counts: Record<string, number>): string =>
      Object.entries(counts).map(([k, v]) => `${k}=${v} (first: ${first[k]})`).join(' ');
    const rejectedAny = Object.keys(rejected).length > 0;
    const repairedAny = Object.keys(repaired).length > 0;
    if (rejectedAny) {
      this.logger.warn(
        `dropped ${Object.values(rejected).reduce((a, b) => a + b, 0)} row(s) this chunk: ${tally(rejected)}. ` +
          `FUTURE_SKEW means the device writes a non-UTC wall clock into latest_gps_datetime (#222 P6); ` +
          `UNPARSEABLE_TIMESTAMP means latest_gps_datetime is not a timestamp at all and the source row ` +
          `needs fixing — the scan no longer stops on it (#299 AR-1); SENTINEL_DEVICE_ID means the ` +
          `device_id is a sentinel word ('NA'/'NULL') rather than an id, so the masters path can never ` +
          `create the device and its telemetry would be unreachable (#323 AR-9c).`,
      );
    }
    if (repairedAny) {
      this.logger.warn(
        `nulled ${Object.values(repaired).reduce((a, b) => a + b, 0)} out-of-range field(s) this chunk, ` +
          `rows kept: ${tally(repaired)}. The ping was ingested; only the named reading was discarded (#299 AR-2).`,
      );
    }

    // Advance the cursor from the last DB row actually scanned (not the mapped/filtered set), so dropped
    // rows never cause a re-read loop. A short page means the source is exhausted.
    const exhausted = rows.length < limit;
    const last = rows[rows.length - 1];
    const nextCursor = exhausted || !last ? null : encodeDeviceCursor(String(last.device_id));

    return { rows: mapped, nextCursor, ...(rejectedAny ? { rejected } : {}), ...(repairedAny ? { repaired } : {}) };
  }
}
