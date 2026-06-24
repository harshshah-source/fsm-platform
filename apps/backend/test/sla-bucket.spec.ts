import { describe, expect, it } from 'vitest';
import { classifySlaBucket, type SlaBucket } from '../src/device-state/sla-bucket';

/**
 * Issue 05 slice 1 — the SLA Bucket classifier (LLD §9 / CONTEXT "SLA Bucket").
 *
 * Pure function of `inactivity_hours = now − latest_gps_datetime`. Boundaries are
 * closed-lower / open-upper (e.g. CRITICAL = 24 ≤ x < 48). The 0–4h ACTIVE band is not a queue
 * bucket — it maps to `null` (stored as NULL `sla_bucket`, never surfaced in a queue).
 */
describe('Issue 05 slice 1 — classifySlaBucket', () => {
  it('maps the 0–4h ACTIVE band to null (no bucket, never queued)', () => {
    expect(classifySlaBucket(0)).toBeNull();
    expect(classifySlaBucket(3.99)).toBeNull();
  });

  it('classifies each band at its closed lower boundary', () => {
    const cases: [number, SlaBucket][] = [
      [4, 'WARNING'],
      [8, 'EARLY_RISK'],
      [12, 'RISK'],
      [24, 'CRITICAL'],
      [48, 'HIGH_CRITICAL'],
      [72, 'SEVERE'],
      [120, 'VERY_SEVERE'],
      [168, 'LONG_PENDING'],
    ];
    for (const [hours, bucket] of cases) {
      expect(classifySlaBucket(hours), `${hours}h`).toBe(bucket);
    }
  });

  it('keeps the lower band just below each open upper boundary', () => {
    expect(classifySlaBucket(7.99)).toBe('WARNING');
    expect(classifySlaBucket(11.99)).toBe('EARLY_RISK');
    expect(classifySlaBucket(23.99)).toBe('RISK');
    expect(classifySlaBucket(47.99)).toBe('CRITICAL');
    expect(classifySlaBucket(71.99)).toBe('HIGH_CRITICAL');
    expect(classifySlaBucket(119.99)).toBe('SEVERE');
    expect(classifySlaBucket(167.99)).toBe('VERY_SEVERE');
  });

  it('keeps everything 7d+ in LONG_PENDING (open-ended top band)', () => {
    expect(classifySlaBucket(168)).toBe('LONG_PENDING');
    expect(classifySlaBucket(240)).toBe('LONG_PENDING');
    expect(classifySlaBucket(10_000)).toBe('LONG_PENDING');
  });

  it('treats a negative age (clock skew) as ACTIVE rather than throwing', () => {
    expect(classifySlaBucket(-1)).toBeNull();
  });
});
