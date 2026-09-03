import {
  AUTOPLANT_UTC_OFFSET_MIN,
  coerceMainsStatus,
  coerceNumeric,
  mapVehicleMasterRow,
  parseGpssignal,
  parseTripCreation,
  type VehicleMasterRow,
} from '../src/ingestion/autoplant/mapping';

/**
 * Phase 3 — pure AutoPlant→FSM mapping for `tb_vehiclemaster` (+ `gpssignal` JSON). Fixtures are real
 * sampled rows (docs/autoplant_databaseData.md): a leading-zero IMEI, an alphanumeric WheelsEye vendor
 * id, and the "1"/"ON" mains-status vocabularies. Timestamps are IST (+330) naive wall-clock strings.
 */

// A real leading-zero-IMEI row (vehicle AP02TA2569).
const IMEI_ROW: VehicleMasterRow = {
  device_id: '0869925073271551',
  latest_gps_datetime: '2026-07-02 05:57:47',
  latitude: 14.717841,
  longitude: 76.55386,
  speed: 0,
  IGNITION_STATUS: null,
  DEVICE_TYPE: 'V5',
  gpssignal: { power: { mainstatus: '1', mainvoltage: null } },
};

// A real 3rd-party WheelsEye row: device_id == vehicle_no, alphanumeric, ON/OFF vocab.
const WHEELSEYE_ROW: VehicleMasterRow = {
  device_id: 'AP03TC0959',
  latest_gps_datetime: '2026-07-02 05:57:25',
  latitude: 12.9239583333333,
  longitude: 79.1111979166667,
  speed: 0,
  IGNITION_STATUS: 'OFF',
  DEVICE_TYPE: 'VENDOR_GPS',
  gpssignal: { power: { mainstatus: 'ON', mainvoltage: null } },
};

const NOW = new Date('2026-07-02T12:00:00Z'); // well after both sample gps datetimes

describe('Phase 3 — coerceMainsStatus', () => {
  it('maps numeric strings, the ON/OFF vocab, and rejects the rest', () => {
    expect(coerceMainsStatus('1')).toBe(1);
    expect(coerceMainsStatus('0')).toBe(0);
    expect(coerceMainsStatus('ON')).toBe(1);
    expect(coerceMainsStatus('on')).toBe(1);
    expect(coerceMainsStatus('OFF')).toBe(0);
    expect(coerceMainsStatus('off')).toBe(0);
    expect(coerceMainsStatus(null)).toBeNull();
    expect(coerceMainsStatus('')).toBeNull();
    expect(coerceMainsStatus('garbage')).toBeNull();
  });
});

describe('Phase 3 — coerceNumeric', () => {
  it('parses numeric strings and nulls the unparseable', () => {
    expect(coerceNumeric('0')).toBe(0);
    expect(coerceNumeric('4056')).toBe(4056);
    expect(coerceNumeric('25115')).toBe(25115);
    expect(coerceNumeric('4.5')).toBe(4.5);
    expect(coerceNumeric(null)).toBeNull();
    expect(coerceNumeric('')).toBeNull();
    expect(coerceNumeric('abc')).toBeNull();
  });
});

describe('Phase 3 — parseGpssignal', () => {
  it('extracts power fields from a parsed object', () => {
    expect(parseGpssignal({ power: { mainstatus: '1', mainvoltage: '4056' } })).toEqual({
      mainsStatus: 1,
      mainsVoltage: 4056,
    });
  });

  it('accepts a JSON string (defensive; mysql2 usually pre-parses json columns)', () => {
    expect(parseGpssignal('{"power":{"mainstatus":"0","mainvoltage":"25115"}}')).toEqual({
      mainsStatus: 0,
      mainsVoltage: 25115,
    });
  });

  it('degrades to nulls for null / missing power / malformed json', () => {
    expect(parseGpssignal(null)).toEqual({ mainsStatus: null, mainsVoltage: null });
    expect(parseGpssignal({ epf: null })).toEqual({ mainsStatus: null, mainsVoltage: null });
    expect(parseGpssignal('not json')).toEqual({ mainsStatus: null, mainsVoltage: null });
  });
});

