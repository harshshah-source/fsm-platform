import { describe, expect, it } from 'vitest';
import {
  buildTechnicalHealth,
  deriveTechnicalHints,
  pickTopHint,
  type HintDerivationInput,
} from '../src/me-tickets/technical-hints';

/**
 * #84 — Technical Hints derivation (PRD §641 Flow 14). Pure-function unit tests, no DB: each of the
 * eight conditions in isolation (others held at a non-triggering value), the multi-anomaly /
 * highest-severity case, and the `available:false` missing-snapshot case (exercised at the
 * `buildTechnicalHealth` level, since `deriveTechnicalHints` itself has no notion of "no row").
 */

/** A baseline input where NONE of the eight §641 conditions fire. */
const CLEAN: HintDerivationInput = {
  mainsStatus: 1,
  mainsVoltage: 12,
  csq: 20,
  gpsValidity: 'valid',
  gpsMode: 'fix',
  creg: 'registered',
  cgreg: 'registered',
  ignitionStatus: 'ON',
  speed: 0,
};

describe('#84 — deriveTechnicalHints', () => {
  it('fires no hints for a fully healthy snapshot', () => {
    expect(deriveTechnicalHints(CLEAN)).toEqual([]);
  });

  it('MAINS_STATUS=0 → "No main power — check fuse"', () => {
    const hints = deriveTechnicalHints({ ...CLEAN, mainsStatus: 0 });
    expect(hints).toEqual([{ code: 'NO_MAIN_POWER', severity: 8, label: 'No main power — check fuse' }]);
  });

  it('MAINS_VOLTAGE<10V → "Low voltage"', () => {
    const hints = deriveTechnicalHints({ ...CLEAN, mainsVoltage: 9.9 });
    expect(hints).toEqual([{ code: 'LOW_VOLTAGE', severity: 4, label: 'Low voltage' }]);
    // Boundary: exactly 10 must NOT fire (condition is strictly `< 10`).
    expect(deriveTechnicalHints({ ...CLEAN, mainsVoltage: 10 })).toEqual([]);
  });

  it('CSQ<=9 → "Weak GSM signal"', () => {
    const hints = deriveTechnicalHints({ ...CLEAN, csq: 9 });
    expect(hints).toEqual([{ code: 'WEAK_GSM', severity: 3, label: 'Weak GSM signal' }]);
    // Boundary: 10 must NOT fire (condition is `<= 9`).
    expect(deriveTechnicalHints({ ...CLEAN, csq: 10 })).toEqual([]);
  });

  it('GPS_VALIDITY=invalid → "GPS signal invalid" (case-insensitive)', () => {
    expect(deriveTechnicalHints({ ...CLEAN, gpsValidity: 'invalid' })).toEqual([
      { code: 'GPS_INVALID', severity: 6, label: 'GPS signal invalid' },
    ]);
    expect(deriveTechnicalHints({ ...CLEAN, gpsValidity: 'INVALID' })).toEqual([
      { code: 'GPS_INVALID', severity: 6, label: 'GPS signal invalid' },
    ]);
  });

  it('GPS_MODE="no fix" → "No GPS fix" (case-insensitive; matched literal is "no fix")', () => {
    expect(deriveTechnicalHints({ ...CLEAN, gpsMode: 'no fix' })).toEqual([
      { code: 'NO_GPS_FIX', severity: 5, label: 'No GPS fix' },
    ]);
    expect(deriveTechnicalHints({ ...CLEAN, gpsMode: 'No Fix' })).toEqual([
      { code: 'NO_GPS_FIX', severity: 5, label: 'No GPS fix' },
    ]);
  });

  it('CREG/CGREG="not registered" → "Not on network" (matched literal is "not registered")', () => {
    expect(deriveTechnicalHints({ ...CLEAN, creg: 'not registered' })).toEqual([
      { code: 'NOT_ON_NETWORK', severity: 7, label: 'Not on network' },
    ]);
    expect(deriveTechnicalHints({ ...CLEAN, cgreg: 'NOT REGISTERED' })).toEqual([
      { code: 'NOT_ON_NETWORK', severity: 7, label: 'Not on network' },
    ]);
  });

  it('Ignition=OFF → "Ignition off" (case-insensitive)', () => {
    expect(deriveTechnicalHints({ ...CLEAN, ignitionStatus: 'OFF' })).toEqual([
      { code: 'IGNITION_OFF', severity: 2, label: 'Ignition off' },
    ]);
    expect(deriveTechnicalHints({ ...CLEAN, ignitionStatus: 'off' })).toEqual([
      { code: 'IGNITION_OFF', severity: 2, label: 'Ignition off' },
    ]);
  });

  it('Speed>5km/h → "Vehicle in motion"', () => {
    expect(deriveTechnicalHints({ ...CLEAN, speed: 5.1 })).toEqual([
      { code: 'VEHICLE_IN_MOTION', severity: 1, label: 'Vehicle in motion' },
    ]);
    // Boundary: exactly 5 must NOT fire (condition is strictly `> 5`).
    expect(deriveTechnicalHints({ ...CLEAN, speed: 5 })).toEqual([]);
  });

  it('a multi-anomaly snapshot returns ALL firing hints (detail source), severity-descending', () => {
    const hints = deriveTechnicalHints({
      ...CLEAN,
      mainsStatus: 0, // NO_MAIN_POWER (8)
      mainsVoltage: 5, // LOW_VOLTAGE (4)
      speed: 40, // VEHICLE_IN_MOTION (1)
    });
    expect(hints.map((h) => h.code)).toEqual(['NO_MAIN_POWER', 'LOW_VOLTAGE', 'VEHICLE_IN_MOTION']);
  });

  it('a null field never itself matches a condition — no "no data" hint, simply absent', () => {
    const hints = deriveTechnicalHints({
      mainsStatus: null,
      mainsVoltage: null,
      csq: null,
      gpsValidity: null,
      gpsMode: null,
      creg: null,
      cgreg: null,
      ignitionStatus: null,
      speed: null,
    });
    expect(hints).toEqual([]);
  });
});

