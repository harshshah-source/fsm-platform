import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { SeManagementPage } from '../src/pages/engineers/SeManagementPage';

/**
 * Issue 25 — SE Management page (`/engineers`, v2-reference/15-se-activity). SE list with the
 * render-time Activity Status, coverage type, today's ticket count, and Common-Kit chip (AC#1);
 * row → detail panel with Day Plan status, per-component Van Stock (missing in red), and
 * availability rows (AC#2); a ZM/CSM Set-Availability action (AC#3). Operations Head is read-only.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };
const ops: SessionView = { user_id: 'ops1', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };

const list = [
  { seId: 'se-busy', name: 'Karan Singh', zoneId: '1', coverageType: 'DEDICATED', activityStatus: 'BUSY', availabilityStatus: 'AVAILABLE', activeTicketCount: 4, kitComplete: true, missingKit: [], dailyCapacity: 10, isActive: true },
  { seId: 'se-leave', name: 'Rajesh Kumar', zoneId: '1', coverageType: 'FLOATING', activityStatus: 'ON_LEAVE', availabilityStatus: 'ON_LEAVE', activeTicketCount: 0, kitComplete: false, missingKit: [{ componentId: '9', name: 'SIM', shortBy: 1 }], dailyCapacity: 8, isActive: true },
];

const detail = {
  seId: 'se-busy',
  name: 'Karan Singh',
  zoneId: '1',
  coverageType: 'DEDICATED',
  dailyCapacity: 10,
  isActive: true,
  activityStatus: 'BUSY',
  availabilityStatus: 'AVAILABLE',
  dayPlan: { status: 'ACTIVE', ticketCount: 4 },
  vanStock: [{ componentId: '7', name: 'GPS Antenna', qty: 3 }],
  kit: { complete: false, missing: [{ componentId: '9', name: 'SIM', shortBy: 1 }] },
  availabilityRows: [{ status: 'ON_LEAVE', windowStart: '2026-06-25T00:00:00Z', windowEnd: '2026-06-26T00:00:00Z', reason: 'leave', setByRole: 'ZONAL_MANAGER' }],
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

function renderPage(session: SessionView = zm) {
  return render(
    <AuthProvider initialSession={session}>
      <MemoryRouter initialEntries={['/engineers']}>
        <Routes>
          <Route path="/engineers" element={<SeManagementPage />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (/\/engineers\/se-busy\/availability$/.test(u) && init?.method === 'POST') return json({ result: 'OK', id: '1' });
    if (/\/engineers\/se-busy$/.test(u)) return json(detail);
    if (/\/engineers$/.test(u)) return json(list);
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('SE Management page (Issue 25)', () => {
  it('lists SEs with derived Activity Status, coverage type, ticket count, and kit chip', async () => {
    renderPage();
    const table = within(await screen.findByRole('table', { name: /se management/i }));
    const busy = within(screen.getByTestId('se-row-se-busy'));
    expect(busy.getByText('Karan Singh')).toBeInTheDocument();
    expect(busy.getByText('BUSY')).toBeInTheDocument();
    expect(busy.getByText('DEDICATED')).toBeInTheDocument();
    // kit chip for the short SE
    expect(within(screen.getByTestId('se-row-se-leave')).getByText(/kit short/i)).toBeInTheDocument();
    // metric card counts (one BUSY)
    expect(within(screen.getByTestId('se-metric-BUSY')).getByText('1')).toBeInTheDocument();
    expect(table).toBeTruthy();
  });

  it('opens the detail panel with Day Plan, Van Stock, and availability rows', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /se management/i });
    await user.click(within(screen.getByTestId('se-row-se-busy')).getByRole('button', { name: /karan singh/i }));
    const panel = within(await screen.findByRole('region', { name: /se detail/i }));
    expect(await panel.findByText(/GPS Antenna/)).toBeInTheDocument(); // van stock (loads async)
    expect(panel.getByText(/SIM/)).toBeInTheDocument(); // missing kit, shown in red
    expect(panel.getAllByText(/ON_LEAVE/).length).toBeGreaterThan(0); // availability row
  });

  it('lets a ZM set availability on the selected SE', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /se management/i });
    await user.click(within(screen.getByTestId('se-row-se-busy')).getByRole('button', { name: /karan singh/i }));
    await screen.findByRole('region', { name: /se detail/i });
    await user.selectOptions(screen.getByLabelText(/status/i), 'OFF_SHIFT');
    await user.type(screen.getByLabelText(/window start/i), '2026-06-26T09:00');
    await user.click(screen.getByRole('button', { name: /set availability/i }));
    expect(
      fetchMock.mock.calls.some(
        ([u, init]) => /\/engineers\/se-busy\/availability$/.test(String(u)) && (init as RequestInit)?.method === 'POST',
      ),
    ).toBe(true);
  });

  it('hides the Set Availability action from Operations Head (read-only)', async () => {
    const user = userEvent.setup();
    renderPage(ops);
    await screen.findByRole('table', { name: /se management/i });
    await user.click(within(screen.getByTestId('se-row-se-busy')).getByRole('button', { name: /karan singh/i }));
    await screen.findByRole('region', { name: /se detail/i });
    expect(screen.queryByRole('button', { name: /set availability/i })).not.toBeInTheDocument();
  });
});
