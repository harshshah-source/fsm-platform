import { normalizeGpsTimestamp, normalizeSourceRow, type RawSourceRow } from '../normalize';
import type { SourceSnapshotRow } from '../source-reader';

/**
 * Pure AutoPlant → FSM mapping for the Snapshot path (Phase 3). Turns a `tb_vehiclemaster` row (the
 * current-state vehicle master in `ap_widgets`) into the canonical `SourceSnapshotRow` the ingestion
 * worker already consumes — device-id preserved verbatim (String), `gpssignal` JSON telemetry
 * extracted, and the IST wall-clock normalized to a true UTC instant via the existing `normalize.ts`.
 *
 * Everything here is a pure function so the mapping is unit-testable against recorded rows with no DB
 * or VPN. The reader (`autoplant-source-reader.ts`) is the only thing that touches MySQL.
 */

/** AutoPlant source timestamps are naive IST (+330). Kept as a named constant, configurable per §10. */
export const AUTOPLANT_UTC_OFFSET_MIN = 330;

/**
 * `TRIP_CREATION_DATETIME` needs a ZERO offset, not `AUTOPLANT_UTC_OFFSET_MIN` — the two source
 * timestamps do not share a timezone, despite sitting in the same row:
 *
 *   • `latest_gps_datetime` is a MySQL **DATETIME** — stored and returned as a naive wall clock the
 *     server never converts, and AutoPlant writes it in IST. Hence the +330 normalization.
 *   • `TRIP_CREATION_DATETIME` is a MySQL **TIMESTAMP** — stored as a UTC epoch and converted by the
 *     SERVER into the session timezone on read. The AutoPlant session zone is UTC
 *     (`@@system_time_zone` = UTC, `@@session.time_zone` = SYSTEM), so it arrives ALREADY in UTC.
 *
 * Verified against the live source 2026-07-17: server `NOW()` (UTC) 06:20:32 · newest
 * TRIP_CREATION 06:19:02 · newest `latest_gps_datetime` 11:49:46 · real IST wall clock 11:50. Running
 * trip creation through the IST normalizer would therefore shift every value 5.5h into the future.
 */
const TRIP_CREATION_UTC_OFFSET_MIN = 0;

/** Default tolerance for a `latest_gps_datetime` ahead of `now` before it is treated as bogus (§6.6). */
const DEFAULT_MAX_SKEW_MINUTES = 24 * 60;

/**
 * The `tb_vehiclemaster` columns the reader selects. `dateStrings:true` means datetimes arrive as raw
 * wall-clock strings; `gpssignal` is a MySQL json column (mysql2 returns it pre-parsed, but we accept a
 * string defensively). Only the load-bearing telemetry is mapped — the other `SourceSnapshotRow` fields
 * have no home in `ap_widgets` and stay null (see §1.3 / memory).
 */
export interface VehicleMasterRow {
  device_id: string | null;
  latest_gps_datetime: string | null;
  latitude: number | null;
  longitude: number | null;
  speed: number | null;
  IGNITION_STATUS: string | null;
  DEVICE_TYPE: string | null;
  /** Creation time of the vehicle's current trip. Optional: absent when a caller (or an older
   *  recorded fixture) selects only the original telemetry columns → maps to null. */
  TRIP_CREATION_DATETIME?: string | null;
  gpssignal: unknown;
}

const NULLISH = new Set(['', 'NULL', 'null']);

const isBlank = (v: string | null | undefined): boolean => v == null || NULLISH.has(v.trim());

/** `gpssignal.power.mainstatus` is `"1"`/`"0"` (AutoPlant) or `"ON"`/`"OFF"` (3rd-party) — normalize to 1/0/null. */
export function coerceMainsStatus(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s === '') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  const u = s.toUpperCase();
  if (u === 'ON') return 1;
  if (u === 'OFF') return 0;
  return null;
}

