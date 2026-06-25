import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { VehicleUnavailabilityPage } from '../src/pages/readiness/VehicleUnavailabilityPage';

/**
 * Issue 28 slice 4 — the ZM Vehicle Unavailability Review page (`/readiness/vehicle-unavailability`,
 * v2-reference/11-vehicle-unavailability). A metric strip, a table of OPEN reports (ticket / vehicle
 * & plant / reason / filed-by / expected date / BOTH SLA clocks / status), and per-row manager
 * actions: Confirm date, Resume SLA. The secondary (never-pausing) clock is manager-only by living on
 * this manager-gated surface. Manager roles only.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

const rows = [
  {
    id: 'rep-1', ticketId: 't-1111aaaa', seId: 'se-1', plantName: 'Pune Yard', reasonCode: 'VEHICLE_ON_TRIP',
    transporterContacted: true, expectedFrom: '2026-06-26T09:00:00.000Z', expectedTo: null, notes: 'on a trip',
    status: 'OPEN', slaPaused: true, primarySlaSeconds: 7200, secondarySlaSeconds: 10800, createdAt: '2026-06-25T10:00:00.000Z',
  },
  {
    id: 'rep-2', ticketId: 't-2222bbbb', seId: 'se-2', plantName: 'Nagpur Depot', reasonCode: 'DRIVER_NOT_AVAILABLE',
    transporterContacted: false, expectedFrom: '2026-06-27T09:00:00.000Z', expectedTo: null, notes: null,
    status: 'OPEN', slaPaused: true, primarySlaSeconds: 3600, secondarySlaSeconds: 14400, createdAt: '2026-06-25T08:00:00.000Z',
  },
];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

function renderPage() {
  return render(
    <AuthProvider initialSession={zm}>
      <MemoryRouter initialEntries={['/readiness/vehicle-unavailability']}>
        <Routes>
          <Route path="/readiness/vehicle-unavailability" element={<VehicleUnavailabilityPage />} />
          <Route path="/tickets/:id" element={<div>Ticket drawer stub</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/vehicle-unavailability') && (!init || init.method === undefined || init.method === 'GET')) return json(rows);
    if (/\/vehicle-unavailability\/.+\/(confirm-date|resume-sla)$/.test(u)) return json({ result: 'OK', id: 'rep-1' });
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Vehicle Unavailability Review (Issue 28)', () => {
  it('renders a row per OPEN report with the reason and BOTH SLA clocks', async () => {
    renderPage();
    const table = within(await screen.findByRole('table', { name: /vehicle unavailability/i }));
    expect(table.getByText('Pune Yard')).toBeInTheDocument();
    expect(table.getByText('Nagpur Depot')).toBeInTheDocument();
    // Reason rendered humanised.
    expect(table.getByText(/vehicle on trip/i)).toBeInTheDocument();
    // Both clocks present on a row: primary (paused, effective) AND secondary (true elapsed).
    const row = within(screen.getByTestId('vu-row-rep-1'));
    expect(row.getByTestId('vu-primary-rep-1')).toHaveTextContent('2h 0m');
    expect(row.getByTestId('vu-secondary-rep-1')).toHaveTextContent('3h 0m');
  });

  it('confirms a new expected date via the manager action', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /vehicle unavailability/i });
    await user.click(within(screen.getByTestId('vu-row-rep-1')).getByRole('button', { name: /confirm date/i }));
    const input = await screen.findByLabelText(/expected date/i);
    await user.clear(input);
    await user.type(input, '2026-06-28T09:00');
    await user.click(screen.getByRole('button', { name: /save date/i }));
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => /\/vehicle-unavailability\/rep-1\/confirm-date$/.test(String(url)) && (init as RequestInit)?.method === 'POST',
      ),
    ).toBe(true);
  });

  it('resumes the SLA via the manager action', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /vehicle unavailability/i });
    await user.click(within(screen.getByTestId('vu-row-rep-2')).getByRole('button', { name: /resume sla/i }));
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => /\/vehicle-unavailability\/rep-2\/resume-sla$/.test(String(url)) && (init as RequestInit)?.method === 'POST',
      ),
    ).toBe(true);
  });
});