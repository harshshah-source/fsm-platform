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

/** The KPI cards each dashboard is contracted to render. Update this ONLY with the decision recorded. */
const CONTRACT: Record<string, { session: SessionView; testIds: string[] }> = {
  'Operations Head (Pan-India Fleet Command)': {
    session: opsHead,
    testIds: ['kpi-uptime', 'kpi-critical', 'kpi-devices', 'kpi-total-devices', 'kpi-companies', 'kpi-plants'],
  },
  'Zonal Manager': {
    session: zonalManager,
    testIds: ['kpi-uptime', 'kpi-critical', 'kpi-devices', 'kpi-companies', 'kpi-plants'],
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
          { zoneId: '1', zoneName: 'NORTH', zonalManagerName: 'Asha Rao', totalInactive: 10, byBucket: { CRITICAL: 3, WARNING: 2, LONG_PENDING: 5 }, trendPctVsPrevDay: null },
        ];
      } else if (url.includes('dashboard/fleet-summary')) {
        body = { companies: 12, plants: 34, devices: 5678, sourceDevices: 9012 };
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
