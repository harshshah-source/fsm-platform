import { describe, expect, it } from 'vitest';
import { AutoPlantMasterSource } from '../src/ingestion/autoplant/autoplant-master-source';

/**
 * Phase 4 / Step 2 — the DBA "< 100 rows/query" cap. Every master read must keyset-paginate on the PK
 * at ≤ pageSize and concatenate, never a single unbounded SELECT, and the fleet scope (ACTIVE plants /
 * DEPLOYED vehicles) must be pushed into SQL. Unit-tested against a fake `query` that honours LIMIT +
 * the `> ?` keyset cursor over an in-memory dataset — no MySQL / VPN.
 */
describe('AutoPlantMasterSource — bounded pagination (< 100/query)', () => {
  const limitOf = (sql: string): number => Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? '0');

  /** A fake `query` over an ascending-keyed dataset that respects `LIMIT` and the keyset `> ?` cursor. */
  function fakeQueryOver<T extends Record<string, unknown>>(all: T[], key: keyof T) {
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const query = async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> => {
      calls.push({ sql, params });
      const limit = limitOf(sql);
      let start = 0;
      if (sql.includes('> ?')) {
        const cursor = params[params.length - 1];
        start = all.findIndex((r) => (r[key] as number | string) > (cursor as number | string));
        if (start < 0) start = all.length;
      }
      return all.slice(start, start + limit) as unknown as R[];
    };
    return { query, calls };
  }

  it('pages companies at ≤ pageSize and returns every row across pages', async () => {
    const all = [1, 2, 3, 4, 5].map((i) => ({
      company_id: i,
      company_name: `c${i}`,
      company_type: 'NA',
      status: 'ACTIVE',
    }));
    const { query, calls } = fakeQueryOver(all, 'company_id');
    const source = new AutoPlantMasterSource({ query, mastersSchema: 'ap_masters', pageSize: 2 });

    const rows = await source.readCompanies();

    expect(rows).toHaveLength(5); // all rows, concatenated across pages
    expect(calls.length).toBe(3); // 2 + 2 + 1
    for (const c of calls) {
      expect(limitOf(c.sql)).toBe(2);
      expect(c.sql).toMatch(/ORDER BY company_id/);
    }
    expect(calls[0].sql).not.toContain('> ?'); // first page has no cursor
    expect(calls[1].sql).toContain('> ?'); // subsequent pages keyset-continue
  });

  it('clamps pageSize below 100 even if a larger value is configured', async () => {
    const { query, calls } = fakeQueryOver([{ company_id: 1 }], 'company_id');
    const source = new AutoPlantMasterSource({ query, mastersSchema: 'ap_masters', pageSize: 1000 });
    await source.readCompanies();
    expect(limitOf(calls[0].sql)).toBe(99);
  });

  it('pushes the ACTIVE plant scope into SQL', async () => {
    const { query, calls } = fakeQueryOver([{ plant_id: 1 }], 'plant_id');
    const source = new AutoPlantMasterSource({ query, mastersSchema: 'ap_masters', plantStatuses: ['ACTIVE'] });
    await source.readPlants();
    expect(calls[0].sql).toMatch(/status IN \(\?\)/);
    expect(calls[0].params).toContain('ACTIVE');
  });

  it('pushes the DEPLOYED vehicle scope into SQL', async () => {
    const { query, calls } = fakeQueryOver([{ vehicle_no: 'A' }], 'vehicle_no');
    const source = new AutoPlantMasterSource({
      query,
      mastersSchema: 'ap_masters',
      deploymentStatuses: ['DEPLOYED'],
    });
    await source.readVehicleMasters();
    expect(calls[0].sql).toMatch(/v\.deployment_status IN \(\?\)/);
    expect(calls[0].params).toContain('DEPLOYED');
  });

  it('dedups plants by plant_id (the composite plant_id/plant_code PK repeats plant_id)', async () => {
    // Same plant_id twice (two plant_codes) plus a distinct one — must collapse to one row per plant_id.
    const all = [
      { plant_id: 100, plant_code: 'A' },
      { plant_id: 100, plant_code: 'B' },
      { plant_id: 200, plant_code: 'C' },
    ];
    const { query } = fakeQueryOver(all, 'plant_id');
    const source = new AutoPlantMasterSource({ query, mastersSchema: 'ap_masters', pageSize: 90, plantStatuses: [] });
    const rows = (await source.readPlants()) as unknown as { plant_id: number }[];
    expect(rows.map((r) => r.plant_id)).toEqual([100, 200]);
  });

  it('applies no status filter when the scope list is empty', async () => {
    const { query, calls } = fakeQueryOver([{ plant_id: 1 }], 'plant_id');
    const source = new AutoPlantMasterSource({ query, mastersSchema: 'ap_masters', plantStatuses: [] });
    await source.readPlants();
    expect(calls[0].sql).not.toContain('WHERE');
  });
});
