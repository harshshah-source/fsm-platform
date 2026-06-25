import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { TicketDetailDrawer } from '../src/pages/tickets/TicketDetailDrawer';

/**
 * Issue 62 — the Ticket Detail **Components** tab (v2-reference/08-ticket-detail, 28-tickets-drawer).
 * Replaces the stub: lists the ticket's Component Request(s) with status + requested component, shows
 * delivery destination + tracking when SHIPPED / rejection reason when REJECTED, and a
 * WAITING_COMPONENT / SLA-paused badge derived from the Failure Cycle state. Read-only.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };
const TICKET_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const detail = {
  ticketId: TICKET_ID,
  workType: 'TROUBLESHOOT',
  status: 'OPEN',
  deviceId: '900',
  vehicleId: '12',
  plantId: '7',
  companyId: '3',
  companyTier: 'GOLD',
  assignmentState: 'UNASSIGNED',
  slaBucket: 'CRITICAL',
  repeatFailure: false,
  failureCycleState: 'WAITING_COMPONENT',
  componentRequestStatus: 'SHIPPED',
  waitingComponentSince: '2026-06-25T08:00:00.000Z',
  failureCycleId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  createdAt: '2026-06-20T10:00:00.000Z',
  lastStateChangedAt: '2026-06-20T10:00:00.000Z',
  lifecycle: [],
};

const requests = [
  {
    requestId: 'r1', ticketId: TICKET_ID, seId: 'se-1', componentId: '9', componentName: 'GPS Antenna',
    companyName: 'Acme', zoneName: 'NORTH', status: 'SHIPPED', deliveryDestination: 'SE_LOCATION',
    trackingRef: 'TRK-9', rejectionReason: null, createdAt: '2026-06-25T07:00:00.000Z', ageDays: 0,
  },
];

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = url.includes('/component-requests/by-ticket/') ? requests : url.includes(`/tickets/${TICKET_ID}`) ? detail : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

function renderDrawer() {
  return render(
    <AuthProvider initialSession={zm}>
      <MemoryRouter initialEntries={[`/tickets/${TICKET_ID}?tab=Components`]}>
        <Routes>
          <Route path="/tickets/:ticketId" element={<TicketDetailDrawer />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe('Ticket Detail Components tab (Issue 62)', () => {
  it('lists the ticket Component Request with status, component, and tracking', async () => {
    renderDrawer();
    const drawer = await screen.findByRole('complementary', { name: /ticket detail/i });
    // Deep-linked straight to Components via ?tab=Components.
    expect(await within(drawer).findByText('GPS Antenna')).toBeInTheDocument();
    expect(within(drawer).getByText('SHIPPED')).toBeInTheDocument();
    expect(within(drawer).getByText(/TRK-9/)).toBeInTheDocument();
    expect(within(drawer).getByText(/SE_LOCATION/)).toBeInTheDocument();
  });

  it('shows the WAITING_COMPONENT / SLA-paused badge derived from the Failure Cycle', async () => {
    renderDrawer();
    const drawer = await screen.findByRole('complementary', { name: /ticket detail/i });
    expect(await within(drawer).findByTestId('waiting-component-badge')).toBeInTheDocument();
  });
});
