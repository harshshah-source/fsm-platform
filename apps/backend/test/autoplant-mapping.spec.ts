import {
  AUTOPLANT_UTC_OFFSET_MIN,
  coerceMainsStatus,
  coerceNumeric,
  mapVehicleMasterRow,
  parseGpssignal,
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
  it('preserves a leading-zero IMEI verbatim and normalizes IST→UTC', () => {
    const row = mapVehicleMasterRow(IMEI_ROW, { now: NOW });
    expect(row).not.toBeNull();
    expect(row!.deviceId).toBe('0869925073271551');
    // 05:57:47 IST − 330 min = 00:27:47 UTC.
    expect(row!.gpsDatetime.toISOString()).toBe('2026-07-02T00:27:47.000Z');
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

  it('exposes the IST offset constant', () => {
    expect(AUTOPLANT_UTC_OFFSET_MIN).toBe(330);
  });
});
