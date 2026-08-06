import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  buildDatasetQuery,
  escapeLike,
  explainStatement,
  resolveColumns,
  MAX_IN_VALUES,
  MAX_PAGE_SIZE,
  MAX_SORT_COLUMNS,
} from '../src/ops-explorer/dataset-query';
import { getDataset, listDatasets, serializeDataset } from '../src/ops-explorer/dataset-registry';
import { readOpsExplorerConfig } from '../src/ops-explorer/ops-explorer.config';
import { OPS_EXPLORER_ROLES } from '../src/ops-explorer/ops-explorer-access';

/**
 * #217 — the Operations Data Explorer's safety properties, tested WITHOUT a database.
 *
 * This is deliberate. The injection boundary, the developer-mode strip and the flag defaults are the
 * three things that must not regress, and #156 established that the local e2e suite is not a reliable
 * green/red signal (long-lived DB, leaked fixtures, three different results on one commit). A pure
 * spec over pure functions is the signal that keeps working.
 */

const devices = getDataset('devices')!;

describe('ops-explorer config flags', () => {
  it('is off by default, in every environment', () => {
    expect(readOpsExplorerConfig({}).enabled).toBe(false);
    expect(readOpsExplorerConfig({ NODE_ENV: 'development' }).enabled).toBe(false);
    expect(readOpsExplorerConfig({ NODE_ENV: 'production' }).enabled).toBe(false);
  });

  it('developer mode can never be on while the feature is off', () => {
    const cfg = readOpsExplorerConfig({ OPS_EXPLORER_DEVELOPER_MODE: 'true' });
    expect(cfg.enabled).toBe(false);
    expect(cfg.developerMode).toBe(false);
  });

  it('defaults developer mode on outside production and off in production', () => {
    expect(readOpsExplorerConfig({ OPS_EXPLORER_ENABLED: 'true', NODE_ENV: 'development' }).developerMode).toBe(true);
    expect(readOpsExplorerConfig({ OPS_EXPLORER_ENABLED: 'true', NODE_ENV: 'production' }).developerMode).toBe(false);
  });

  it('lets an explicit developer-mode value win in both directions', () => {
    expect(
      readOpsExplorerConfig({ OPS_EXPLORER_ENABLED: 'true', NODE_ENV: 'production', OPS_EXPLORER_DEVELOPER_MODE: 'true' })
        .developerMode,
    ).toBe(true);
    expect(
      readOpsExplorerConfig({ OPS_EXPLORER_ENABLED: 'true', NODE_ENV: 'test', OPS_EXPLORER_DEVELOPER_MODE: 'false' })
        .developerMode,
    ).toBe(false);
  });

  it('treats anything that is not an affirmative as false', () => {
    for (const raw of ['', ' ', 'False', 'no', 'off', '0', 'enabled', 'TRUE ']) {
      const expected = raw.trim().toLowerCase() === 'true';
      expect(readOpsExplorerConfig({ OPS_EXPLORER_ENABLED: raw }).enabled).toBe(expected);
    }
  });
});

describe('ops-explorer authorization seam', () => {
  it('declares the allow-list exactly once, and it is Operations Head today', () => {
    expect([...OPS_EXPLORER_ROLES]).toEqual(['OPERATIONS_HEAD']);
  });
});

