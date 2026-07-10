import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../src/AppRoutes';
import { AuthProvider } from '../src/auth/AuthProvider';
import { ZmScorecardPage } from '../src/pages/reports/ZmScorecardPage';

/**
 * FE-25 — ZM Performance Scorecard (ref 25). Leader card + scorecard table over the Issue 43
 * `/reports/zm-scorecard` endpoint. Operations-Head only (server + route gated).
 */
const OH: SessionView = { user_id: 'oh', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };
const ZM: SessionView = { user_id: 'zm', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

const base = { removals: 0, deferrals: 0, reorders: 0, swaps: 0, reassignments: 0, splitBatches: 0, overrideAfterOnsite: 0 };
const report = {
  fromMonth: '2026-06-01', toMonth: '2026-06-30', zoneId: null,
  rows: [
    { zmId: 'zm-1', zmName: 'Asha', zoneId: 1, zoneName: 'West', overrides: 12, manualAssignments: 5, autoAssigned: 120, overrideRatePct: 10, zoneSlaCompliancePct: 97.5, ...base },
    { zmId: 'zm-2', zmName: 'Ravi', zoneId: 2, zoneName: 'East', overrides: 30, manualAssignments: 9, autoAssigned: 130, overrideRatePct: 22, zoneSlaCompliancePct: 92, ...base },
  ],
  trend: [],
};

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

beforeEach(() => {
  sessionStorage.setItem('fsm.accessToken', 'tok');
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes('/reports/zm-scorecard')) return json(report);
    // The dashboard's /dashboard/* reads are all array-typed; return [] so its tables/KPI strip render
    // during the scorecard assertion instead of throwing on a non-array payload (#114 fold-in).
    if (u.includes('/dashboard/')) return json([]);
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('ZM Performance Scorecard (FE-25)', () => {
  it('renders the leader card and the scorecard table from the endpoint', async () => {
    render(<ZmScorecardPage />);
    expect(await screen.findByRole('heading', { name: /zm performance scorecard/i })).toBeInTheDocument();
    // Leader = the ZM with the highest zone SLA compliance (Asha, 97.5%).
    expect(await screen.findByTestId('zm-leader')).toHaveTextContent(/Asha/);
    const table = await screen.findByRole('table', { name: /zm scorecard/i });
    const row = within(table).getByTestId('zm-row-zm-2');
    expect(row).toHaveTextContent(/Ravi/);
    expect(row).toHaveTextContent(/22/); // override rate
    expect(row).toHaveTextContent(/92/); // zone SLA compliance
  });

  it('is reachable by Operations Head but redirects a Zonal Manager', async () => {
    const at = (session: SessionView) =>
      render(
        <AuthProvider initialSession={session}>
          <MemoryRouter initialEntries={['/reports/zm-scorecard']}>
            <AppRoutes />
          </MemoryRouter>
        </AuthProvider>,
      );
    const oh = at(OH);
    expect(await screen.findByRole('heading', { name: /zm performance scorecard/i })).toBeInTheDocument();
    oh.unmount();

    at(ZM);
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /zm performance scorecard/i })).toBeNull();
    });
  });
});