describe('Phase 3 — mapVehicleMasterRow', () => {
  it('preserves a leading-zero IMEI verbatim and reads the wall clock as UTC (#222)', () => {
    const row = mapVehicleMasterRow(IMEI_ROW, { now: NOW });
    expect(row).not.toBeNull();
    expect(row!.deviceId).toBe('0869925073271551');
    // `latest_gps_datetime` is a naive MySQL DATETIME that AutoPlant writes in UTC — so the instant IS
    // the wall clock. Pinned as a literal, not derived from the constant: a test that recomputes the
    // expectation from the value under test passes at any offset and proves nothing (#222/#228).
    expect(row!.gpsDatetime.toISOString()).toBe('2026-07-02T05:57:47.000Z');
    expect(row!.lat).toBe(14.717841);
    expect(row!.lon).toBe(76.55386);
    expect(row!.speed).toBe(0);
    expect(row!.deviceType).toBe('V5');
    expect(row!.mainsStatus).toBe(1);
    // Fields absent from ap_widgets stay null (memory: 7 fields null forever).
    expect(row!.gpsValidity).toBeNull();
    expect(row!.csq).toBeNull();
  });

  it('preserves an alphanumeric vendor id and maps the ON mains vocab', () => {
    const row = mapVehicleMasterRow(WHEELSEYE_ROW, { now: NOW });
    expect(row!.deviceId).toBe('AP03TC0959');
    expect(row!.ignitionStatus).toBe('OFF');
    expect(row!.mainsStatus).toBe(1); // "ON" → 1
  });

  it('skips a row with no fitted device (NULL / empty / "NULL" device_id)', () => {
    expect(mapVehicleMasterRow({ ...IMEI_ROW, device_id: null }, { now: NOW })).toBeNull();
    expect(mapVehicleMasterRow({ ...IMEI_ROW, device_id: '' }, { now: NOW })).toBeNull();
    expect(mapVehicleMasterRow({ ...IMEI_ROW, device_id: 'NULL' }, { now: NOW })).toBeNull();
  });

  it('skips a device that never pinged (NULL latest_gps_datetime)', () => {
    expect(mapVehicleMasterRow({ ...IMEI_ROW, latest_gps_datetime: null }, { now: NOW })).toBeNull();
  });

  it('guards against a bogus future timestamp (dead device must not look active)', () => {
    const future: VehicleMasterRow = { ...IMEI_ROW, latest_gps_datetime: '2027-01-01 00:00:00' };
    expect(mapVehicleMasterRow(future, { now: NOW, maxSkewMinutes: 60 })).toBeNull();
  });

  /**
   * #222 — replaces `expect(AUTOPLANT_UTC_OFFSET_MIN).toBe(330)`, which pinned the WRONG value in place
   * for a month and would have gone red on the correct fix. The constant's value is not the contract;
   * the contract is that a source wall clock maps to the same instant. Asserted through the mapper
   * against a literal, so the check cannot be satisfied by an offset agreeing with itself.
   */
  it('applies NO offset to the source wall clock — the contract, not the constant (#222)', () => {
    expect(AUTOPLANT_UTC_OFFSET_MIN).toBe(0);
    const row = mapVehicleMasterRow(
      { ...IMEI_ROW, latest_gps_datetime: '2026-08-07 09:58:34' },
      { now: new Date('2026-08-07T10:02:00Z') },
    );
    expect(row!.gpsDatetime.toISOString()).toBe('2026-08-07T09:58:34.000Z');
  });

  it('gpsDatetime and gpsDatetimeUtc have converged (#222 — the dual-write can retire)', () => {
    const row = mapVehicleMasterRow(IMEI_ROW, { now: NOW });
    expect(row!.gpsDatetimeUtc?.toISOString()).toBe(row!.gpsDatetime.toISOString());
  });
});