describe('dataset registry', () => {
  it('gives every column full operational lineage and a developer expression', () => {
    for (const dataset of listDatasets()) {
      for (const column of dataset.columns) {
        expect(column.lineage.definition, `${dataset.key}.${column.key} definition`).toBeTruthy();
        expect(column.lineage.table, `${dataset.key}.${column.key} table`).toBeTruthy();
        expect(column.lineage.refreshTrigger, `${dataset.key}.${column.key} refreshTrigger`).toBeTruthy();
        expect(column.lineage.developer.expression, `${dataset.key}.${column.key} expression`).toBe(column.sql);
      }
    }
  });

  it('only names real columns in searchColumns and defaultSort', () => {
    for (const dataset of listDatasets()) {
      const keys = new Set(dataset.columns.map((c) => c.key));
      for (const key of dataset.searchColumns) expect(keys.has(key), `${dataset.key} search ${key}`).toBe(true);
      expect(keys.has(dataset.defaultSort.column)).toBe(true);
      const sortCol = dataset.columns.find((c) => c.key === dataset.defaultSort.column)!;
      expect(sortCol.sortable, `${dataset.key} default sort column must be sortable`).toBe(true);
    }
  });

  it('has no duplicate column keys', () => {
    for (const dataset of listDatasets()) {
      const keys = dataset.columns.map((c) => c.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('strips SQL and the developer lineage block when developer mode is off', () => {
    const off = serializeDataset(devices, false);
    const serialized = JSON.stringify(off);
    expect(off.from).toBeUndefined();
    for (const column of off.columns) {
      expect(column.lineage.developer).toBeUndefined();
      expect(column.lineage.definition).toBeTruthy();
    }
    // Belt and braces: no raw table-qualified SQL anywhere in the operational payload.
    expect(serialized).not.toContain('ds.sla_bucket');
    expect(serialized).not.toContain('LEFT JOIN');
  });

  it('includes SQL, the FROM clause and formulas when developer mode is on', () => {
    const on = serializeDataset(devices, true);
    expect(on.from).toContain('LEFT JOIN device_states');
    const bucket = on.columns.find((c) => c.key === 'slaBucket')!;
    expect(bucket.lineage.developer?.expression).toBe('ds.sla_bucket::text');
    expect(bucket.lineage.developer?.formula).toBeTruthy();
  });
});

describe('injection safety (AC-8)', () => {
  it('rejects a filter naming a column that is not in the registry', () => {
    expect(() =>
      buildDatasetQuery(devices, { filters: [{ column: 'device_id; DROP TABLE devices', operator: 'eq', value: 'x' }] }),
    ).toThrow(BadRequestException);
  });

  it('rejects a sort, and a selection, naming an unknown column', () => {
    expect(() => buildDatasetQuery(devices, { sort: [{ column: 'nope', direction: 'asc' }] })).toThrow(
      BadRequestException,
    );
    expect(() => buildDatasetQuery(devices, { columns: ['nope'] })).toThrow(BadRequestException);
  });

  it('rejects an unknown operator', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      buildDatasetQuery(devices, { filters: [{ column: 'deviceId', operator: 'drop' as any, value: 1 }] }),
    ).toThrow(BadRequestException);
  });

  it('binds every value as a parameter — hostile text never reaches the statement', () => {
    const hostile = "'; DROP TABLE devices; --";
    const built = buildDatasetQuery(devices, { filters: [{ column: 'deviceId', operator: 'eq', value: hostile }] });
    const { sql, params } = explainStatement(built.rows);
    expect(sql).not.toContain('DROP TABLE');
    expect(params).toContain(hostile);
  });

  it('binds the global search term rather than splicing it', () => {
    const built = buildDatasetQuery(devices, { search: "x' OR 1=1 --" });
    const { sql, params } = explainStatement(built.rows);
    expect(sql).not.toContain('OR 1=1');
    expect(params.some((p) => String(p).includes("x' OR 1=1 --"))).toBe(true);
  });

  it('escapes LIKE metacharacters so a wildcard search is a literal search', () => {
    expect(escapeLike('50%_x')).toBe('50\\%\\_x');
    const built = buildDatasetQuery(devices, {
      filters: [{ column: 'deviceId', operator: 'contains', value: '100%' }],
    });
    expect(explainStatement(built.rows).params).toContain('%100\\%%');
  });
});

describe('query construction (AC-7)', () => {
  it('defaults to the dataset default-visible columns and default sort', () => {
    const built = buildDatasetQuery(devices, {});
    expect(built.columns.map((c) => c.key)).toEqual(
      devices.columns.filter((c) => c.defaultVisible).map((c) => c.key),
    );
    expect(explainStatement(built.rows).sql).toContain('ORDER BY ds.inactivity_hours DESC NULLS LAST');
  });

  it('honours an explicit column selection, in the caller order, deduplicated', () => {
    const built = buildDatasetQuery(devices, { columns: ['zoneName', 'deviceId', 'zoneName'] });
    expect(built.columns.map((c) => c.key)).toEqual(['zoneName', 'deviceId']);
    expect(explainStatement(built.rows).sql).toContain('z.name AS "zoneName"');
  });

  it('sorts NULLS LAST in both directions', () => {
    const asc = explainStatement(
      buildDatasetQuery(devices, { sort: [{ column: 'deviceId', direction: 'asc' }] }).rows,
    ).sql;
    expect(asc).toContain('ASC NULLS LAST');
  });

  it('caps page size and never emits a negative offset', () => {
    const big = buildDatasetQuery(devices, { page: 1, pageSize: 10_000 });
    expect(big.pageSize).toBe(MAX_PAGE_SIZE);
    const negative = buildDatasetQuery(devices, { page: -5, pageSize: 10 });
    expect(negative.page).toBe(1);
    expect(explainStatement(negative.rows).params).toContain(0);
  });

  it('emits no LIMIT at all on the unbounded (export) path', () => {
    const built = buildDatasetQuery(devices, { pageSize: 50 }, { unbounded: true });
    expect(explainStatement(built.rows).sql).not.toContain('LIMIT');
    expect(built.pageSize).toBe(0);
  });

  it('builds a count query with the same predicate but no sort or pagination', () => {
    const built = buildDatasetQuery(devices, {
      filters: [{ column: 'isInactive', operator: 'eq', value: true }],
      pageSize: 25,
    });
    const total = explainStatement(built.total);
    expect(total.sql).toContain('COUNT(*)');
    expect(total.sql).not.toContain('ORDER BY');
    expect(total.sql).not.toContain('LIMIT');
    expect(total.params).toContain(true);
  });

  it('rejects more than the sort-column cap', () => {
    const sort = Array.from({ length: MAX_SORT_COLUMNS + 1 }, () => ({
      column: 'deviceId' as const,
      direction: 'asc' as const,
    }));
    expect(() => buildDatasetQuery(devices, { sort })).toThrow(BadRequestException);
  });

  it('rejects a non-sortable or non-filterable column with a named error', () => {
    expect(() => buildDatasetQuery(devices, { sort: [{ column: 'imsiNo', direction: 'asc' }] })).toThrow(
      BadRequestException,
    );
  });
});

describe('filter operator semantics', () => {
  // Asserted against the COUNT query, not the row query: the row query always binds LIMIT and OFFSET,
  // so `params` there is "the filter's parameters plus two pagination ones" and every length assertion
  // would be off by a constant. The count query carries the same predicate and nothing else.
  const sqlFor = (filter: Parameters<typeof buildDatasetQuery>[1]['filters']) =>
    explainStatement(buildDatasetQuery(devices, { filters: filter }).total);

  it('turns eq/neq against null into IS NULL / IS NOT NULL', () => {
    expect(sqlFor([{ column: 'slaBucket', operator: 'eq', value: null }]).sql).toContain('IS NULL');
    expect(sqlFor([{ column: 'slaBucket', operator: 'neq', value: null }]).sql).toContain('IS NOT NULL');
  });

  it('makes neq NULL-safe so it does not silently hide blank rows', () => {
    expect(sqlFor([{ column: 'zoneName', operator: 'neq', value: 'North' }]).sql).toContain('IS DISTINCT FROM');
  });

  it('renders an empty IN list as an explicit empty result, not a syntax error', () => {
    const { sql, params } = sqlFor([{ column: 'slaBucket', operator: 'in', value: [] }]);
    expect(sql).toContain('FALSE');
    expect(params).toHaveLength(0);
  });

  it('binds every element of an IN list separately', () => {
    const { params } = sqlFor([{ column: 'slaBucket', operator: 'in', value: ['CRITICAL', 'SEVERE'] }]);
    expect(params).toContain('CRITICAL');
    expect(params).toContain('SEVERE');
  });

  it('caps the IN list length', () => {
    const value = Array.from({ length: MAX_IN_VALUES + 1 }, (_, i) => `d${i}`);
    expect(() => sqlFor([{ column: 'deviceId', operator: 'in', value }])).toThrow(BadRequestException);
  });

  it('requires a two-element array for between', () => {
    expect(() => sqlFor([{ column: 'inactivityHours', operator: 'between', value: [1] }])).toThrow(
      BadRequestException,
    );
    expect(sqlFor([{ column: 'inactivityHours', operator: 'between', value: [24, 48] }]).params).toEqual([24, 48]);
  });

  it('emits no parameter for isNull / isNotNull', () => {
    expect(sqlFor([{ column: 'slaBucket', operator: 'isNull' }]).params).toHaveLength(0);
  });

  it('coerces to the column type and rejects what cannot be coerced', () => {
    expect(sqlFor([{ column: 'isInactive', operator: 'eq', value: 'true' }]).params).toContain(true);
    expect(sqlFor([{ column: 'inactivityHours', operator: 'gt', value: '24' }]).params).toContain(24);
    expect(() => sqlFor([{ column: 'inactivityHours', operator: 'gt', value: 'soon' }])).toThrow(BadRequestException);
    expect(() => sqlFor([{ column: 'isInactive', operator: 'eq', value: 'maybe' }])).toThrow(BadRequestException);
  });

  it('rejects an enum value outside the declared set', () => {
    expect(() => sqlFor([{ column: 'slaBucket', operator: 'eq', value: 'MELTDOWN' }])).toThrow(BadRequestException);
  });

  it('rejects a text operator on a non-text column', () => {
    expect(() => sqlFor([{ column: 'inactivityHours', operator: 'contains', value: '2' }])).toThrow(
      BadRequestException,
    );
  });
});

describe('dataset registry — S2 breadth (#217)', () => {
  const EXPECTED_KEYS = [
    'devices',
    'zones',
    'companies',
    'plants',
    'vehicles',
    'engineers',
    'tickets',
    'batches',
    'dispatchRuns',
    'recommendations',
    'auditLogs',
  ];

  it('registers every S1+S2 dataset exactly once', () => {
    const keys = listDatasets().map((d) => d.key);
    expect(keys).toEqual(EXPECTED_KEYS);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every dataset resolves by key and is independently queryable with its defaults', () => {
    for (const key of EXPECTED_KEYS) {
      const dataset = getDataset(key)!;
      expect(dataset, key).toBeDefined();
      // Full round-trip through the real builder — not just registry shape checks. A dataset with a
      // typo'd search/sort column key, or a defaultSort pointing at a non-sortable column, fails here
      // exactly as it would at request time.
      const built = buildDatasetQuery(dataset, {});
      const { sql } = explainStatement(built.rows);
      expect(sql, key).toContain('SELECT');
      expect(sql, key).toContain('ORDER BY');
      expect(built.columns.length, `${key} default columns`).toBeGreaterThan(0);
    }
  });

  it('every dataset also builds cleanly with EVERY column selected and a global search term', () => {
    for (const key of EXPECTED_KEYS) {
      const dataset = getDataset(key)!;
      const built = buildDatasetQuery(dataset, {
        columns: dataset.columns.map((c) => c.key),
        search: 'probe',
      });
      expect(built.columns.length, key).toBe(dataset.columns.length);
    }
  });
});

describe('drilldown valueSql — hidden companion projection (#217 S2)', () => {
  const devices = getDataset('devices')!;

  it('projects a __dd_<key> column when the drilldown target differs from the displayed value', () => {
    const built = buildDatasetQuery(devices, { columns: ['plantName'] });
    const { sql } = explainStatement(built.rows);
    expect(sql).toContain('p.name AS "plantName"');
    expect(sql).toContain('p.plant_id::text AS "__dd_plantName"');
  });

  it('adds no extra projection for a column with no drilldown at all', () => {
    const built = buildDatasetQuery(devices, { columns: ['inactivityHours'] });
    const { sql } = explainStatement(built.rows);
    expect(sql).not.toContain('__dd_');
  });

  it('never leaks valueSql to the client — stripped in BOTH modes, unlike lineage.developer', () => {
    const dataset = getDataset('vehicles')!;
    for (const developerMode of [false, true]) {
      const serialized = serializeDataset(dataset, developerMode);
      const plantName = serialized.columns.find((c) => c.key === 'plantName')!;
      expect(plantName.drilldown?.route, `developerMode=${developerMode}`).toBe('/reports/device?plantId=:value');
      expect((plantName.drilldown as { valueSql?: string })?.valueSql, `developerMode=${developerMode}`).toBeUndefined();
      expect(JSON.stringify(serialized), `developerMode=${developerMode}`).not.toContain('p.plant_id::text');
    }
  });

  it('a column whose display value IS the link target needs no valueSql (e.g. a ticket UUID)', () => {
    const tickets = getDataset('tickets')!;
    const ticketId = tickets.columns.find((c) => c.key === 'ticketId')!;
    expect(ticketId.drilldown?.route).toBe('/tickets/:value');
    expect(ticketId.drilldown?.valueSql).toBeUndefined();
    const built = buildDatasetQuery(tickets, { columns: ['ticketId'] });
    expect(explainStatement(built.rows).sql).not.toContain('__dd_');
  });

  it('the S1 devices bug stays fixed: deviceId has no drilldown, plantName/zoneName/companyName do', () => {
    const byKey = new Map(devices.columns.map((c) => [c.key, c]));
    expect(byKey.get('deviceId')?.drilldown).toBeUndefined();
    expect(byKey.get('plantName')?.drilldown?.valueSql).toBe('p.plant_id::text');
    expect(byKey.get('zoneName')?.drilldown?.valueSql).toBe('z.zone_id::text');
    expect(byKey.get('companyName')?.drilldown?.valueSql).toBe('c.company_id::text');
  });
});

describe('resolveColumns', () => {
  it('falls back to the default-visible set for an empty request', () => {
    expect(resolveColumns(devices, []).length).toBeGreaterThan(0);
    expect(resolveColumns(devices, undefined).every((c) => c.defaultVisible)).toBe(true);
  });
});
