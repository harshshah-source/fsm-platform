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
