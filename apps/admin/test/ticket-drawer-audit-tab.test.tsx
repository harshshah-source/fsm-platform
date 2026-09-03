import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { TicketDetailDrawer } from '../src/pages/tickets/TicketDetailDrawer';

/**
 * #342 AC4 — the drawer's Audit tab.
 *
 * The drawer's history has always been derived from `ticket.lifecycle`, which is the *state* chain.
 * Every audited *action* on the ticket — who reassigned it, who overrode the engine, under whose
 * authority, and why — was written to `audit_logs` and then never read by any screen. This tab is
 * that chain, and the assertion that matters is the acting attribution: a CSM's action taken under a
 * ZM's backup authority must not read as the ZM's own.
 */
const TICKET_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

const detail = {
  ticketId: TICKET_ID,
  workType: 'TROUBLESHOOT',
  status: 'OPEN',
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

const trail = {
  ticketId: TICKET_ID,
  entries: [
    // A state change — the Lifecycle tab's business, and it must NOT appear on the Audit tab.
    { at: '2026-06-20T10:00:00.000Z', kind: 'STATE_CHANGE', actorId: null, actorRole: null, actedAsRole: null, fromState: null, toState: 'OPEN' },
    {
      at: '2026-06-20T11:00:00.000Z',
      kind: 'ACTION',
      actorId: 'csm-1',
      actorRole: 'CENTRAL_SERVICE_MANAGER',
      actedAsRole: 'ZONAL_MANAGER',
      action: 'CRITICAL_ASSIGN',
      actingZone: '1',
      metadata: { previous: 'se-4', next: 'se-9', reason: 'nearest engineer already on site' },
    },
  ],
};

const fetchMock = vi.fn();
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });

function renderDrawer() {
  return render(
    <AuthProvider initialSession={zm}>
      <MemoryRouter initialEntries={[`/tickets/${TICKET_ID}`]}>
        <Routes>
          <Route path="/tickets/:ticketId" element={<TicketDetailDrawer />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => {
  sessionStorage.setItem('fsm.accessToken', 'tok');
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes(`/audit-trail/tickets/${TICKET_ID}`)) return json(trail);
    if (u.includes(`/tickets/${TICKET_ID}`)) return json(detail);
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('#342 — Ticket drawer Audit tab', () => {
  it('shows the ticket action chain with actor, acting role, from/to and reason', async () => {
    renderDrawer();
    await userEvent.click(await screen.findByRole('tab', { name: 'Audit' }));

    const card = await screen.findByTestId('audit-action-CRITICAL_ASSIGN');
    expect(within(card).getByText(/CENTRAL_SERVICE_MANAGER/)).toBeInTheDocument();
    expect(within(card).getByText(/acting as ZONAL_MANAGER/)).toBeInTheDocument();
    expect(within(card).getByText('se-4')).toBeInTheDocument();
    expect(within(card).getByText('se-9')).toBeInTheDocument();
    expect(within(card).getByText(/nearest engineer already on site/)).toBeInTheDocument();
  });

  it('shows only actions — the state chain stays on the Lifecycle tab', async () => {
    renderDrawer();
    await userEvent.click(await screen.findByRole('tab', { name: 'Audit' }));

    const panel = await screen.findByTestId('audit-panel');
    expect(within(panel).queryByText('OPEN')).not.toBeInTheDocument();
  });

  it('loads the trail lazily — nothing is fetched until the tab is opened', async () => {
    renderDrawer();
    await screen.findByRole('tab', { name: 'Audit' });
    const before = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/audit-trail')).length;
    expect(before).toBe(0);

    await userEvent.click(screen.getByRole('tab', { name: 'Audit' }));
    await screen.findByTestId('audit-action-CRITICAL_ASSIGN');
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/audit-trail'))).toHaveLength(1);
  });

  it('says so plainly when a ticket has no audited actions', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/audit-trail/tickets/')) return json({ ticketId: TICKET_ID, entries: [] });
      if (u.includes(`/tickets/${TICKET_ID}`)) return json(detail);
      return json([]);
    });
    renderDrawer();
    await userEvent.click(await screen.findByRole('tab', { name: 'Audit' }));

    expect(await screen.findByText(/No audited actions on this ticket yet/)).toBeInTheDocument();
  });
});
