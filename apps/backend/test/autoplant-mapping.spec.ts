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
