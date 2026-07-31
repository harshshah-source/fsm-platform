import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { DashboardHome } from '../src/pages/dashboard/DashboardHome';
import { DeviceDetailPage } from '../src/pages/reports/DeviceDetailPage';
import { FleetDirectoryPage } from '../src/pages/reports/FleetDirectoryPage';

/**
 * Issue 122b UI — (1) the dashboard KPI strip carries Companies / Plants / Devices from
 * `/dashboard/fleet-summary` (replacing the Action-Required card); (2) the Device Detail page's
 * plant dropdown follows the company pick; (3) the Assign-SE panel drives
 * `POST /api/schedules/assign-plants` with the selected plants + SE.
 */
const OH: SessionView = { user_id: 'oh', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

const filterOptions = {
  zones: [{ zoneId: 1, name: 'North' }],
  companies: [
    { companyId: 7, name: 'UltraTech' },
    { companyId: 8, name: 'Prism' },
  ],
  plants: [
    { plantId: 100, name: 'UT Plant A', companyId: 7 },
    { plantId: 101, name: 'UT Plant B', companyId: 7 },
    { plantId: 200, name: 'Prism Plant', companyId: 8 },
  ],
  hasUnzoned: false,
};

const engineers = [
  { seId: 'se-1', name: 'Karan Singh', zoneId: '1', coverageType: 'DEDICATED', activityStatus: 'AVAILABLE', availabilityStatus: 'AVAILABLE', activeTicketCount: 1, kitComplete: true, missingKit: [], dailyCapacity: 8, isActive: true },
];

beforeEach(() => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/schedules/assign-plants') && init?.method === 'POST')
      return json({ seId: 'se-1', assigned: 3, alreadyAssigned: 0, perPlant: [{ plantId: '100', assigned: 2, openUnassigned: 2 }, { plantId: '101', assigned: 1, openUnassigned: 1 }] });
    if (u.includes('/dashboard/fleet-summary')) return json({ companies: 42, plants: 1180, operationalDevices: 19301, warehouseDevices: 5823, mirroredDevices: 25124, inactiveOperational: 3476, healthyOperational: 15825, inactivePct: 18, fleetHealthPct: 82, catalogDevices: 54210, lastMasterSyncAt: '2026-07-29T05:49:04.756Z', lastSnapshotAt: '2026-07-29T06:02:02.248Z' });
    if (u.includes('/dashboard/fleet-directory'))
      return json({
        companies: [{ companyId: '7', name: 'UltraTech', tier: 'PLATINUM', plantCount: 2, mirroredDevices: 120, operationalDevices: 100, warehouseDevices: 20, inactiveOperational: 10, healthyOperational: 90, inactivePct: 10, fleetHealthPct: 90, lastSnapshotAt: null, lastActivityAt: null }],
        plants: [
          { plantId: '100', name: 'UT Plant A', companyId: '7', companyName: 'UltraTech', zoneName: 'North', mirroredDevices: 80, operationalDevices: 70, warehouseDevices: 10, inactiveOperational: 7, healthyOperational: 63, inactivePct: 10, fleetHealthPct: 90, lastSnapshotAt: null, lastActivityAt: null },
          { plantId: '200', name: 'Prism Plant', companyId: '8', companyName: 'Prism', zoneName: 'East', mirroredDevices: 40, operationalDevices: 30, warehouseDevices: 10, inactiveOperational: 3, healthyOperational: 27, inactivePct: 10, fleetHealthPct: 90, lastSnapshotAt: null, lastActivityAt: null },
        ],
      });
    if (u.includes('/devices/filter-options')) return json(filterOptions);
    if (u.includes('/devices')) return json({ rows: [], total: 0 });
    if (/\/engineers$/.test(u)) return json(engineers);
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
  sessionStorage.setItem('fsm.accessToken', 'tok');
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Issue 122b — fleet KPI cards', () => {
  it('shows Companies / Plants / Devices counts and no Action-Required KPI card', async () => {
    render(
      <AuthProvider initialSession={OH}>
        <MemoryRouter>
          <DashboardHome />
        </MemoryRouter>
      </AuthProvider>,
    );
    // The OH strip renders values through the RollingNumber odometer (plain digits, no grouping).
    expect(await screen.findByTestId('kpi-companies')).toHaveTextContent('42');
    expect(screen.getByTestId('kpi-plants')).toHaveTextContent('1180');
    expect(screen.getByTestId('kpi-devices')).toHaveTextContent('19301'); // Active Fleet (deployed)
    // Total Devices — the raw AutoPlant source catalog, pan-India (odometer digits, no grouping).
    expect(screen.getByTestId('kpi-total-devices')).toHaveTextContent('54210');
    // The Action-Required KPI card is gone from the strip (the panel below is a ZM-view feature).
    expect(screen.queryByText(/^action required$/i)).toBeNull();
  });
});

describe('Issue 122b — Fleet Directory click-through', () => {
  it('the Companies KPI card navigates to the directory, which lists companies and plants by name', async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={OH}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<DashboardHome />} />
            <Route path="/reports/fleet" element={<FleetDirectoryPage />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    );
    await user.click(await screen.findByTestId('kpi-companies'));

    // Companies tab first: the company row is there by NAME with its counts.
    const companiesTable = within(await screen.findByRole('table', { name: /fleet companies/i }));
    expect(companiesTable.getByText('UltraTech')).toBeInTheDocument();
    expect(companiesTable.getByText('120')).toBeInTheDocument();

    // Clicking the company row jumps to its plants.
    await user.click(companiesTable.getByText('UltraTech'));
    const plantsTable = within(await screen.findByRole('table', { name: /fleet plants/i }));
    expect(plantsTable.getByText(/UT Plant A/)).toBeInTheDocument();
    expect(plantsTable.queryByText(/Prism Plant/)).not.toBeInTheDocument(); // other company filtered out
  });
});

describe('Issue 122b — Device Detail assignment flow', () => {
  function renderPage() {
    return render(
      <AuthProvider initialSession={OH}>
        <MemoryRouter>
          <DeviceDetailPage />
        </MemoryRouter>
      </AuthProvider>,
    );
  }

  it('plant dropdown follows the company pick', async () => {
    const user = userEvent.setup();
    renderPage();
    const plantSelect = await screen.findByLabelText<HTMLSelectElement>('Plant');
    // Unscoped: all three plants (+ "All plants").
    await waitFor(() => expect(plantSelect.options.length).toBe(4));

    await user.selectOptions(screen.getByLabelText('Company'), '7');
    await waitFor(() => expect(plantSelect.options.length).toBe(3)); // UltraTech's two + All
    expect([...plantSelect.options].map((o) => o.text)).toContain('UT Plant A');
    expect([...plantSelect.options].map((o) => o.text)).not.toContain('Prism Plant');
  });

  it('assigns selected plants to the chosen SE via /schedules/assign-plants', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('assign-se-toggle'));
    const panel = within(await screen.findByTestId('assign-se-panel'));

    await user.click(await panel.findByLabelText(/UT Plant A/i));
    await user.click(panel.getByLabelText(/UT Plant B/i));
    await user.click(await panel.findByRole('radio'));
    await user.click(screen.getByTestId('assign-se-submit'));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u, init]) =>
        String(u).includes('/schedules/assign-plants') && (init as RequestInit)?.method === 'POST');
      expect(call).toBeDefined();
      const body = JSON.parse(String((call![1] as RequestInit).body));
      expect(body.seId).toBe('se-1');
      expect(body.plantIds.sort()).toEqual(['100', '101']);
    });
    expect(await screen.findByTestId('assign-result')).toHaveTextContent('3 assigned');
  });
});
