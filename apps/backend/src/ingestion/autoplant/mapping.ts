import { normalizeGpsTimestamp, normalizeSourceRow, type RawSourceRow } from '../normalize';
import type { SourceSnapshotRow } from '../source-reader';
import { MIN_PLAUSIBLE_SOURCE_MS, isSourceBlank } from './source-sentinels';

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
const MIN_PLAUSIBLE_GPS_MS = MIN_PLAUSIBLE_SOURCE_MS;

/**
 * Why a row carrying a real ping was DROPPED — the whole row, nothing ingested. Reported through
 * {@link MapOptions.onReject}.
 *
 * `UNPARSEABLE_TIMESTAMP` is #299 (AR-1). Until then `normalizeSourceRow` threw straight out of this
 * function, out of the reader's row loop, and out of `readChunk` — where the worker reads any throw as
 * a *source read* failure and stops draining. Because the scan is deterministic (`ORDER BY device_id`,
 * restarted from `cursor = null` every run), one row with a malformed `latest_gps_datetime` therefore
 * killed every device sorting after it, in that run and in every future run, until somebody fixed the
 * source by hand. The throw in `normalize.ts` is the correct contract for a single row — a ping with no
 * usable instant is not recoverable — so containment belongs here, in the caller, not there.
 *
 * A dropped row is the last resort, used only when the row cannot exist without the value: the device
 * id and the ping instant. Anything else degrades to a null field — see {@link FieldRepairReason}.
 */
export type RowRejectionReason =
  | 'FUTURE_SKEW'
  | 'IMPLAUSIBLE_PAST'
  | 'UNPARSEABLE_TIMESTAMP'
  /**
   * #323 (AR-9c) — a device id that is a sentinel word rather than an id: `'NA'`, `'NULL'`, `'null'`.
   *
   * Reported because widening this path's sentinel set to match the masters path (adding `'NA'`) drops
   * rows it used to journal, and a behaviour change that removes data must be countable rather than
   * silent. A NULL or empty device id is deliberately NOT reported: that is the source's ordinary
   * "vehicle with no fitted device" shape, tens of thousands of rows, and counting it would bury every
   * real signal in this channel.
   */
  | 'SENTINEL_DEVICE_ID';

/**
 * Why one nullable telemetry FIELD was discarded while its row was kept — #299 (AR-2). Reported
 * through {@link MapOptions.onRepair}, counted separately from {@link RowRejectionReason} because
 * "we dropped this device's ping" and "we dropped one reading off it" are different operational facts
 * and #300 has to be able to tell them apart.
 *
 * **The defect this closes.** Nothing validated a coerced value against the column it was bound for,
 * and `createMany` is atomic per chunk: one `mains_status` of 99999 going into a SmallInt failed its
 * whole 90-row chunk, deterministically, through all three retries, every 30 minutes, forever. The run
 * then finalised PARTIAL and the #230 gate correctly refused to derive device state, recover devices or
 * create tickets — **fleet-wide, on every tick**. The gate is right (freeze beats fabrication); the
 * blast radius of one bad reading is the defect.
 *
 * **Why the field is nulled rather than the row rejected** (operator ruling, 2026-09-02; #299's text
 * said reject the row). Two reasons, and the first is this file's own convention: a *malformed* value
 * in these same columns already degrades to null and keeps the row — `coerceMainsStatus('abc')`,
 * `coerceNumeric`, `parseTripCreation` all do exactly that. Rejecting the row for an *out-of-range*
 * value would have made one column behave two different ways depending on whether its garbage happened
 * to be numeric. Second, and operationally: the load-bearing content of the row is the device id and
 * the ping instant. Dropping it because a voltage reading is nonsense makes a live device look dark,
 * which climbs `inactivity_hours` and manufactures a Troubleshoot Ticket for a device that is fine —
 * the platform reporting a fault it invented. A nulled field costs one reading and is counted.
 */
