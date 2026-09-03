import type { SessionView } from '@fsm/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { TicketDetailDrawer } from '../src/pages/tickets/TicketDetailDrawer';

/**
 * #355 AC1 (absorbing **#92**) — a ZM flags a ticket cross-zone from the ticket.
 *
 * `apiCrossZoneFlag` shipped with Issue 32 and had **zero call sites**: the only manual route into the
 * cross-zone queue existed on the wire and nowhere in the product. The drawer is where it belongs,
 * because the ticket is the only place anyone realises their zone cannot cover the work — not the
 * Cross-Zone page, which is the queue the flag creates an entry in.
 *
 * The tier rule is the backend's (`FORBIDDEN_TIER`): Platinum reaches this queue by the auto-sweep, so
 * offering the action on a Platinum ticket would be offering a button that can only 400.
 */
const TICKET_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ZM: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };
const CSM: SessionView = { user_id: 'csm', role: 'CENTRAL_SERVICE_MANAGER', zone_id: null, acted_as_role: null };
const OH: SessionView = { user_id: 'oh', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };

const detail = (tier: string) => ({
  ticketId: TICKET_ID,
  workType: 'TROUBLESHOOT',
  status: 'OPEN',
  deviceId: '900001',
  vehicleId: null,
  plantId: '7',
  companyId: '3',
  companyTier: tier,
  assignmentState: 'UNASSIGNED',
  slaBucket: 'CRITICAL',
  repeatFailure: false,
  failureCycleState: 'OPEN',
  failureCycleId: null,
  createdAt: '2026-06-20T10:00:00.000Z',
  lastStateChangedAt: '2026-06-20T10:00:00.000Z',
  lifecycle: [],
});

const fetchMock = vi.fn();

function stub(tier = 'GOLD', flagStatus = 200) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const json = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('/cross-zone/flag') && init?.method === 'POST') {
      return json(flagStatus === 200 ? { result: 'OK', escalationId: '7' } : { code: 'ALREADY_ESCALATED' }, flagStatus);
    }
    if (u.includes(`/tickets/${TICKET_ID}`)) return json(detail(tier));
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderDrawer(session: SessionView) {
  return render(
    <AuthProvider initialSession={session}>
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
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('#355 AC1 — Flag cross-zone from the ticket drawer', () => {
  it('a ZM flags a Gold ticket with a reason, from the ticket itself', async () => {
    stub('GOLD');
    renderDrawer(ZM);

    fireEvent.click(await screen.findByTestId('flag-cross-zone'));
    fireEvent.change(await screen.findByTestId('flag-cross-zone-reason'), {
      target: { value: 'no local SE with the kit today' },
    });
    fireEvent.click(screen.getByTestId('flag-cross-zone-confirm'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/cross-zone/flag'),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/cross-zone/flag'));
    const body = String((call![1] as RequestInit).body);
    expect(body).toContain(`"ticketId":"${TICKET_ID}"`);
    expect(body).toContain('"reason":"no local SE with the kit today"');
  });

  it('the reason is mandatory — an empty one sends nothing', async () => {
    stub('GOLD');
    renderDrawer(ZM);
    fireEvent.click(await screen.findByTestId('flag-cross-zone'));
    await screen.findByTestId('flag-cross-zone-reason');
    fireEvent.click(screen.getByTestId('flag-cross-zone-confirm'));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/cross-zone/flag'))).toBe(false);
  });

  it('hides the action on a Platinum ticket — that tier reaches the queue by the auto-sweep', async () => {
    stub('PLATINUM');
    renderDrawer(ZM);
    await screen.findByTestId('drawer-assigned-se');
    expect(screen.queryByTestId('flag-cross-zone')).toBeNull();
  });

  it('offers the action to a CSM (who holds the same door) and not to an Operations Head', async () => {
    stub('GOLD');
    const csm = renderDrawer(CSM);
    expect(await screen.findByTestId('flag-cross-zone')).toBeInTheDocument();
    csm.unmount();

    stub('GOLD');
    renderDrawer(OH);
    await screen.findByTestId('drawer-assigned-se');
    expect(screen.queryByTestId('flag-cross-zone')).toBeNull();
  });

  it('surfaces a refused flag rather than failing silently', async () => {
    stub('GOLD', 409);
    renderDrawer(ZM);
    fireEvent.click(await screen.findByTestId('flag-cross-zone'));
    fireEvent.change(await screen.findByTestId('flag-cross-zone-reason'), { target: { value: 'already asked' } });
    fireEvent.click(screen.getByTestId('flag-cross-zone-confirm'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/cross-zone/i);
  });
});

/**
 * #335 (from #244) — the Assignment History tab must survive an attempts payload without its array.
 *
 * `attempts.attempts.length` was read unguarded, so a payload that carried the object but not the list
 * threw during render: React escalated it to an uncaught exception, the tab unmounted for the operator,
 * and `vitest` reported the whole admin run as `1 error` while exiting 1 with every test passing. Fixed
 * here because #355 owns this file; pinned here so the guard is deliberate rather than incidental.
 */
describe('#335 — the Assignment History tab tolerates an attempts payload with no attempts array', () => {
  it('renders the never-dispatched empty state instead of throwing', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
      // The exact shape the defect was found on: the detail payload answering the attempts read, so
      // the object exists and only the array is missing.
      if (u.includes(`/tickets/${TICKET_ID}/attempts`)) return json(detail('GOLD'));
      if (u.includes(`/tickets/${TICKET_ID}`)) return json(detail('GOLD'));
      return json([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderDrawer(ZM);
    fireEvent.click(await screen.findByRole('tab', { name: 'Assignment History' }));

    expect(await screen.findByTestId('assignment-history-panel')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/never been dispatched/i)).toBeInTheDocument());
    // The sibling reads on the same object are equally optional — a missing threshold must not print
    // "undefined" into the verdict an operator is meant to check the SPECIAL badge against.
    expect(screen.queryByText(/undefined/)).toBeNull();
  });
});
