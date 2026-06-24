import { evaluatePhase1, evaluatePhase2, haversineMeters } from '../src/verification/verification-criteria';

/**
 * Issue 18, slice 2 — pure three-phase GPS verification criteria (LLD §17, workflow §17.1).
 * Phase 1: ≥3 pings, ≥15 min span, no gap >30 min, first ping within ±500 m of the SE anchor (skipped,
 * no fraud, when presence is NONE); 1–2 pings → PARTIAL_RECOVERY. Phase 2 (1 h window): keeps pinging,
 * no gap >30 min, movement welcome; a coverage gap stays PENDING (never auto-fail).
 */
const T0 = new Date('2026-06-23T06:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const ANCHOR = { lat: 12.9716, lon: 77.5946 };
const NEAR = { lat: 12.9721, lon: 77.5946 }; // ~55 m
const FAR = { lat: 13.4716, lon: 77.5946 }; // ~55 km

describe('haversineMeters', () => {
  it('measures ~55 m for a 0.0005° latitude step', () => {
    const d = haversineMeters(ANCHOR.lat, ANCHOR.lon, NEAR.lat, NEAR.lon);
    expect(d).toBeGreaterThan(40);
    expect(d).toBeLessThan(70);
  });
});

describe('evaluatePhase1', () => {
  const threePings = (loc: { lat: number; lon: number }) => [
    { time: at(0), lat: loc.lat, lon: loc.lon },
    { time: at(8), lat: loc.lat, lon: loc.lon },
    { time: at(16), lat: loc.lat, lon: loc.lon },
  ];

  it('passes with ≥3 pings, ≥15 min span, and the first ping within ±500 m of the anchor', () => {
    const r = evaluatePhase1({ pings: threePings(NEAR), anchor: ANCHOR, skipGeoCheck: false });
    expect(r.passed).toBe(true);
    expect(r.fraud).toBe(false);
    expect(r.pingsCount).toBe(3);
    expect(r.partial).toBe(false);
  });

  it('fraud-flags a first ping wildly off the anchor and records the distance delta', () => {
    const r = evaluatePhase1({ pings: threePings(FAR), anchor: ANCHOR, skipGeoCheck: false });
    expect(r.passed).toBe(false);
    expect(r.fraud).toBe(true);
    expect(r.firstPingDistanceMeters).toBeGreaterThan(500);
  });

  it('skips the geo-check (no fraud) when presence is NONE, even with a far first ping', () => {
    const r = evaluatePhase1({ pings: threePings(FAR), anchor: null, skipGeoCheck: true });
    expect(r.passed).toBe(true);
    expect(r.fraud).toBe(false);
  });

  it('reports PARTIAL_RECOVERY for 1–2 pings (badge, not a pass)', () => {
    const r = evaluatePhase1({
      pings: [{ time: at(0), lat: NEAR.lat, lon: NEAR.lon }],
      anchor: ANCHOR,
      skipGeoCheck: false,
    });
    expect(r.partial).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.pingsCount).toBe(1);
  });

  it('does not pass with no pings', () => {
    const r = evaluatePhase1({ pings: [], anchor: ANCHOR, skipGeoCheck: false });
    expect(r.passed).toBe(false);
    expect(r.partial).toBe(false);
    expect(r.pingsCount).toBe(0);
  });

  it('does not pass when the span is under 15 min even with 3 pings', () => {
    const tight = [
      { time: at(0), lat: NEAR.lat, lon: NEAR.lon },
      { time: at(2), lat: NEAR.lat, lon: NEAR.lon },
      { time: at(5), lat: NEAR.lat, lon: NEAR.lon },
    ];
    expect(evaluatePhase1({ pings: tight, anchor: ANCHOR, skipGeoCheck: false }).passed).toBe(false);
  });
});

describe('evaluatePhase2', () => {
  it('passes when the device keeps pinging through the 1 h window with no gap >30 min', () => {
    const pings = [at(0), at(20), at(45), at(65)];
    const r = evaluatePhase2({ pingTimes: pings, phase1Start: T0, now: at(70) });
    expect(r.passed).toBe(true);
    expect(r.coverageGap).toBe(false);
  });

  it('stays PENDING (coverage gap) when there is a gap >30 min — never auto-fails', () => {
    const pings = [at(0), at(20), at(65)]; // 45-min gap between 20 and 65
    const r = evaluatePhase2({ pingTimes: pings, phase1Start: T0, now: at(70) });
    expect(r.passed).toBe(false);
    expect(r.coverageGap).toBe(true);
  });

  it('does not pass before the 1 h window has elapsed', () => {
    const pings = [at(0), at(20), at(40)];
    const r = evaluatePhase2({ pingTimes: pings, phase1Start: T0, now: at(45) });
    expect(r.passed).toBe(false);
    expect(r.windowElapsed).toBe(false);
  });
});
