import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { TicketsPage } from '../src/pages/tickets/TicketsPage';

/**
 * Issue 07 slice C — the Ticket List (`/tickets`). Rows render in the server's SLA-bucket-descending
 * order with colour-coded bucket badges and inline condition badges; filters refetch the list.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

const rows = [
  {
    ticketId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    workType: 'TROUBLESHOOT',
    status: 'OPEN',
    deviceId: '900',
    plantId: '7',
    companyId: '3',
    companyTier: 'GOLD',
    assignmentState: 'UNASSIGNED',
    slaBucket: 'CRITICAL',
    repeatFailure: true,
    failureCycleState: 'OPEN',
    createdAt: '2026-06-20T10:00:00.000Z',
  },
  {
    ticketId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    workType: 'TROUBLESHOOT',
    status: 'CLOSED_AUTO_RECOVERY',
    deviceId: '901',
    plantId: '7',
    companyId: '3',
    companyTier: 'GOLD',
    assignmentState: 'UNASSIGNED',
    slaBucket: 'WARNING',
    repeatFailure: false,
    failureCycleState: null,
    createdAt: '2026-06-20T09:00:00.000Z',
  },
];

const fetchMock = vi.fn();
function stubList() {
  fetchMock.mockImplementation(async () =>
    new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fetchMock);
}

function renderPage() {
  return render(
    <AuthProvider initialSession={zm}>
      <MemoryRouter>
        <TicketsPage />
      </MemoryRouter>
    </AuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Ticket List (Issue 07 AC#1/#2)', () => {
  it('renders rows in server order with bucket and inline badges', async () => {
    stubList();
    renderPage();

    const table = within(await screen.findByRole('table', { name: /tickets/i }));
    const bodyRows = table.getAllByRole('row').slice(1); // drop header
    // Server order preserved: CRITICAL (device 900) before WARNING (device 901).
    expect(bodyRows[0]).toHaveTextContent('900');
    expect(bodyRows[1]).toHaveTextContent('901');
    // Colour-coded bucket badge + inline condition badges.
    expect(within(bodyRows[0]).getByTestId('bucket-CRITICAL')).toBeInTheDocument();
    expect(within(bodyRows[0]).getByTestId('badge-REPEAT')).toBeInTheDocument();
    expect(within(bodyRows[1]).getByTestId('badge-AUTO_RECOVERY')).toBeInTheDocument();
  });

  it('refetches when a filter changes', async () => {
    stubList();
    renderPage();
    await screen.findByRole('table', { name: /tickets/i });

    await userEvent.selectOptions(screen.getByLabelText(/work type/i), 'INSTALL');

    await waitFor(() => {
      const calledWithFilter = fetchMock.mock.calls.some(([url]) =>
        String(url).includes('workType=INSTALL'),
      );
      expect(calledWithFilter).toBe(true);
    });
  });
});