export type FieldRepairReason =
  | 'RANGE_LAT'
  | 'RANGE_LON'
  | 'RANGE_SPEED'
  | 'RANGE_MAINS_STATUS'
  | 'RANGE_MAINS_VOLTAGE'
  | 'RANGE_CSQ';

/** Postgres `smallint` — the column type behind `mains_status` and `csq`. */
const SMALLINT_MIN = -32_768;
const SMALLINT_MAX = 32_767;

/**
 * `Decimal(12, 2)` — `mains_voltage` and `speed`. Precision 12 with scale 2 leaves ten integer digits,
 * so anything at or beyond 10^10 overflows the column. Scale is NOT enforced here: Postgres rounds a
 * value with too many decimal places, which is a lossless-enough coercion that never errors, whereas
 * exceeding the precision raises `numeric field overflow` and takes the chunk with it.
 */
const DECIMAL_12_2_LIMIT = 10 ** 10;

/**
 * Keep a value only if it is finite and inside `[min, max]`; otherwise null it and say why.
 *
 * Null in, null out, with no report — an absent reading is the source's normal shape, not a fault, and
 * counting it would bury the real ones. Same discipline as `onReject` not firing for the ordinary skips.
 */
function withinOrNull(
  value: number | null,
  min: number,
  max: number,
  reason: FieldRepairReason,
  report: (reason: FieldRepairReason) => void,
): number | null {
  if (value === null) return null;
  if (Number.isFinite(value) && value >= min && value <= max) return value;
  report(reason);
  return null;
}

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

/**
 * #323 (AR-9c) — the sentinel vocabulary is shared with `master-mapping.ts` rather than spelled twice.
 *
 * This path used to omit `'NA'`, which the masters path has always had. The consequence was not a
 * cosmetic difference: a literal `'NA'` device id passed here and was journalled, while the masters
 * path refused to create the device, so it sat in `unknownDevices` permanently — telemetry unreachable,
 * warned about on every chunk, and no operator action could resolve it. One source, one answer.
 */
