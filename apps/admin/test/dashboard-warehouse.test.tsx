import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { DashboardHome } from '../src/pages/dashboard/DashboardHome';

/**
 * FE-17 — the Warehouse-Manager dashboard variant ("Zone Warehouse Fulfillment", reference 05). A WM
 * session routes to its own dashboard over the existing WM aggregations (component requests /
 * component-blocked / shadow-use) — never the manager-scoped ZM dashboard endpoints.
 */
const wm: SessionView = { user_id: 'wm1', role: 'WAREHOUSE_MANAGER', zone_id: null, acted_as_role: null };

const requests = [
  { requestId: 'req-1', ticketId: 't-1', seId: 'se-1', componentId: '9', componentName: 'GPS Antenna', companyName: 'Acme', zoneName: 'NORTH', status: 'REQUESTED', deliveryDestination: null, trackingRef: null, rejectionReason: null, createdAt: '2026-06-24T06:00:00Z', ageDays: 1 },
];
const shadow = [
  { id: '11', ticketId: 't-2', seId: 'se-2', componentId: '7', componentName: 'SIM', qty: 2, companyName: 'Beta', zoneName: 'NORTH', status: 'SHADOW_USE', reason: null, createdAt: '2026-06-24T06:00:00Z', ageDays: 1 },
];

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      let body: unknown = [];
      if (url.includes('/warehouse/requests')) body = requests;
      else if (url.includes('/warehouse/shadow-use')) body = shadow;
      else if (url.includes('/component-blocked')) body = [];
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

describe('FE-17 Warehouse dashboard', () => {
  it('routes a Warehouse Manager to the Zone Warehouse Fulfillment variant', async () => {
    stubFetch();
    renderHome(wm);

    expect(await screen.findByText('Zone Warehouse Fulfillment')).toBeInTheDocument();
    expect(screen.getByTestId('warehouse-dashboard')).toBeInTheDocument();
    // Not the ZM manager dashboard.
    expect(screen.queryByText('Zone Operations Dashboard')).not.toBeInTheDocument();
  });

  it('renders the component-request queue and shadow-use panel from WM data', async () => {
    stubFetch();
    renderHome(wm);

    const reqTable = within(await screen.findByRole('table', { name: /component request queue/i }));
    expect(reqTable.getByText('GPS Antenna')).toBeInTheDocument();

    const shadowTable = within(screen.getByRole('table', { name: /shadow-use reconciliation/i }));
    expect(shadowTable.getByText('SIM')).toBeInTheDocument();
  });
});