/** Parse a numeric telemetry string (e.g. `mainvoltage`), returning null for null/blank/unparseable. */
export function coerceNumeric(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Extract the two load-bearing power fields from the `gpssignal` json (object or string), null-safe. */
export function parseGpssignal(raw: unknown): { mainsStatus: number | null; mainsVoltage: number | null } {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = null;
    }
  }
  const power =
    obj && typeof obj === 'object' ? (obj as { power?: unknown }).power : null;
  if (!power || typeof power !== 'object') return { mainsStatus: null, mainsVoltage: null };
  const p = power as { mainstatus?: unknown; mainvoltage?: unknown };
  return { mainsStatus: coerceMainsStatus(p.mainstatus), mainsVoltage: coerceNumeric(p.mainvoltage) };
}

/**
 * Parse `TRIP_CREATION_DATETIME` (already-UTC wall clock, see {@link TRIP_CREATION_UTC_OFFSET_MIN}) to a
 * true instant. Null-safe and NON-throwing by design: this is enrichment riding the telemetry path, so a
 * blank or malformed trip stamp must degrade to null, never drop the row's actual GPS ping (contrast
 * `normalizeGpsTimestamp`, which throws — a bad `gps_datetime` is not recoverable).
 */
export function parseTripCreation(v: string | null | undefined): Date | null {
  if (isBlank(v)) return null;
  try {
    return normalizeGpsTimestamp(v!.trim(), TRIP_CREATION_UTC_OFFSET_MIN);
  } catch {
    return null;
  }
}

export interface MapOptions {
  /** Injectable clock for the future-timestamp guard (defaults to real time). */
  now?: Date;
  /** How far ahead of `now` a `latest_gps_datetime` may be before the row is dropped as bogus. */
  maxSkewMinutes?: number;
  /** Source UTC offset in minutes (IST default). */
  offsetMinutes?: number;
}

/**
 * Map one `tb_vehiclemaster` row to a normalized `SourceSnapshotRow`, or `null` when the row carries no
 * trackable ping (§6.6):
 *  - NULL / empty / `"NULL"` `device_id` — vehicle with no fitted device (skip; master-sync still sees it).
 *  - NULL `latest_gps_datetime` — device never pinged (nothing to record; the denominator row comes from
 *    the master, not here).
 *  - a `latest_gps_datetime` bogusly ahead of `now + skew` — a dead device must not look active.
 * The device id is preserved as an exact String (leading zeros / alphanumerics survive — the reason for §7).
 */
export function mapVehicleMasterRow(row: VehicleMasterRow, opts: MapOptions = {}): SourceSnapshotRow | null {
  if (isBlank(row.device_id) || isBlank(row.latest_gps_datetime)) return null;

  const offsetMinutes = opts.offsetMinutes ?? AUTOPLANT_UTC_OFFSET_MIN;
  const { mainsStatus, mainsVoltage } = parseGpssignal(row.gpssignal);

  const raw: RawSourceRow = {
    deviceId: row.device_id!.trim(),
    gpsWallClock: row.latest_gps_datetime!.trim(),
    sourceUtcOffsetMinutes: offsetMinutes,
    lat: row.latitude,
    lon: row.longitude,
    speed: row.speed,
    ignitionStatus: isBlank(row.IGNITION_STATUS) ? null : row.IGNITION_STATUS!.trim(),
    deviceType: isBlank(row.DEVICE_TYPE) ? null : row.DEVICE_TYPE!.trim(),
    // Already-UTC (TIMESTAMP), so it does NOT take `offsetMinutes` — see parseTripCreation.
    tripCreationDatetime: parseTripCreation(row.TRIP_CREATION_DATETIME),
    mainsStatus,
    mainsVoltage,
    // Not present anywhere in ap_widgets — stay null (Technical Hints degrade gracefully).
    gpsValidity: null,
    gpsMode: null,
    creg: null,
    cgreg: null,
    csq: null,
    ipAddress: null,
    portNo: null,
    simSubscriberName: null,
    unitNo: null,
  };

  const normalized = normalizeSourceRow(raw);

  const now = opts.now ?? new Date();
  const maxSkewMs = (opts.maxSkewMinutes ?? DEFAULT_MAX_SKEW_MINUTES) * 60_000;
  if (normalized.gpsDatetime.getTime() > now.getTime() + maxSkewMs) return null;

  return normalized;
}
