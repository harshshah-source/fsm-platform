import {
  mapVehicleMasterRow,
  parseTripCreation,
  type VehicleMasterRow,
} from '../src/ingestion/autoplant/mapping';
import { cleanStr, parseInstalledAt } from '../src/ingestion/autoplant/master-mapping';
import { MIN_PLAUSIBLE_SOURCE_MS, SOURCE_NULLISH } from '../src/ingestion/autoplant/source-sentinels';

/**
 * #323 (forensics CB-11 + AR-9c) — the two mapping files stop disagreeing about the same source.
 *
 * **CB-11.** `parseTripCreation` had no plausibility floor while both of its siblings did
 * (`MIN_PLAUSIBLE_GPS_MS` on the ping, `MIN_PLAUSIBLE_INSTALL_MS` on the fitment date). MySQL's
 * `0000-00-00 00:00:00` satisfies the naive-timestamp grammar, so for any device whose only trip stamp
 * is the sentinel it was written into `device_states.trip_creation_datetime` as an instant near
 * 1899-11-30 — a plausible-looking date that no reader can tell from a real one.
 *
 * **AR-9c.** Two `NULLISH` sets for one source: the snapshot path had `{'', 'NULL', 'null'}`, the
 * masters path added `'NA'`. A literal `'NA'` device id therefore passed the snapshot path and was
 * journalled, while the masters path refused to create the device — so it sat in `unknownDevices`
 * permanently, its telemetry unreachable, warned about on every chunk. One source cannot have two
 * answers to "is this value a sentinel?".
 *
 * Both are copy drift, so both are fixed by having one definition rather than two agreeing ones.
 */

const ROW: VehicleMasterRow = {
  device_id: '0869925073271551',
  latest_gps_datetime: '2026-07-02 05:57:47',
  latitude: 14.717841,
  longitude: 76.55386,
  speed: 0,
  IGNITION_STATUS: null,
  DEVICE_TYPE: 'V5',
  gpssignal: { power: { mainstatus: '1', mainvoltage: null } },
};

const NOW = new Date('2026-07-02T06:00:00Z');

describe('#323 CB-11 — no path can store a pre-floor trip timestamp', () => {
  it('folds the MySQL zero-date to null instead of an 1899 instant', () => {
    // The value the source actually sends. Before the floor this parsed to ~1899-11-30 and was stored.
    expect(parseTripCreation('0000-00-00 00:00:00')).toBeNull();
  });

  it('folds anything below the shared floor, and keeps everything above it', () => {
    expect(parseTripCreation('1970-01-01 00:00:00')).toBeNull(); // epoch garbage
    expect(parseTripCreation('1999-12-31 23:59:59')).toBeNull(); // one second under
    expect(parseTripCreation('2000-01-01 00:00:00')?.getTime()).toBe(MIN_PLAUSIBLE_SOURCE_MS);
    expect(parseTripCreation('2026-07-17 06:19:02')?.toISOString()).toBe('2026-07-17T06:19:02.000Z');
  });

  it('degrades the FIELD, never the row — the ping is still ingested', () => {
    // The posture the whole path depends on: trip creation is enrichment riding the telemetry read, so
    // a sentinel there must cost one column, not a device's ping (contrast `normalizeGpsTimestamp`).
    const mapped = mapVehicleMasterRow({ ...ROW, TRIP_CREATION_DATETIME: '0000-00-00 00:00:00' }, { now: NOW });
    expect(mapped).not.toBeNull();
    expect(mapped!.deviceId).toBe('0869925073271551');
    expect(mapped!.tripCreationDatetime).toBeNull();
  });

  it('is the same floor the other two parsers already used', () => {
    // One fact — "anything from this source before 2000 is a sentinel, not data" — so one constant.
    // Both siblings keep their own names and their own reasoning; only the value stopped being copied.
    expect(MIN_PLAUSIBLE_SOURCE_MS).toBe(Date.UTC(2000, 0, 1));
    expect(parseInstalledAt('0000-00-00 00:00:00')).toBeNull();
  });
});

describe('#323 AR-9c — one NULLISH vocabulary for one source', () => {
  it("includes 'NA' — the masters path's stricter reading is the shared one", () => {
    expect([...SOURCE_NULLISH].sort()).toEqual(['', 'NA', 'NULL', 'null']);
  });

  it.each(['', 'NA', 'NULL', 'null', '  NA  '])(
    'treats %p as absent on BOTH paths, not just the masters one',
    (sentinel) => {
      // Masters path: already correct, pinned so the shared set cannot regress it.
      expect(cleanStr(sentinel)).toBeNull();
      // Snapshot path: `'NA'` used to pass here and be journalled as a device id, which is what left it
      // in `unknownDevices` for ever — mastered nowhere, telemetry unreachable, warned every chunk.
      expect(mapVehicleMasterRow({ ...ROW, device_id: sentinel }, { now: NOW })).toBeNull();
    },
  );

  it('a real device id that merely contains a sentinel is untouched', () => {
    // The set is matched whole, not by substring: 'NA' is a sentinel, 'NA0123' is a WheelsEye-style id.
    expect(cleanStr('NA0123')).toBe('NA0123');
    expect(mapVehicleMasterRow({ ...ROW, device_id: 'NA0123' }, { now: NOW })?.deviceId).toBe('NA0123');
  });

  it('counts the sentinel-id drop so the widening is visible, and stays silent on a genuine blank', () => {
    // The issue's own regression note: widening the set drops rows the snapshot path used to journal,
    // and that has to be countable rather than silent. But a NULL/empty device id is the ordinary
    // "vehicle with no fitted device" case — the source's normal shape — and counting it would bury the
    // signal in tens of thousands of rows. Only a non-empty sentinel is reported.
    const rejected: [string, string][] = [];
    const onReject = (deviceId: string, reason: string): void => {
      rejected.push([deviceId, reason]);
    };

    expect(mapVehicleMasterRow({ ...ROW, device_id: 'NA' }, { now: NOW, onReject })).toBeNull();
    expect(rejected).toEqual([['NA', 'SENTINEL_DEVICE_ID']]);

    rejected.length = 0;
    expect(mapVehicleMasterRow({ ...ROW, device_id: null }, { now: NOW, onReject })).toBeNull();
    expect(mapVehicleMasterRow({ ...ROW, device_id: '' }, { now: NOW, onReject })).toBeNull();
    expect(rejected).toEqual([]);

    // A missing ping is likewise the ordinary skip, not a rejection — unchanged by this slice.
    rejected.length = 0;
    expect(mapVehicleMasterRow({ ...ROW, latest_gps_datetime: null }, { now: NOW, onReject })).toBeNull();
    expect(rejected).toEqual([]);
  });
});
