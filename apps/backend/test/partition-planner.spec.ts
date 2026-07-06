import {
  dailyPartitionName,
  parsePartitionDate,
  planPartitionMaintenance,
  resolveRetentionDays,
} from '../src/ingestion/partition-planner';

/**
 * Pure retention/create-ahead planner for the daily `raw_device_snapshots` partitions (R3). No DB —
 * the decision (which partitions to drop, which to create, what retention window applies) is a pure
 * function of the existing partition names + `now` + the configured retention, so it is unit-tested
 * here and the service is a thin SQL wrapper around it. Retention is a configurable ops value with a
 * 7-day default fallback (this slice's requirement).
 */

const NOW = new Date('2026-07-15T09:00:00Z');

describe('resolveRetentionDays', () => {
  it('falls back to 7 days when the setting is unset', () => {
    expect(resolveRetentionDays(undefined)).toBe(7);
    expect(resolveRetentionDays(null)).toBe(7);
  });

  it('honours a custom retention value from settings', () => {
    expect(resolveRetentionDays(14)).toBe(14);
    expect(resolveRetentionDays(30)).toBe(30);
  });

  it('rejects non-positive / non-numeric values back to the 7-day default', () => {
    expect(resolveRetentionDays(0)).toBe(7);
    expect(resolveRetentionDays(-3)).toBe(7);
    expect(resolveRetentionDays('abc')).toBe(7);
    expect(resolveRetentionDays(NaN)).toBe(7);
  });

  it('floors a fractional value to whole days', () => {
    expect(resolveRetentionDays(3.9)).toBe(3);
  });
});

describe('partition naming', () => {
  it('round-trips a UTC day to/from its partition name', () => {
    const name = dailyPartitionName(new Date('2026-07-15T00:00:00Z'));
    expect(name).toBe('raw_device_snapshots_y2026m07d15');
    expect(parsePartitionDate(name)?.toISOString()).toBe('2026-07-15T00:00:00.000Z');
  });

  it('returns null for the catch-all default partition (never a dated partition)', () => {
    expect(parsePartitionDate('raw_device_snapshots_default')).toBeNull();
    expect(parsePartitionDate('some_other_table')).toBeNull();
  });
});

describe('planPartitionMaintenance — retention (deletion eligibility)', () => {
  it('marks partitions older than the 7-day window for deletion', () => {
    // cutoff day = 2026-07-15 − 7 = 2026-07-08; anything strictly before it is fully expired.
    const existing = [
      'raw_device_snapshots_default',
      'raw_device_snapshots_y2026m07d06',
      'raw_device_snapshots_y2026m07d07',
    ];
    const plan = planPartitionMaintenance({ existing, now: NOW, retentionDays: 7, createAheadDays: 0 });
    expect(plan.toDrop).toContain('raw_device_snapshots_y2026m07d06');
    expect(plan.toDrop).toContain('raw_device_snapshots_y2026m07d07');
  });

  it('never drops recent partitions, the cutoff day itself, today, or the default', () => {
    const existing = [
      'raw_device_snapshots_default',
      'raw_device_snapshots_y2026m07d08', // the cutoff day — still within the window, kept
      'raw_device_snapshots_y2026m07d12',
      'raw_device_snapshots_y2026m07d15', // today
    ];
    const plan = planPartitionMaintenance({ existing, now: NOW, retentionDays: 7, createAheadDays: 0 });
    expect(plan.toDrop).toEqual([]);
  });

  it('a longer custom retention keeps partitions a 7-day window would have dropped', () => {
    const existing = ['raw_device_snapshots_y2026m07d07'];
    expect(planPartitionMaintenance({ existing, now: NOW, retentionDays: 7, createAheadDays: 0 }).toDrop).toEqual([
      'raw_device_snapshots_y2026m07d07',
    ]);
    // With 14-day retention the cutoff is 2026-07-01, so 07-07 survives.
    expect(planPartitionMaintenance({ existing, now: NOW, retentionDays: 14, createAheadDays: 0 }).toDrop).toEqual([]);
  });
});

describe('planPartitionMaintenance — create-ahead', () => {
  it('creates missing partitions from today through the create-ahead horizon, skipping existing ones', () => {
    const existing = ['raw_device_snapshots_y2026m07d15']; // today already present
    const plan = planPartitionMaintenance({ existing, now: NOW, retentionDays: 7, createAheadDays: 2 });
    expect(plan.toCreate.map((p) => p.name)).toEqual([
      'raw_device_snapshots_y2026m07d16',
      'raw_device_snapshots_y2026m07d17',
    ]);
    // Bounds are half-open UTC-midnight ranges matching the migration.
    expect(plan.toCreate[0].fromIso).toBe('2026-07-16 00:00:00+00');
    expect(plan.toCreate[0].toIso).toBe('2026-07-17 00:00:00+00');
  });

  it('creates today too when it is missing', () => {
    const plan = planPartitionMaintenance({ existing: [], now: NOW, retentionDays: 7, createAheadDays: 0 });
    expect(plan.toCreate.map((p) => p.name)).toEqual(['raw_device_snapshots_y2026m07d15']);
  });
});
