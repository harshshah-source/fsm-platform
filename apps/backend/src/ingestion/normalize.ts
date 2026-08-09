import type { SourceSnapshotRow } from './source-reader';

/**
 * UTC normalization for ingested telemetry (LLD §2 / AC#3).
 *
 * AutoPlant returns GPS datetimes as naive wall-clock values in a source timezone (IST = +330 by
 * default). The real `SourceReader` reads these as `RawSourceRow`s and calls `normalizeSourceRow`
 * to produce the canonical `SourceSnapshotRow` whose `gpsDatetime` is a true UTC instant before it
 * reaches `raw_device_snapshots` (timestamptz). Only the timestamp is transformed — every other
 * telemetry field is preserved verbatim.
 */

/** A source row as AutoPlant exposes it: a naive wall-clock string + its UTC offset, plus telemetry. */
export type RawSourceRow = Omit<SourceSnapshotRow, 'gpsDatetime'> & {
  /** Naive wall-clock, `YYYY-MM-DD HH:mm:ss` or ISO `T` form, with no offset of its own. */
  gpsWallClock: string;
  /** Source UTC offset in minutes (e.g. 330 for IST, -300 for US Eastern). */
  sourceUtcOffsetMinutes: number;
};

/**
 * The offset used for `gpsDatetimeUtc`, deliberately NOT `sourceUtcOffsetMinutes`.
 *
 * AutoPlant writes UTC into its naive DATETIME columns — measured twice by different methods: 95
 * snapshot runs flat in the 5.52–5.65 h band (#222), and `FIRST_INSTALLED_DATE_TIME` agreeing to the
 * minute with a TIMESTAMP column in the same row across 17,985 devices (2026-08-09). So the true
 * instant is the wall clock read as UTC, and `sourceUtcOffsetMinutes` still carries #222's live +330.
 *
 * `gpsDatetime` keeps taking the (wrong) configured offset so this change alters no existing
 * behaviour; only the write-once `first_reported_at` consumes the corrected value, because a column
 * that is frozen on first write can never be corrected later. Remove this once #222 lands and the two
 * converge.
 */
export const TRUE_SOURCE_UTC_OFFSET_MIN = 0;

const NAIVE_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/;

/** Convert a source-local naive wall-clock + its UTC offset to a UTC instant. */
export function normalizeGpsTimestamp(wallClock: string, sourceUtcOffsetMinutes: number): Date {
  const m = NAIVE_TIMESTAMP.exec(wallClock.trim());
  if (!m) {
    throw new Error(`Unparseable source GPS timestamp: "${wallClock}"`);
  }
  const [, y, mo, d, hh, mm, ss] = m;
  // Read the components as if they were UTC, then back out the source offset to get the real instant.
  const asIfUtcMs = Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss);
  return new Date(asIfUtcMs - sourceUtcOffsetMinutes * 60_000);
}

/** Map a raw AutoPlant row to a normalized `SourceSnapshotRow` (UTC timestamp; telemetry verbatim). */
export function normalizeSourceRow(raw: RawSourceRow): SourceSnapshotRow {
  const { gpsWallClock, sourceUtcOffsetMinutes, ...telemetry } = raw;
  return {
    ...telemetry,
    gpsDatetime: normalizeGpsTimestamp(gpsWallClock, sourceUtcOffsetMinutes),
    // Same wall clock, corrected offset — see TRUE_SOURCE_UTC_OFFSET_MIN. Identical to `gpsDatetime`
    // once #222 sets the constant to 0.
    gpsDatetimeUtc: normalizeGpsTimestamp(gpsWallClock, TRUE_SOURCE_UTC_OFFSET_MIN),
  };
}
