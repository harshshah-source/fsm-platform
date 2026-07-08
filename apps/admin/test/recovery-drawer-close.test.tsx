import type { SessionView } from '@fsm/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { TicketDetailDrawer } from '../src/pages/tickets/TicketDetailDrawer';

/**
 * Issue 37 slice 4 — manual close of an open Recovery Ticket from the Ticket Detail Drawer (AC#2/#3).
 * A manager sees a "Manually close Recovery Ticket" control; closing prompts for a mandatory reason and
 * POSTs to the manual-close endpoint (the backend stamps the closure type by acting role).
 */
const TICKET_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

const recoveryDetail = {
  ticketId: TICKET_ID,
  workType: 'RECOVERY',
  status: 'ON_SITE',
  deviceId: '900001',
  vehicleId: null,
  plantId: '7',
  companyId: '3',
  companyTier: 'GOLD',
  assignmentState: 'UNASSIGNED',
  slaBucket: null,
  repeatFailure: false,
  failureCycleState: null,
  failureCycleId: null,
  createdAt: '2026-06-20T10:00:00.000Z',
  lastStateChangedAt: '2026-06-20T10:00:00.000Z',
  lifecycle: [],
};

const fetchMock = vi.fn();

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

beforeEach(() => {
  sessionStorage.setItem('fsm.accessToken', 'tok');
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes(`/recovery/${TICKET_ID}/manual-close`) && init?.method === 'POST') return json({ ...recoveryDetail, status: 'CLOSED' });
    if (u.includes(`/tickets/${TICKET_ID}`)) return json(recoveryDetail);
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Recovery manual close from drawer (Issue 37 · FE-09 Modal)', () => {
  it('a manager closes an open Recovery Ticket via the reason Modal', async () => {
    renderDrawer();
    // The control opens a Modal (FE-09 AC#3 replaces the window.prompt reason leg).
    fireEvent.click(await screen.findByTestId('recovery-manual-close'));
    const reason = await screen.findByTestId('recovery-close-reason');
    fireEvent.change(reason, { target: { value: 'device lost in transit' } });
    fireEvent.click(screen.getByTestId('recovery-close-confirm'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/recovery/${TICKET_ID}/manual-close`),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('does not POST when the reason is empty (mandatory)', async () => {
    renderDrawer();
    fireEvent.click(await screen.findByTestId('recovery-manual-close'));
    await screen.findByTestId('recovery-close-reason');
    fireEvent.click(screen.getByTestId('recovery-close-confirm'));
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes(`/recovery/${TICKET_ID}/manual-close`)),
    ).toBe(false);
  });
});
