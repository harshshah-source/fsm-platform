/**
 * Fast, DB-free regression test for the Book8 parser/classifier. Self-skips when the dataset file is
 * absent (e.g. CI without the 26 MB CSV), so it never breaks an unrelated run.
 */
import { existsSync } from 'node:fs';
import { loadBook8Dataset, defaultCsvPath } from './book8-dataset';

const HAS_FILE = existsSync(defaultCsvPath());

describe.skipIf(!HAS_FILE)('Book8 dataset parser', () => {
  const ds = loadBook8Dataset();

  it('classifies the full file deterministically', () => {
    const c = ds.classification;
    // ~34.3k data rows in the fixed export.
    expect(c.totalRows).toBeGreaterThan(34000);
    // Scientific-notation collapsed device ids are excluded (≈3,148 rows, 28 distinct values).
    expect(c.skipped.COLLAPSED_DEVICE_ID).toBeGreaterThan(3000);
    // The bulk of rows are usable (clean, unique device_id).
    expect(c.usableCount).toBeGreaterThan(29000);
    // usable + every skip bucket accounts for every data row.
    const skippedTotal = Object.values(c.skipped).reduce((a, b) => a + b, 0);
    expect(c.usableCount + skippedTotal).toBe(c.totalRows);
    // 9 of every 10 usable devices are PGI-eligible (deterministic rule).
    expect(c.pgiEligibleCount + c.pgiIneligibleCount).toBe(c.usableCount);
  });

  it('derives a self-consistent master graph', () => {
    expect(ds.zones.map((z) => z.name).sort()).toEqual(['EAST', 'NORTH', 'SOUTH', 'WEST']);
    // 11 real company ids in the CSV + one UNKNOWN bucket for NA/NULL.
    expect(ds.companies.length).toBeGreaterThanOrEqual(11);
    // Company (tier, rank) pairs are all distinct (Company @@unique([tier, rank])).
    const pairs = ds.companies.map((co) => `${co.tier}:${co.rank}`);
    expect(new Set(pairs).size).toBe(ds.companies.length);
    // ~146 distinct plant codes.
    expect(ds.plants.length).toBeGreaterThan(100);
    // Every usable row references a derived plant + company (no orphans by construction).
    const plantCodes = new Set(ds.plants.map((p) => p.code));
    const companyKeys = new Set(ds.companies.map((co) => co.key));
    expect(ds.usable.every((r) => plantCodes.has(r.plantCode) && companyKeys.has(r.companyKey))).toBe(true);
  });

  it('produces UTC telemetry no later than the injected NOW', () => {
    expect(ds.telemetry.length).toBeGreaterThan(0);
    expect(ds.telemetry.every((t) => t.gpsDatetime instanceof Date)).toBe(true);
    const maxPing = Math.max(...ds.telemetry.map((t) => t.gpsDatetime.getTime()));
    expect(maxPing).toBeLessThanOrEqual(ds.datasetNow.getTime());
  });
});
