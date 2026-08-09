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

/**
 * AutoPlant source timestamps are **UTC**, so no offset is applied. Configurable per §10.
 *
 * **Corrected 2026-08-09 (#222). This constant was `330` and it was wrong from the day it was
 * written** — `ap_widgets.tb_vehiclemaster.latest_gps_datetime` is a naive MySQL `DATETIME`, but
 * AutoPlant writes UTC into it. FSM therefore stored every ping 5.5 h earlier than it happened,
 * inflating `inactivity_hours` fleet-wide and fabricating 434 of the 665 devices in the CRITICAL band.
 *
 * Established by two independent measurements, neither of which is an inference from the column type:
 *
 *   1. **95 snapshot runs time-travelled.** `raw_device_snapshots.gps_datetime` holds the
 *      post-conversion value and `snapshot_runs` records when each run ran, so per-run
 *      `percentile(finished_at − gps_datetime)` reconstructs the contract at every past instant.
 *      Every run since the first on 2026-07-07 sits in a **5.52–5.65 h band — flat, no discontinuity**.
 *      A vendor change would show a step. There was none: it was never IST.
 *   2. **A second column, a different method.** `FIRST_INSTALLED_DATE_TIME` (also a naive `DATETIME`)
 *      agrees to the minute with `device_installation_date` (a `TIMESTAMP` in the same row, which the
 *      server returns already-UTC) across **17,985 devices at exactly 0 minutes, zero at ±330**.
 *
 * So "naive `DATETIME` ⇒ IST" is wrong as a house rule for this source, not merely for this column.
 *
 * **Why the original verification said otherwise, on real data.** The 2026-07-17 probe compared
 * `MAX(latest_gps_datetime)` (11:49:46) against an IST wall clock (11:50) and concluded the column
 * tracked IST. It was reading **5 devices out of 56,564** — three plants that genuinely write IST into
 * this UTC column — and those 5 alone decide the maximum. **`MAX()` is not a valid probe for a source
 * contract**: it reports the most extreme writer, not the convention. Use percentiles. That trap fired
 * three separate times during the investigation, including on the investigator.
 *
 * Those ~5 IST-writers are now rejected by the two-directional guard below rather than silently
 * accepted — see {@link DEFAULT_MAX_FUTURE_SKEW_MINUTES}.
 */
export const AUTOPLANT_UTC_OFFSET_MIN = 0;

/**
 * `TRIP_CREATION_DATETIME` is a MySQL **TIMESTAMP** — stored as a UTC epoch and converted by the SERVER
 * into the session timezone on read. The AutoPlant session zone is UTC (`@@system_time_zone` = UTC,
 * `@@session.time_zone` = SYSTEM), so it arrives ALREADY in UTC.
 *
 * This is now the same value as {@link AUTOPLANT_UTC_OFFSET_MIN} and is deliberately kept separate.
 * The two columns arrive UTC for **different reasons** — this one because the server converted it, that
 * one because AutoPlant writes UTC into a column nothing converts — and only one of those reasons is a
 * property of MySQL. Collapsing them into one constant would encode the coincidence and lose the
 * distinction that took #222 a month to recover.
 */
const TRIP_CREATION_UTC_OFFSET_MIN = 0;

/**
 * How far AHEAD of `now` a `latest_gps_datetime` may sit before the row is rejected (§6.6).
 *
 * **Tightened 24 h → 1 h in the same release as the constant flip (#222 P6, operator 2026-08-09) —
 * not as a follow-up.** With the offset at 0, the ~5 devices that genuinely write IST into this UTC
 * column land at `now + 5:30`, which the old 24 h tolerance accepted. `device-state.service.ts` then
 * clamps their negative `inactivity_hours` to 0 (`GREATEST(0, …)`), so they would read as
 * **permanently fresh** — never inactive, never eligible for a Troubleshoot Ticket, however long they
 * actually stay dark. Flipping the constant without tightening this converts a visible fleet-wide
 * 5.5 h error into five permanently invisible devices.
 *
 * 1 h is far wider than any honest disagreement: the source clock is accurate to the second
 * (measured 15 s) and the widest observed read gap is ~27 min. It is narrower than 5:30 by design.
 */
const DEFAULT_MAX_FUTURE_SKEW_MINUTES = 60;

/**
 * The past-direction floor, and a deliberately modest one: **the year 2000**.
 *
 * #222 proposed rejecting "a ping older than the fleet p99 by a wide margin". **That is not built, and
 * should not be.** A device silent for a year is not implausible data — it is the finding this platform
 * exists to produce, and #223 is entirely about devices whose telemetry is *absent*. A past guard tuned
 * to fleet percentiles would drop exactly the devices the system is meant to catch, and it would fail
 * toward "fine" in precisely the way #228 describes.
 *
 * What a per-row past guard CAN do is reject sentinels: MySQL's `0000-00-00 00:00:00` zero-date and
 * epoch garbage both satisfy the naive-timestamp grammar and would otherwise be journalled as genuine
 * pings. Same floor and same reasoning as `parseInstalledAt`'s `MIN_PLAUSIBLE_INSTALL_MS`.
 *
 * **What this guard does NOT catch, stated plainly:** a *systematic* offset — #222 itself. A row shifted
 * 5.5 h into the past is indistinguishable, per row, from a device that pinged 5.5 h ago. Only a
 * distributional check over a whole run can see it (the per-run percentile in the note above, which is
 * what would have caught this on 2026-07-07). That check is [#228](../../../../.scratch/fsm-platform-v1/issues/228-guard-pattern-remediation.md)'s
 * R2 and is not built here; this constant must not be mistaken for it.
 */
const MIN_PLAUSIBLE_GPS_MS = Date.UTC(2000, 0, 1);

/** Why a row carrying a real ping was dropped. Reported through {@link MapOptions.onReject}. */
export type RowRejectionReason = 'FUTURE_SKEW' | 'IMPLAUSIBLE_PAST';

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
  /** Injectable clock for the skew guard (defaults to real time). */
  now?: Date;
  /** How far ahead of `now` a `latest_gps_datetime` may be before the row is dropped as bogus. */
  maxSkewMinutes?: number;
  /** Source UTC offset in minutes (0 — the source is UTC; see {@link AUTOPLANT_UTC_OFFSET_MIN}). */
  offsetMinutes?: number;
  /**
   * Called once per row DROPPED by the skew guard, so a rejection is countable rather than silent.
   *
   * P6's whole justification is that *"a dropped device is visible as a gap; a permanently-healthy
   * device is invisible"* — which only holds if something actually looks. Before this, the reader
   * discarded rejected rows with `if (row) mapped.push(row)` and no counter anywhere, so the five
   * IST-writers would have vanished as quietly as they previously persisted. Not fired for the two
   * ordinary skips (no fitted device, never pinged): those are the source's normal shape, not a fault.
   */
  onReject?: (deviceId: string, reason: RowRejectionReason) => void;
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

  // Two-directional skew guard (#222 Proposed step 5 / P6). Both arms reject; neither is silent.
  const now = opts.now ?? new Date();
  const maxSkewMs = (opts.maxSkewMinutes ?? DEFAULT_MAX_FUTURE_SKEW_MINUTES) * 60_000;
  const at = normalized.gpsDatetime.getTime();
  if (at > now.getTime() + maxSkewMs) {
    opts.onReject?.(raw.deviceId, 'FUTURE_SKEW');
    return null;
  }
  if (at < MIN_PLAUSIBLE_GPS_MS) {
    opts.onReject?.(raw.deviceId, 'IMPLAUSIBLE_PAST');
    return null;
  }

  return normalized;
}