describe('#84 — pickTopHint (card source = single highest-severity hint)', () => {
  it('returns null for no hints', () => {
    expect(pickTopHint([])).toBeNull();
  });

  it('returns the single highest-severity hint when several fire simultaneously', () => {
    const hints = deriveTechnicalHints({
      ...CLEAN,
      mainsStatus: 0, // NO_MAIN_POWER (8) — highest
      csq: 5, // WEAK_GSM (3)
      ignitionStatus: 'OFF', // IGNITION_OFF (2)
    });
    expect(pickTopHint(hints)?.code).toBe('NO_MAIN_POWER');
  });

  it('is deterministic regardless of input order', () => {
    const hints = deriveTechnicalHints({
      ...CLEAN,
      ignitionStatus: 'OFF', // IGNITION_OFF (2)
      speed: 10, // VEHICLE_IN_MOTION (1)
      csq: 5, // WEAK_GSM (3) — highest of these three
    });
    expect(pickTopHint(hints)?.code).toBe('WEAK_GSM');
  });
});

describe('#84 — buildTechnicalHealth', () => {
  it('missing snapshot → available:false, empty hints, null raw telemetry, null dataAsOf', () => {
    const result = buildTechnicalHealth(null);
    expect(result).toEqual({ hints: [], rawTelemetry: null, dataAsOf: null, available: false });
  });

  it('present snapshot → available:true, dataAsOf = snapshot gpsDatetime, raw fields pass through as-is', () => {
    const gpsDatetime = new Date('2026-08-01T10:00:00Z');
    const result = buildTechnicalHealth({
      gpsDatetime,
      lat: 19.1,
      lon: 72.9,
      mainsStatus: 0,
      mainsVoltage: 9,
      gpsValidity: null, // a field genuinely having no data is distinct from available:false
      gpsMode: null,
      ignitionStatus: 'OFF',
      speed: 0,
      creg: null,
      cgreg: null,
      csq: null,
      ipAddress: null,
      portNo: null,
      simSubscriberName: null,
      unitNo: 'UNIT-1',
      deviceType: 'GPS-X',
    });

    expect(result.available).toBe(true);
    expect(result.dataAsOf).toBe(gpsDatetime.toISOString());
    expect(result.rawTelemetry?.mainsStatus).toBe(0);
    expect(result.rawTelemetry?.mainsVoltage).toBe(9);
    expect(result.rawTelemetry?.gpsValidity).toBeNull();
    expect(result.rawTelemetry?.unitNo).toBe('UNIT-1');
    expect(result.hints.map((h) => h.code)).toEqual(['NO_MAIN_POWER', 'LOW_VOLTAGE', 'IGNITION_OFF']);
  });

  it('accepts a Prisma.Decimal-like value for mainsVoltage/speed (toNumber())', () => {
    const gpsDatetime = new Date('2026-08-01T10:00:00Z');
    const decimalLike = (n: number) => ({ toNumber: () => n }) as unknown as number;
    const result = buildTechnicalHealth({
      gpsDatetime,
      lat: null,
      lon: null,
      mainsStatus: null,
      mainsVoltage: decimalLike(8),
      gpsValidity: null,
      gpsMode: null,
      ignitionStatus: null,
      speed: decimalLike(12),
      creg: null,
      cgreg: null,
      csq: null,
      ipAddress: null,
      portNo: null,
      simSubscriberName: null,
      unitNo: null,
      deviceType: null,
    });
    expect(result.rawTelemetry?.mainsVoltage).toBe(8);
    expect(result.rawTelemetry?.speed).toBe(12);
    expect(result.hints.map((h) => h.code)).toEqual(['LOW_VOLTAGE', 'VEHICLE_IN_MOTION']);
  });
});