/**
 * #222 Proposed step 5 / P6 — the skew guard must reject in BOTH directions.
 *
 * Before this, `mapping.ts` rejected only a timestamp ahead of `now`, and by 24 h, so the ~5 AutoPlant
 * devices that genuinely write IST into the UTC `latest_gps_datetime` column sailed through at now+5.5 h.
 * `device-state.service.ts` then clamps a negative `inactivity_hours` to 0 via `GREATEST(0, …)`, which
 * makes such a device read as **permanently fresh** — never inactive, never ticketed, no matter how long
 * it is really dark. Operator (P6, 2026-08-09): *"the ~5 IST-writing devices … read as permanently
 * fresh — worse than being dropped."* A rejected row leaves a visible gap; a permanently-healthy device
 * is invisible. So the future tolerance is tightened below 5.5 h and the drop is COUNTED, not silent.
 */
describe('#222 — two-directional skew guard', () => {
  const AT = new Date('2026-08-07T10:00:00Z');

  it('rejects the IST-writer signature: a ping 5.5 h in the future (P6)', () => {
    // 15:30 written into a UTC column at 10:00 UTC — exactly what the ~5 IST-writers produce once the
    // offset is 0. Under the old 24 h future tolerance this row was ACCEPTED.
    const istWriter: VehicleMasterRow = { ...IMEI_ROW, latest_gps_datetime: '2026-08-07 15:30:00' };
    expect(mapVehicleMasterRow(istWriter, { now: AT })).toBeNull();
  });

  it('still accepts a ping inside the honest read-gap tolerance', () => {
    // Source read and our clock differ by seconds in practice (measured: 15 s); minutes is generous.
    const slightlyAhead: VehicleMasterRow = { ...IMEI_ROW, latest_gps_datetime: '2026-08-07 10:05:00' };
    expect(mapVehicleMasterRow(slightlyAhead, { now: AT })).not.toBeNull();
  });

  it('rejects a sentinel/epoch timestamp in the far past', () => {
    // MySQL's zero-date and epoch garbage both satisfy the naive-timestamp grammar and would otherwise
    // be journalled as real pings — the same sentinel class `parseInstalledAt` already guards.
    expect(mapVehicleMasterRow({ ...IMEI_ROW, latest_gps_datetime: '1970-01-01 00:00:00' }, { now: AT }))
      .toBeNull();
  });

  it('does NOT reject a genuinely silent device — the signal this platform exists to catch', () => {
    // A year-old ping is not implausible, it is the finding. A past guard tuned to fleet percentiles
    // would drop exactly the devices #223 is about; the past floor is a sentinel check, nothing more.
    const longSilent: VehicleMasterRow = { ...IMEI_ROW, latest_gps_datetime: '2025-01-05 04:10:00' };
    const row = mapVehicleMasterRow(longSilent, { now: AT });
    expect(row).not.toBeNull();
    expect(row!.gpsDatetime.toISOString()).toBe('2025-01-05T04:10:00.000Z');
  });

  it('reports every rejection with a reason, so a drop is visible rather than silent', () => {
    const seen: Array<{ deviceId: string; reason: string }> = [];
    const onReject = (deviceId: string, reason: string) => seen.push({ deviceId, reason });

    mapVehicleMasterRow({ ...IMEI_ROW, latest_gps_datetime: '2026-08-07 15:30:00' }, { now: AT, onReject });
    mapVehicleMasterRow({ ...IMEI_ROW, latest_gps_datetime: '1970-01-01 00:00:00' }, { now: AT, onReject });

    expect(seen.map((s) => s.reason)).toEqual(['FUTURE_SKEW', 'IMPLAUSIBLE_PAST']);
    expect(new Set(seen.map((s) => s.deviceId))).toEqual(new Set(['0869925073271551']));
  });

  it('does not fire onReject for the ordinary skips (no device / never pinged)', () => {
    const seen: string[] = [];
    const onReject = (_d: string, reason: string) => seen.push(reason);
    mapVehicleMasterRow({ ...IMEI_ROW, device_id: null }, { now: AT, onReject });
    mapVehicleMasterRow({ ...IMEI_ROW, latest_gps_datetime: null }, { now: AT, onReject });
    expect(seen).toEqual([]);
  });
});

