import type { SessionView } from '@fsm/shared';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { DashboardHome } from '../src/pages/dashboard/DashboardHome';

/**
 * FE-07 — role-variant dashboards. The same role-scoped aggregations render different bodies by
 * `session.role` / `actingZone` (no new endpoints). ZM is unaffected; a role acting as ZM collapses to
 * the Zone Operations view (reference 02).
 */
const opsHead: SessionView = { user_id: 'oh1', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };
const csm: SessionView = { user_id: 'csm1', role: 'CENTRAL_SERVICE_MANAGER', zone_id: null, acted_as_role: null };
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      let body: unknown = [];
      if (url.includes('dashboard/zone-overview')) {
        body = [
          { zoneId: '1', zoneName: 'NORTH', totalInactive: 5, byBucket: { CRITICAL: 3, WARNING: 2 }, trendPctVsPrevDay: null },
          { zoneId: '2', zoneName: 'SOUTH', totalInactive: 2, byBucket: { WARNING: 2 }, trendPctVsPrevDay: null },
        ];
      } else if (url.includes('dashboard/critical-queue')) {
        body = [
          {
            companyId: '10', companyName: 'Acme Logistics', companyTier: 'PLATINUM', zoneId: '1',
            plantId: '7', plantName: 'Yard-1', clusterSize: 1, suggestedSes: [],
            tickets: [{ ticketId: 't1', deviceId: '900', slaBucket: 'CRITICAL', status: 'OPEN' }],
          },
        ];
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

function renderHome(session: SessionView) {
  return render(
    <AuthProvider initialSession={session}>
      <MemoryRouter>
        <DashboardHome />
      </MemoryRouter>
    </AuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('FE-07 role-variant dashboards', () => {
  it('Operations Head sees the Pan-India Fleet Command variant (KPIs + efficiency + distribution + scorecard)', async () => {
    stubFetch();
    renderHome(opsHead);

    expect(await screen.findByText('Pan-India Fleet Command')).toBeInTheDocument();
    expect(screen.getByText(/auto-dispatch system efficiency/i)).toBeInTheDocument();
    expect(screen.getByText(/sla bucket distribution/i)).toBeInTheDocument();
    expect(screen.getByRole('table', { name: /zone performance scorecard/i })).toBeInTheDocument();
    // Not the ZM variant.
    expect(screen.queryByText('Zone Operations Dashboard')).not.toBeInTheDocument();
  });

  it('Central Service Manager (not acting) sees the Cross-Zone Central Tower with the Escalation Queue', async () => {
    stubFetch();
    renderHome(csm);

    expect(await screen.findByText('Cross-Zone Central Tower')).toBeInTheDocument();
    expect(screen.getByText(/escalation queue/i)).toBeInTheDocument();
    // The escalation feed is derived from the critical-queue aggregation.
    expect(await screen.findByTestId('escalation-item')).toHaveTextContent('900');
    expect(screen.getByRole('table', { name: /zone performance scorecard/i })).toBeInTheDocument();
    expect(screen.queryByText('Zone Operations Dashboard')).not.toBeInTheDocument();
  });

  it('a CSM acting as ZM collapses to the Zone Operations Dashboard (reference 02)', async () => {
    sessionStorage.setItem('fsm.actingZone', '3');
    stubFetch();
    renderHome(csm);

    expect(await screen.findByText('Zone Operations Dashboard')).toBeInTheDocument();
    expect(screen.queryByText('Cross-Zone Central Tower')).not.toBeInTheDocument();
  });

  it('a Zonal Manager is unaffected — still the Zone Operations Dashboard', async () => {
    stubFetch();
    renderHome(zm);

    expect(await screen.findByText('Zone Operations Dashboard')).toBeInTheDocument();
    expect(screen.queryByText('Pan-India Fleet Command')).not.toBeInTheDocument();
  });
});
