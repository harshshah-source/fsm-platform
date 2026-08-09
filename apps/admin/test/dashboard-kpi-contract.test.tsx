import type { SessionView } from '@fsm/shared';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { DashboardHome } from '../src/pages/dashboard/DashboardHome';

/**
 * #143 slice 2 — dashboard KPI *contract*.
 *
 * Guards the class of defect, not one instance of it. `ad03769` reworked the Operations-Head hero and
 * dropped the Critical Devices card as collateral; the only test that noticed was an Issue-122
 * *invariant* test, which failed with `Unable to find element [data-testid="kpi-critical"]` — a message
 * that reads like a broken test, not a deleted feature. It stayed red for 3 commits.
 *
 * This spec asserts the documented KPI set per role, so removing any card fails with a message that
 * names the missing card. It deliberately asserts PRESENCE and identity only — values, ordering,
 * layout and copy belong to the invariant/parity specs, so this file does not go red for a re-word or
 * a re-order.
 */
const opsHead: SessionView = { user_id: 'oh1', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };
const zonalManager: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

/**
 * The KPI cards each dashboard is contracted to render. Update this ONLY with the decision recorded.
 *
 * The `kpi-operational-*` / `kpi-warehouse-*` / `kpi-*-pct` ids belong to the Operational Fleet strip
 * (the KPI-transparency rework): the cards that reconcile exactly with the tables below them.
 *
 * `kpi-never-reported` was added by #223 under operator decision P4 — never-reported devices get their
 * own dashboard figure rather than being folded into a widened "not reporting" number, because "never
 * worked" is an installation-quality failure with a different owner from "stopped working". It is
 * listed here so removing it fails with a message that names it.
 */
const OPERATIONAL_STRIP = [
  'kpi-operational-devices',
  'kpi-healthy-devices',
  'kpi-inactive-operational',
  'kpi-never-reported',
  'kpi-warehouse-devices',
  'kpi-fleet-health-pct',
  'kpi-inactive-pct',
];

const CONTRACT: Record<string, { session: SessionView; testIds: string[] }> = {
  'Operations Head (Pan-India Fleet Command)': {
    session: opsHead,
    testIds: [
      'kpi-uptime', 'kpi-critical', 'kpi-devices', 'kpi-total-devices', 'kpi-companies', 'kpi-plants',
      'kpi-inactive-operational-hero', ...OPERATIONAL_STRIP,
    ],
  },
  'Zonal Manager': {
    session: zonalManager,
    testIds: [
      'kpi-uptime', 'kpi-critical', 'kpi-devices', 'kpi-companies', 'kpi-plants',
      'kpi-inactive-operational-hero', ...OPERATIONAL_STRIP,
    ],
  },
};

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      let body: unknown = [];
      if (url.includes('dashboard/zone-overview')) {
        body = [
          {
            zoneId: '1', zoneName: 'NORTH', zonalManagerName: 'Asha Rao',
            mirroredDevices: 1200, operationalDevices: 1000, warehouseDevices: 200,
            inactiveOperational: 10, healthyOperational: 990, inactivePct: 1, fleetHealthPct: 99,
            byBucket: { CRITICAL: 3, WARNING: 2, LONG_PENDING: 5 }, trendPctVsPrevDay: null,
          },
        ];
      } else if (url.includes('dashboard/fleet-summary')) {
        body = {
          companies: 12, plants: 34,
          mirroredDevices: 6878, operationalDevices: 5678, warehouseDevices: 1200,
          inactiveOperational: 678, healthyOperational: 5000, inactivePct: 11.9, fleetHealthPct: 88.1,
          catalogDevices: 9012, lastMasterSyncAt: '2026-07-29T05:49:04.756Z', lastSnapshotAt: '2026-07-29T06:02:02.248Z',
        };
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('#143 — dashboard KPI contract (a removed card must fail by name)', () => {
  for (const [surface, { session, testIds }] of Object.entries(CONTRACT)) {
    it(`${surface} renders every contracted KPI card`, async () => {
      stubFetch();
      render(
        <AuthProvider initialSession={session}>
          <MemoryRouter>
            <DashboardHome />
          </MemoryRouter>
        </AuthProvider>,
      );

      // Await the first card so the async dashboard reads have settled, then assert the rest
      // synchronously — a missing card then reports its own testId rather than a generic timeout.
      await screen.findByTestId(testIds[0]);
      const missing = testIds.filter((id) => screen.queryAllByTestId(id).length === 0);
      expect(missing, `${surface} is missing contracted KPI card(s): ${missing.join(', ')}`).toEqual([]);
    });
  }
});
