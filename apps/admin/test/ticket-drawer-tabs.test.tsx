import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { TicketDetailDrawer } from '../src/pages/tickets/TicketDetailDrawer';

/**
 * FE-09 — filling the Ticket Detail Drawer Verification + Assignment-History tabs from data that
 * already exists (Issue 18 `GET /tickets/:id/verification`; the loaded `ticket.lifecycle` for
 * assignment/override transitions). No new backend beyond #70's forms read.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };
const TICKET_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const detail = {
  ticketId: TICKET_ID,
  workType: 'TROUBLESHOOT',
  status: 'VERIFICATION_PENDING',
  deviceId: '900',
  vehicleId: '12',
  plantId: '7',
  companyId: '3',
  companyTier: 'GOLD',
  assignmentState: 'AUTO_ASSIGNED',
  slaBucket: 'CRITICAL',
  repeatFailure: false,
  failureCycleState: 'SUBMITTED',
  failureCycleId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  createdAt: '2026-06-20T10:00:00.000Z',
  lastStateChangedAt: '2026-06-20T10:00:00.000Z',
  lifecycle: [
    { fromState: null, toState: 'OPEN', actorId: null, actorRole: null, actedAsRole: null, reasonCode: null, at: '2026-06-20T10:00:00.000Z' },
    { fromState: 'OPEN', toState: 'OPEN', actorId: 'zm1', actorRole: 'ZONAL_MANAGER', actedAsRole: null, reasonCode: 'REASSIGNED', at: '2026-06-20T12:00:00.000Z' },
  ],
};

const verification = {
  ticketId: TICKET_ID,
  phase: 'PHASE_1_PASS',
  pingsReceivedCount: 2,
  outcome: null,
  fraudFlag: false,
  firstPingDistanceMeters: 120,
  badge: 'PARTIAL_RECOVERY',
};

const fetchMock = vi.fn();

function stub(verificationStatus = 200) {
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.includes(`/tickets/${TICKET_ID}/verification`)) return json(verificationStatus === 200 ? verification : { code: 'NO_VERIFICATION_RUN' }, verificationStatus);
    if (u.includes(`/tickets/${TICKET_ID}/forms`)) return json({ ticketId: TICKET_ID, forms: [] });
    if (u.includes(`/tickets/${TICKET_ID}`)) return json(detail);
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => sessionStorage.setItem('fsm.accessToken', 'tok'));
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

function renderDrawer() {
  return render(
    <AuthProvider initialSession={zm}>
      <MemoryRouter initialEntries={[`/tickets/${TICKET_ID}`]}>
        <Routes>
          <Route path="/tickets/:ticketId" element={<TicketDetailDrawer />} />
          <Route path="/tickets" element={<div>Tickets list</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe('FE-09 Verification + Assignment-History tabs', () => {
  it('renders the verification run outcome/badge on the Verification tab', async () => {
    stub();
    renderDrawer();
    const drawer = await screen.findByRole('complementary', { name: /ticket detail/i });
    await userEvent.click(within(drawer).getByRole('tab', { name: 'Verification' }));
    const panel = await within(drawer).findByTestId('verification-panel');
    expect(panel).toHaveTextContent(/PARTIAL_RECOVERY/);
    expect(panel).toHaveTextContent(/PHASE_1_PASS/);
  });

  it('shows an empty state when the ticket has no verification run', async () => {
    stub(404);
    renderDrawer();
    const drawer = await screen.findByRole('complementary', { name: /ticket detail/i });
    await userEvent.click(within(drawer).getByRole('tab', { name: 'Verification' }));
    expect(await within(drawer).findByText(/no verification/i)).toBeInTheDocument();
  });

  it('lists human assignment/override transitions on the Assignment History tab', async () => {
    stub();
    renderDrawer();
    const drawer = await screen.findByRole('complementary', { name: /ticket detail/i });
    await userEvent.click(within(drawer).getByRole('tab', { name: 'Assignment History' }));
    const panel = await within(drawer).findByTestId('assignment-history-panel');
    expect(panel).toHaveTextContent(/REASSIGNED/);
    expect(panel).toHaveTextContent(/ZONAL_MANAGER/);
  });
});
