/**
 * The AutoPlant source seam for Snapshot ingestion.
 *
 * The SnapshotIngestionWorker reads GPS telemetry through `SourceReader` rather than touching the
 * AutoPlant DB directly, so the real read-only connection (credentials + provisioning — HITL,
 * external access) can swap in behind this interface without changing the worker, its tests, or
 * the API. `InMemorySourceReader` is the mock the worker is built and tested against.
 *
 * Reads are cursor-based and chunked (LLD §1.3 / §6): the worker passes back the `nextCursor` from
 * the previous chunk until it gets `null` (source exhausted). The cursor is opaque to the caller —
 * the real reader will encode the last processed AutoPlant cursor / max snapshot timestamp.
 */

/** One raw telemetry ping from the source — the verbatim shape, before UTC normalization (slice 6). */
export interface SourceSnapshotRow {
  /**
   * AutoPlant `tb_vehiclemaster.device_id` is `varchar(255)` — real data carries leading-zero IMEIs
   * (`0869925073271551`), alphanumeric vendor ids (`AP03TC0959`), and NULLs. Device identity is a
   * String across the whole spine so those survive verbatim (a BigInt key corrupts/drops them).
   */
  deviceId: string;
  gpsDatetime: Date;
  /**
   * The SAME ping as `gpsDatetime`, normalized with the CORRECTED source offset
   * ({@link TRUE_SOURCE_UTC_OFFSET_MIN}) rather than the configured one. While #222 is open these
   * differ by 5.5 h; afterwards they are identical and this field can go.
   *
   * It exists solely for `device_states.first_reported_at`, which is write-once: a COALESCE column
   * frozen under the wrong constant would carry the error permanently, since nothing ever revisits
   * it. Optional because non-AutoPlant readers (e.g. `InMemorySourceReader` fixtures) may not supply
   * it — a null simply leaves `first_reported_at` unset for that chunk rather than writing a value
   * in an unknown convention.
   */
  gpsDatetimeUtc?: Date | null;
  /**
   * When the vehicle's CURRENT trip was created (`tb_vehiclemaster.TRIP_CREATION_DATETIME`), as a true
   * UTC instant. Rides the telemetry path because it is live trip state, not master data — it tracks
   * `active_trip_id` and 18.4% of the DEPLOYED fleet changes it daily (measured 2026-07-17). Null when
   * the vehicle has never had a trip (~13% of the source).
   *
   * NOTE the timezone asymmetry vs `gpsDatetime`: this is a MySQL TIMESTAMP, which the server converts
   * to the session zone on read (session = UTC), so it arrives ALREADY UTC and must NOT go through the
   * IST(+330) normalizer that `latest_gps_datetime` (a naive DATETIME) needs. See `mapping.ts`.
   */
  tripCreationDatetime?: Date | null;
  lat?: number | null;
  lon?: number | null;
  mainsStatus?: number | null;
  mainsVoltage?: number | null;
  gpsValidity?: string | null;
  gpsMode?: string | null;
  ignitionStatus?: string | null;
  speed?: number | null;
  creg?: string | null;
  cgreg?: string | null;
  csq?: number | null;
  ipAddress?: string | null;
  portNo?: number | null;
  simSubscriberName?: string | null;
  unitNo?: string | null;
  deviceType?: string | null;
}

export interface SourceChunk {
  rows: SourceSnapshotRow[];
  /** Opaque cursor to pass to the next `readChunk`; `null` when the source is exhausted. */
  nextCursor: string | null;
  /**
   * Rows carrying a real ping that the source reader's skew guard DROPPED, counted by reason — absent
   * when nothing was rejected (#222 P6).
   *
   * A rejected row leaves no trace anywhere else: it is not journalled, its device's watermark does not
   * advance, and the cursor rides the raw DB row rather than the mapped one, so the run's own counters
   * cannot tell a dropped row from a row that was never there. This field is the only place the drop is
   * observable, which is the entire justification for preferring rejection over silent acceptance.
   * Optional so non-AutoPlant readers (fixtures, CSV, in-memory) need no change.
   *
   * Since #299 this also carries `UNPARSEABLE_TIMESTAMP` — a row whose `latest_gps_datetime` is not a
   * timestamp at all. That used to be a *throw* rather than a count: it escaped the reader, the worker
   * read it as a source-read failure and stopped draining, and the deterministic `ORDER BY device_id`
   * scan then failed at the same row on every subsequent run.
   */
  rejected?: Record<string, number>;
  /**
   * Nullable telemetry FIELDS discarded for being out of range for their column, counted by reason,
   * with the row itself KEPT and ingested (#299 AR-2) — absent when nothing was out of range.
   *
   * Deliberately not folded into {@link rejected}. A rejection is a hole in the fleet's telemetry: that
   * device has no ping for this run. A repair is a data-quality fact about a device that reported
   * perfectly well and had one unusable reading. Summing them would produce a number that answers
   * neither question, and #300 has to alert on them differently.
   */
  repaired?: Record<string, number>;
}

export interface SourceReader {
  /** Read up to `chunkSize` rows after `cursor` (`null` = from the start). */
  readChunk(cursor: string | null, chunkSize: number): Promise<SourceChunk>;
}

/** Nest DI token — bind the real AutoPlant reader to this in production wiring. */
export const SOURCE_READER = Symbol('SOURCE_READER');

/**
 * Mock source backed by a fixed in-memory array, used to build and test the worker. Cursor is the
 * next start index encoded as a string. Returns a `null` cursor as soon as the source is exhausted,
 * so an evenly-dividing drain needs no extra empty read.
 */
export class InMemorySourceReader implements SourceReader {
  constructor(private readonly rows: readonly SourceSnapshotRow[]) {}

  async readChunk(cursor: string | null, chunkSize: number): Promise<SourceChunk> {
    const start = cursor === null ? 0 : Number(cursor);
    const slice = this.rows.slice(start, start + chunkSize);
    const nextIndex = start + slice.length;
    const exhausted = slice.length === 0 || nextIndex >= this.rows.length;
    return {
      rows: [...slice],
      nextCursor: exhausted ? null : String(nextIndex),
    };
  }
}
