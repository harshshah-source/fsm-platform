import { normalizeSourceRow, type RawSourceRow } from '../normalize';
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
