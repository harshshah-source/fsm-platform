import type { CompanyPlantRow, FleetCounts, FleetSummary, ZoneOverviewRow } from '../../src/api/dashboard';

/**
 * Fixture builders for the dashboard's fleet aggregates.
 *
 * Tests state only the counts they care about; the builder fills the rest so the fixture is always
 * INTERNALLY CONSISTENT — `healthy = reporting − inactive`, `reporting = operational − neverReported`,
 * `mirrored = operational + warehouse`, and the two rates derived from the REPORTING denominator. That
 * matters here specifically: the bug this shape exists to prevent was a numerator and a denominator
 * drawn from different populations, and a fixture free to encode that same inconsistency would let it
 * back in through the tests.
 *
 * `neverReported` defaults to 0, so every existing caller keeps describing an all-reporting fleet and
 * its expectations are unchanged (#223).
 */
export function fleetCounts(
  over: { operational: number; inactive?: number; warehouse?: number; neverReported?: number },
): FleetCounts {
  const operationalDevices = over.operational;
  const inactiveOperational = over.inactive ?? 0;
  const warehouseDevices = over.warehouse ?? 0;
  const neverReported = over.neverReported ?? 0;
  const reportingOperational = operationalDevices - neverReported;
  const healthyOperational = reportingOperational - inactiveOperational;
  const pct = (n: number) =>
    reportingOperational > 0 ? Math.round((n / reportingOperational) * 1000) / 10 : null;
  return {
    mirroredDevices: operationalDevices + warehouseDevices,
    operationalDevices,
    warehouseDevices,
    reportingOperational,
    inactiveOperational,
    healthyOperational,
    neverReported,
    inactivePct: pct(inactiveOperational),
    fleetHealthPct: pct(healthyOperational),
  };
}

export function zoneRow(
  over: Partial<ZoneOverviewRow> & { zoneId: string; zoneName: string; operational: number; inactive?: number; warehouse?: number; neverReported?: number },
): ZoneOverviewRow {
  const { operational, inactive, warehouse, neverReported, ...rest } = over;
  return {
    zonalManagerName: null,
    byBucket: {},
    trendPctVsPrevDay: null,
    ...fleetCounts({ operational, inactive, warehouse, neverReported }),
    ...rest,
  };
}

export function companyPlantRow(
  over: Partial<CompanyPlantRow> & {
    companyId: string;
    companyName: string;
    plantId: string;
    plantName: string;
    operational: number;
    inactive?: number;
    warehouse?: number;
    neverReported?: number;
  },
): CompanyPlantRow {
  const { operational, inactive, warehouse, neverReported, ...rest } = over;
  return {
    companyTier: 'GOLD',
    zoneId: '1',
    byBucket: {},
    ...fleetCounts({ operational, inactive, warehouse, neverReported }),
    ...rest,
  };
}

export function fleetSummary(
  over: Partial<FleetSummary> & { operational: number; inactive?: number; warehouse?: number; neverReported?: number },
): FleetSummary {
  const { operational, inactive, warehouse, neverReported, ...rest } = over;
  return {
    companies: 1,
    plants: 1,
    catalogDevices: null,
    lastMasterSyncAt: null,
    lastSnapshotAt: null,
    ...fleetCounts({ operational, inactive, warehouse, neverReported }),
    ...rest,
  };
}