/**
 * TRIP_CREATION_DATETIME — a MySQL TIMESTAMP the server has already converted into the session zone
 * (UTC) before we see it, so it is read verbatim.
 *
 * **The asymmetry this block was written to pin is GONE (#222).** It originally guarded against
 * `TRIP_CREATION_DATETIME` being run through the IST(+330) normalizer that `latest_gps_datetime` was
 * believed to need. That belief was wrong — the DATETIME column is UTC too — so both timestamps now
 * take offset 0 and there is no asymmetry left to protect. The block is kept because reading a TIMESTAMP
 * verbatim is still the contract, but every assertion below is pinned against a LITERAL: an expectation
 * computed from `AUTOPLANT_UTC_OFFSET_MIN` is now trivially satisfied (subtracting zero) and would pass
 * against any future regression of the constant. That is the #228 trap, one layer down.
 */
describe('Phase 3 — parseTripCreation (already-UTC TIMESTAMP)', () => {
  it('reads the wall clock as UTC — NOT shifted by the IST offset', () => {
    // Live-source shape (2026-07-17): server NOW() UTC 06:20:32, newest TRIP_CREATION 06:19:02.
    expect(parseTripCreation('2026-07-17 06:19:02')?.toISOString()).toBe('2026-07-17T06:19:02.000Z');
  });

  it('never applies a 330-minute shift, whatever the configured offset becomes', () => {
    const t = parseTripCreation('2026-07-13 08:36:27')!;
    // Literal 330, NOT AUTOPLANT_UTC_OFFSET_MIN: the constant is 0 today, so deriving the "wrong"
    // instant from it would compare the value against itself and assert nothing.
    const istShifted = new Date('2026-07-13T08:36:27Z').getTime() - 330 * 60_000;
    expect(t.getTime()).not.toBe(istShifted);
    expect(t.toISOString()).toBe('2026-07-13T08:36:27.000Z');
  });

  it('degrades to null for absent/blank/garbage instead of throwing (must never drop a real GPS ping)', () => {
    expect(parseTripCreation(null)).toBeNull();
    expect(parseTripCreation(undefined)).toBeNull();
    expect(parseTripCreation('')).toBeNull();
    expect(parseTripCreation('NULL')).toBeNull();
    expect(parseTripCreation('not-a-timestamp')).toBeNull();
  });

  it('carries trip creation onto the mapped snapshot row alongside the ping', () => {
    const row = mapVehicleMasterRow(
      { ...IMEI_ROW, TRIP_CREATION_DATETIME: '2026-07-02 04:30:00' },
      { now: NOW },
    );
    // Both columns are UTC, so both are verbatim — the DATETIME/TIMESTAMP distinction no longer
    // changes the answer, only the reason each is read the way it is (#222).
    expect(row?.gpsDatetime.toISOString()).toBe('2026-07-02T05:57:47.000Z');
    expect(row?.tripCreationDatetime?.toISOString()).toBe('2026-07-02T04:30:00.000Z');
  });

  it('maps a row with no trip stamp at all to a null trip creation (13% of the source)', () => {
    expect(mapVehicleMasterRow(WHEELSEYE_ROW, { now: NOW })?.tripCreationDatetime).toBeNull();
  });
});


/**
 * #299 (AR-1 + AR-2) — row-level poison containment. Two independent modes each froze the WHOLE
 * pipeline indefinitely before this, and neither needed more than one bad source row.
 *
 * The scan is deterministic — `ORDER BY device_id`, restarted from `cursor = null` every run — so a
 * failure at one row is a failure at the *same* row on every future run. Combined with the #230 gate
 * (a run that is not SUCCESS skips device-state derivation, auto-recovery and ticket creation), one
 * unparseable timestamp or one out-of-range reading stopped the entire fleet's pipeline every 30
 * minutes until somebody edited the source by hand. The gate is correct; the blast radius was not.
 */
