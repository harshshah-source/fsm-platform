import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../src/AppRoutes';
import { AuthProvider } from '../src/auth/AuthProvider';

/**
 * Issue 07 slice D — the Ticket Detail Drawer (`/tickets/:ticketId`). Slides in over the list with
 * six tabs; Overview + Lifecycle render real data, the rest are graceful stubs (AC#4/#5).
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
  failureCycleState: 'OPEN',
  failureCycleId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  createdAt: '2026-06-20T10:00:00.000Z',
  lastStateChangedAt: '2026-06-20T10:00:00.000Z',
  lifecycle: [
    { fromState: null, toState: 'OPEN', actorId: null, actorRole: null, actedAsRole: null, reasonCode: null, at: '2026-06-20T10:00:00.000Z' },
  ],
};

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = url.includes(`/tickets/${TICKET_ID}`) ? detail : [];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function renderAt(path: string) {
  return render(
    <AuthProvider initialSession={zm}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe('Ticket Detail Drawer (Issue 07 AC#4/#5)', () => {
  it('opens inline with six tabs and real Overview + Lifecycle data', async () => {
    stubFetch();
    renderAt(`/tickets/${TICKET_ID}`);

    const drawer = await screen.findByRole('complementary', { name: /ticket detail/i });
    for (const tab of ['Overview', 'Lifecycle', 'Forms', 'Verification', 'Components', 'Assignment History']) {
      expect(within(drawer).getByRole('tab', { name: tab })).toBeInTheDocument();
    }
    // Overview (default tab) shows real ticket data.
    expect(within(drawer).getByText(/900/)).toBeInTheDocument();

    // Lifecycle shows the real transition with its target state.
    await userEvent.click(within(drawer).getByRole('tab', { name: 'Lifecycle' }));
    expect(within(drawer).getByText('OPEN')).toBeInTheDocument();

    // A not-yet-built tab is a graceful stub.
    await userEvent.click(within(drawer).getByRole('tab', { name: 'Forms' }));
    expect(within(drawer).getByText(/coming soon/i)).toBeInTheDocument();
  });

  it('keeps the list visible behind the drawer', async () => {
    stubFetch();
    renderAt(`/tickets/${TICKET_ID}`);
    // The Ticket List table is still mounted behind the drawer.
    expect(await screen.findByRole('table', { name: /tickets/i })).toBeInTheDocument();
  });
});
