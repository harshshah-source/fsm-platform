import { describe, it, expect } from 'vitest';
import { readAutoPlantMysqlConfig } from '../src/ingestion/autoplant/autoplant-mysql.client';

/**
 * Phase 1 — two-schema AutoPlant connectivity. The production source spans TWO MySQL databases on
 * the same host (10.0.0.25): `ap_widgets` (live telemetry — tb_vehiclemaster) and `ap_masters`
 * (mst_* masters). The config must carry both; a partial config returns null so the app stays on
 * the in-memory reader (unset ⇒ mock is the documented safe default).
 */
const base = {
  AUTOPLANT_MYSQL_HOST: '10.0.0.25',
  AUTOPLANT_MYSQL_USER: 'fsm_readonly',
  AUTOPLANT_MYSQL_PASSWORD: 'secret',
} as const;

describe('readAutoPlantMysqlConfig (two-schema)', () => {
  it('returns null when no AutoPlant env is set', () => {
    expect(readAutoPlantMysqlConfig({})).toBeNull();
  });

  it('returns null when only one of the two source databases is set', () => {
    expect(readAutoPlantMysqlConfig({ ...base, AUTOPLANT_MYSQL_DB_WIDGETS: 'ap_widgets' })).toBeNull();
  });

  it('reads both ap_widgets and ap_masters schemas', () => {
    const cfg = readAutoPlantMysqlConfig({
      ...base,
      AUTOPLANT_MYSQL_DB_WIDGETS: 'ap_widgets',
      AUTOPLANT_MYSQL_DB_MASTERS: 'ap_masters',
      AUTOPLANT_MYSQL_PORT: '3306',
      AUTOPLANT_MYSQL_SSL: 'true',
    });
    expect(cfg).toEqual({
      host: '10.0.0.25',
      port: 3306,
      user: 'fsm_readonly',
      password: 'secret',
      dbWidgets: 'ap_widgets',
      dbMasters: 'ap_masters',
      ssl: true,
    });
  });

  it('defaults port to 3306 and ssl to false', () => {
    const cfg = readAutoPlantMysqlConfig({
      ...base,
      AUTOPLANT_MYSQL_DB_WIDGETS: 'ap_widgets',
      AUTOPLANT_MYSQL_DB_MASTERS: 'ap_masters',
    });
    expect(cfg?.port).toBe(3306);
    expect(cfg?.ssl).toBe(false);
  });

  it('accepts legacy AUTOPLANT_MYSQL_DATABASE as the ap_widgets schema (back-compat)', () => {
    const cfg = readAutoPlantMysqlConfig({
      ...base,
      AUTOPLANT_MYSQL_DATABASE: 'ap_widgets',
      AUTOPLANT_MYSQL_DB_MASTERS: 'ap_masters',
    });
    expect(cfg?.dbWidgets).toBe('ap_widgets');
    expect(cfg?.dbMasters).toBe('ap_masters');
  });
});