describe('#299 — one poison row cannot stop the scan', () => {
  const AT = new Date('2026-07-02T12:00:00Z');

  describe('AR-1: an unparseable latest_gps_datetime', () => {
    // The grammar `normalizeGpsTimestamp` enforces, and the shapes real sources produce that break it.
    const unparseable = ['not-a-date', '2026-13-45 99:99:99', '0000-00-00 00:00:00', '02/07/2026 05:57'];

    it.each(unparseable)('drops the row instead of throwing out of the scan: %s', (bad) => {
      const row = { ...IMEI_ROW, latest_gps_datetime: bad };
      // The assertion that matters is the absence of a throw. Before #299 this call propagated out of
      // `mapVehicleMasterRow`, out of the reader's row loop and out of `readChunk`, where the worker
      // reads any throw as a source-read failure and stops draining the source entirely.
      expect(() => mapVehicleMasterRow(row, { now: AT })).not.toThrow();
      expect(mapVehicleMasterRow(row, { now: AT })).toBeNull();
    });

    it('counts the drop with its own reason and device id, so the source row can be chased', () => {
      const seen: Array<{ deviceId: string; reason: string }> = [];
      mapVehicleMasterRow(
        { ...IMEI_ROW, latest_gps_datetime: 'not-a-date' },
        { now: AT, onReject: (deviceId, reason) => seen.push({ deviceId, reason }) },
      );
      expect(seen).toEqual([{ deviceId: '0869925073271551', reason: 'UNPARSEABLE_TIMESTAMP' }]);
    });

    it('leaves every other row untouched — the containment, not just the catch', () => {
      const good = mapVehicleMasterRow(WHEELSEYE_ROW, { now: AT });
      expect(good).not.toBeNull();
      mapVehicleMasterRow({ ...IMEI_ROW, latest_gps_datetime: 'not-a-date' }, { now: AT });
      // Mapping is pure, so this is really a statement about the loop that calls it: a poison row is
      // not a poison scan. `autoplant-source-reader.spec.ts` proves it over a real chunk.
      expect(mapVehicleMasterRow(WHEELSEYE_ROW, { now: AT })).toEqual(good);
    });
  });

  describe('AR-2: a value out of range for the column it is bound for', () => {
    /**
     * The operator ruling (2026-09-02) that shaped this: the field is nulled and the ROW IS KEPT.
     *
     * #299's text said reject the row. Two things argued the other way. This file already degrades a
     * *malformed* value in these same columns to null and keeps the row (`coerceMainsStatus('abc')`),
     * so rejecting for an *out-of-range* one would make one column behave two ways depending on
     * whether its garbage happened to be numeric. And operationally, the row's load-bearing content is
     * the device id and the ping instant: dropping it over a nonsense voltage makes a live device look
     * dark, climbs `inactivity_hours`, and manufactures a Troubleshoot Ticket for a healthy device.
     */
    const cases = [
      {
        label: 'mains_status beyond SmallInt (the measured AR-2 poison: 99999)',
        row: { ...IMEI_ROW, gpssignal: { power: { mainstatus: '99999', mainvoltage: null } } },
        reason: 'RANGE_MAINS_STATUS',
        field: 'mainsStatus' as const,
      },
      {
        label: 'mains_voltage beyond Decimal(12,2)',
        row: { ...IMEI_ROW, gpssignal: { power: { mainstatus: '1', mainvoltage: '1e11' } } },
        reason: 'RANGE_MAINS_VOLTAGE',
        field: 'mainsVoltage' as const,
      },
      {
        label: 'speed beyond Decimal(12,2) — the field that reached the column through no coercer at all',
        row: { ...IMEI_ROW, speed: 1e12 },
        reason: 'RANGE_SPEED',
        field: 'speed' as const,
      },
      { label: 'latitude outside [-90, 90]', row: { ...IMEI_ROW, latitude: 200 }, reason: 'RANGE_LAT', field: 'lat' as const },
      { label: 'longitude outside [-180, 180]', row: { ...IMEI_ROW, longitude: -1000 }, reason: 'RANGE_LON', field: 'lon' as const },
    ];

    it.each(cases)('nulls the field, keeps the ping, and says why: $label', ({ row, reason, field }) => {
      const seen: Array<{ deviceId: string; reason: string }> = [];
      const mapped = mapVehicleMasterRow(row, { now: AT, onRepair: (deviceId, r) => seen.push({ deviceId, reason: r }) });

      expect(mapped).not.toBeNull();
      expect(mapped![field]).toBeNull();
      // The device is still visibly alive — the whole reason the row is kept.
      expect(mapped!.deviceId).toBe('0869925073271551');
      expect(mapped!.gpsDatetime.toISOString()).toBe('2026-07-02T05:57:47.000Z');
      expect(seen).toEqual([{ deviceId: '0869925073271551', reason }]);
    });

    it('a repair is NOT a rejection — the two counters answer different questions', () => {
      const rejects: string[] = [];
      const repairs: string[] = [];
      mapVehicleMasterRow(
        { ...IMEI_ROW, gpssignal: { power: { mainstatus: '99999', mainvoltage: null } } },
        { now: AT, onReject: (_d, r) => rejects.push(r), onRepair: (_d, r) => repairs.push(r) },
      );
      expect(rejects).toEqual([]);
      expect(repairs).toEqual(['RANGE_MAINS_STATUS']);
    });

    it('keeps every in-range value, boundaries included — the guard must not eat good readings', () => {
      const seen: string[] = [];
      const edge = mapVehicleMasterRow(
        { ...IMEI_ROW, latitude: -90, longitude: 180, speed: 0, gpssignal: { power: { mainstatus: '-32768', mainvoltage: '12.5' } } },
        { now: AT, onRepair: (_d, r) => seen.push(r) },
      );
      expect(seen).toEqual([]);
      expect(edge).toMatchObject({ lat: -90, lon: 180, speed: 0, mainsStatus: -32768, mainsVoltage: 12.5 });
    });

    it('an absent reading is not a repair — null in, null out, uncounted', () => {
      const seen: string[] = [];
      const mapped = mapVehicleMasterRow(
        { ...IMEI_ROW, latitude: null, longitude: null, speed: null, gpssignal: null },
        { now: AT, onRepair: (_d, r) => seen.push(r) },
      );
      // A device that reports no position is the source's normal shape, not a data-quality fault;
      // counting it would bury the real ones. Same discipline as onReject and the ordinary skips.
      expect(seen).toEqual([]);
      expect(mapped).toMatchObject({ lat: null, lon: null, speed: null, mainsStatus: null });
    });

    it('coerces numeric strings and non-finite values on the way in', () => {
      const seen: string[] = [];
      // MySQL can surface a numeric column as a string; NaN/Infinity have no business reaching a bound
      // check. `speed` in particular used to pass through to Decimal(12,2) completely unguarded.
      const asStrings = mapVehicleMasterRow(
        { ...IMEI_ROW, latitude: '14.7' as never, longitude: '76.5' as never, speed: '42' as never },
        { now: AT, onRepair: (_d, r) => seen.push(r) },
      );
      expect(seen).toEqual([]);
      expect(asStrings).toMatchObject({ lat: 14.7, lon: 76.5, speed: 42 });

      const nonFinite = mapVehicleMasterRow({ ...IMEI_ROW, speed: Number.NaN }, { now: AT, onRepair: (_d, r) => seen.push(r) });
      expect(nonFinite!.speed).toBeNull();
      expect(seen).toEqual([]); // NaN is unparseable, not out of range — nulled by the coercer, as ever
    });
  });
});