const isBlank = isSourceBlank;

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
  let parsed: Date;
  try {
    parsed = normalizeGpsTimestamp(v!.trim(), TRIP_CREATION_UTC_OFFSET_MIN);
  } catch {
    return null;
  }
  // #323 (CB-11) — the floor both siblings already had, and the only one of the three that lacked it.
  // MySQL's `0000-00-00 00:00:00` satisfies the naive-timestamp grammar, so without this a device whose
  // only trip stamp is the sentinel had an instant near 1899-11-30 written into
  // `device_states.trip_creation_datetime` — a plausible-looking date no reader can distinguish from a
  // real one, which is strictly worse than the null it now becomes. Same fold as `parseInstalledAt`.
  return parsed.getTime() < MIN_PLAUSIBLE_GPS_MS ? null : parsed;
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
  /**
   * Called once per FIELD nulled by the range guard, with the row itself kept (#299 AR-2).
   *
   * Separate from {@link onReject} on purpose. Folding both into one counter would make "one device's
   * ping never arrived" and "one device's voltage reading was nonsense" the same number, and they are
   * not: the first is a hole in the fleet's telemetry, the second is a data-quality fact about a device
   * that reported perfectly well. #300 surfaces them differently, so they are counted differently here.
   */
  onRepair?: (deviceId: string, reason: FieldRepairReason) => void;
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
  if (isBlank(row.device_id)) {
    // #323 — a non-empty sentinel word is worth naming; a NULL/empty id is the ordinary no-device row.
    const raw = row.device_id?.trim();
    if (raw) opts.onReject?.(raw, 'SENTINEL_DEVICE_ID');
    return null;
  }
  if (isBlank(row.latest_gps_datetime)) return null;

  const deviceId = row.device_id!.trim();
  const offsetMinutes = opts.offsetMinutes ?? AUTOPLANT_UTC_OFFSET_MIN;
  const { mainsStatus, mainsVoltage } = parseGpssignal(row.gpssignal);
  const repair = (reason: FieldRepairReason): void => opts.onRepair?.(deviceId, reason);

  // #299 (AR-2) — every value bound for a constrained column is checked against that column's real
  // bounds HERE, where a bad reading costs one field, rather than at `createMany`, where it costs the
  // whole 90-row chunk atomically and does so again on all three retries and on every tick thereafter.
  //
  // `lat`/`lon`/`speed` go through `coerceNumeric` first. They are typed `number | null` but arrive
  // from MySQL, where a numeric column can surface as a string, and `speed` in particular reached the
  // Decimal(12,2) column completely unguarded — it never passed through any of this file's coercers.
  // `coerceNumeric` also removes NaN/Infinity, which `withinOrNull` would reject anyway but which have
  // no business reaching a bound check in the first place.
  const lat = withinOrNull(coerceNumeric(row.latitude), -90, 90, 'RANGE_LAT', repair);
  const lon = withinOrNull(coerceNumeric(row.longitude), -180, 180, 'RANGE_LON', repair);
  const speed = withinOrNull(
    coerceNumeric(row.speed),
    -DECIMAL_12_2_LIMIT,
    DECIMAL_12_2_LIMIT,
    'RANGE_SPEED',
    repair,
  );

  const raw: RawSourceRow = {
    deviceId,
    gpsWallClock: row.latest_gps_datetime!.trim(),
    sourceUtcOffsetMinutes: offsetMinutes,
    lat,
    lon,
    speed,
    ignitionStatus: isBlank(row.IGNITION_STATUS) ? null : row.IGNITION_STATUS!.trim(),
    deviceType: isBlank(row.DEVICE_TYPE) ? null : row.DEVICE_TYPE!.trim(),
    // Already-UTC (TIMESTAMP), so it does NOT take `offsetMinutes` — see parseTripCreation.
    tripCreationDatetime: parseTripCreation(row.TRIP_CREATION_DATETIME),
    mainsStatus: withinOrNull(mainsStatus, SMALLINT_MIN, SMALLINT_MAX, 'RANGE_MAINS_STATUS', repair),
    mainsVoltage: withinOrNull(
      mainsVoltage,
      -DECIMAL_12_2_LIMIT,
      DECIMAL_12_2_LIMIT,
      'RANGE_MAINS_VOLTAGE',
      repair,
    ),
    // Not present anywhere in ap_widgets — stay null (Technical Hints degrade gracefully).
    gpsValidity: null,
    gpsMode: null,
    creg: null,
    cgreg: null,
    // `ap_widgets` exposes no CSQ, so this is null by construction today and the guard is a no-op. It is
    // written anyway so the guarded set matches the *column* set rather than today's accident of which
    // columns happen to carry values — a later slice giving `csq` a source cannot reintroduce AR-2 by
    // forgetting it. Same for `port_no` below, which is an Int and would overflow just as atomically.
    csq: withinOrNull(null, SMALLINT_MIN, SMALLINT_MAX, 'RANGE_CSQ', repair),
    ipAddress: null,
    portNo: null,
    simSubscriberName: null,
    unitNo: null,
  };

  // #299 (AR-1) — the one throw on this path, contained at its only caller. `normalizeGpsTimestamp`
  // rejects a wall clock that does not match the naive-timestamp grammar, which is right for one row and
  // catastrophic for the scan: uncaught, it escapes `readChunk`, the worker reads it as a source-read
  // failure and stops draining, and because the scan restarts from `cursor = null` and orders by the
  // immutable `device_id`, every device sorting after the bad one is never ingested again. The row is
  // dropped and counted instead; the scan walks past it. `parseTripCreation` has always taken exactly
  // this posture for its own field.
  let normalized: SourceSnapshotRow;
  try {
    normalized = normalizeSourceRow(raw);
  } catch {
    opts.onReject?.(deviceId, 'UNPARSEABLE_TIMESTAMP');
    return null;
  }

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
