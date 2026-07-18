import { AutoPlantMasterSource } from '../src/ingestion/autoplant/autoplant-master-source';

/**
 * Phase 4 — the real `MasterSyncSource` over `ap_masters` (schema-qualified reads through the
 * read-only `AutoPlantMysqlClient`). Unit-tested against a fake `query` that records the SQL and
 * returns canned rows — no MySQL / VPN. Pins the two facts the production schema forced (docs/autoplant):
 *   • plants select the DISTINCT `master_plant_id` / `master_plant_code` (not plant_id/plant_code);
 *   • a vehicle's company is resolved via its plant (`mst_vehicle LEFT JOIN mst_plant`, `p.company_id`),
 *     because `mst_vehicle.company_id` is unreliable (0 in production rows).
 */
describe('Phase 4 — AutoPlantMasterSource', () => {
  const calls: string[] = [];
  const rowsByTable: Record<string, unknown[]> = {
    mst_company: [{ company_id: 1010, company_name: 'UTCL', company_type: 'Shipper', status: 'ACTIVE' }],
    mst_transporter: [
      { transporter_id: 7216, company_id: 1015, transporter_name: 'SRI LAKSHMI', status: 'ACTIVE' },
    ],
    mst_plant: [{ plant_id: 3038, company_id: 1015, plant_name: 'Kadappa', master_plant_id: 4460 }],
    mst_vehicle: [{ vehicle_no: 'AP02TA2569', device_id: '0869925073271551', company_id: 1015 }],
  };

  const query = async <T>(sql: string): Promise<T[]> => {
    calls.push(sql);
    const table = Object.keys(rowsByTable).find((t) => sql.includes(t));
    return (table ? rowsByTable[table] : []) as T[];
  };

  const source = new AutoPlantMasterSource({ query, mastersSchema: 'ap_masters' });

  beforeEach(() => {
    calls.length = 0;
  });

  const lastSql = (): string => calls[calls.length - 1] ?? '';

  it('reads companies with a read-only, schema-qualified select', async () => {
    const rows = await source.readCompanies();
    expect(lastSql().trimStart().toUpperCase().startsWith('SELECT')).toBe(true);
    expect(lastSql()).toContain('`ap_masters`.`mst_company`');
    expect(lastSql()).toMatch(/company_id|company_name|company_type|status/);
    expect(rows[0]).toMatchObject({ company_id: 1010, company_name: 'UTCL' });
  });

  it('reads transporters schema-qualified', async () => {
    await source.readTransporters();
    expect(lastSql()).toContain('`ap_masters`.`mst_transporter`');
    expect(lastSql()).toMatch(/transporter_id|transporter_name/);
  });

  it('selects the DISTINCT master_plant_id / master_plant_code for plants (not plant_id/plant_code)', async () => {
    await source.readPlants();
    const sql = lastSql();
    expect(sql).toContain('`ap_masters`.`mst_plant`');
    expect(sql).toContain('master_plant_id');
    expect(sql).toContain('master_plant_code');
    expect(sql).toMatch(/zone_id|zone_name|region_id|plant_state|plant_district/);
  });

  it('resolves a vehicle company via a GROUP-BY-plant_id subquery (dedup) — mst_vehicle.company_id is unreliable + composite plant PK', async () => {
    await source.readVehicleMasters();
    const sql = lastSql();
    expect(sql).toContain('`ap_masters`.`mst_vehicle`');
    // Dedup subquery, not a raw join — the composite (plant_id, plant_code) PK would otherwise fan out.
    expect(sql).toMatch(/LEFT JOIN\s*\(SELECT\s+plant_id,\s*MIN\(company_id\)/i);
    expect(sql).toMatch(/GROUP BY plant_id\)\s*p/i);
    expect(sql).toMatch(/p\.company_id\s+AS\s+company_id/i);
    expect(sql).toMatch(/v\.deployment_status|v\.transporter_id|v\.device_id/i);
  });

  it('honours the configured masters schema name (not hard-coded)', async () => {
    const other = new AutoPlantMasterSource({ query, mastersSchema: 'ap_masters_replica' });
    await other.readCompanies();
    expect(lastSql()).toContain('`ap_masters_replica`.`mst_company`');
  });
});

/**
 * Device-identity enrichment (DEVICE_TYPE / IMSI_NO). These live one schema over on
 * `ap_widgets.tb_vehiclemaster` — `mst_vehicle` has no such columns, which is why this read used to
 * hardcode `NULL AS device_type` and left `devices.device_type` NULL for the entire fleet (0 of 20,935
 * on 2026-07-17). Only STATIC identity is joined here: TRIP_CREATION_DATETIME is live trip state and
 * must stay on the 30-min snapshot path, so it must NOT appear in this SQL.
 */
describe('Phase 4 — AutoPlantMasterSource device enrichment', () => {
  const seen: string[] = [];
  const query = async <T>(sql: string): Promise<T[]> => {
    seen.push(sql);
    return [] as T[];
  };

  beforeEach(() => {
    seen.length = 0;
  });

  it('joins ap_widgets.tb_vehiclemaster on vehicle_no for DEVICE_TYPE + IMSI_NO', async () => {
    const source = new AutoPlantMasterSource({ query, mastersSchema: 'ap_masters', widgetsSchema: 'ap_widgets' });
    await source.readVehicleMasters();
    const sql = seen[0];
    expect(sql).toContain('LEFT JOIN `ap_widgets`.`tb_vehiclemaster` w ON w.vehicle_no = v.vehicle_no');
    expect(sql).toContain('w.DEVICE_TYPE AS device_type');
    expect(sql).toContain('w.IMSI_NO AS imsi_no');
    // The stub this replaced — a regression here silently re-NULLs the whole fleet.
    expect(sql).not.toContain('NULL AS device_type');
  });

  it('does NOT read trip state on the master path (lifecycle split: that rides the snapshot tick)', async () => {
    const source = new AutoPlantMasterSource({ query, mastersSchema: 'ap_masters', widgetsSchema: 'ap_widgets' });
    await source.readVehicleMasters();
    expect(seen[0]).not.toContain('TRIP_CREATION_DATETIME');
  });

  it('honours the configured widgets schema name (not hard-coded)', async () => {
    const source = new AutoPlantMasterSource({ query, mastersSchema: 'ap_masters', widgetsSchema: 'ap_widgets_replica' });
    await source.readVehicleMasters();
    expect(seen[0]).toContain('`ap_widgets_replica`.`tb_vehiclemaster`');
  });

  it('skips the join entirely when no widgets schema is configured (both columns read NULL)', async () => {
    const source = new AutoPlantMasterSource({ query, mastersSchema: 'ap_masters' });
    await source.readVehicleMasters();
    expect(seen[0]).not.toContain('tb_vehiclemaster');
    expect(seen[0]).toContain('NULL AS device_type, NULL AS imsi_no');
  });

  it('keeps the read paged under the DBA <100-rows/query cap even with the join', async () => {
    const source = new AutoPlantMasterSource({ query, mastersSchema: 'ap_masters', widgetsSchema: 'ap_widgets' });
    await source.readVehicleMasters();
    expect(seen[0]).toMatch(/ORDER BY v\.vehicle_no LIMIT 90$/);
  });
});
