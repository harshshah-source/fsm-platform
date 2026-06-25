import type { SessionView } from '@fsm/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { NonOperationalQueuePage } from '../src/pages/readiness/NonOperationalQueuePage';

/**
 * Issue 35 slice 5 — Non-Operational dual-confirmation queue (`/readiness/non-operational`). Manager
 * roles see the queue sorted by `awaiting_since` asc with a state badge + a days-elapsed badge and a
 * manager Confirm action; the Mark-Non-Operational modal warns (with an explicit acknowledgement
 * checkbox) that a RECURRING device with a physical-retrieval reason auto-creates a Recovery Ticket.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

const rows = [
  { markingId: 'm-1', deviceId: '900001', state: 'AWAITING_ZM_CONFIRMATION', reasonCode: 'COMPANY_PAUSED', reasonText: null, dealTypeAtMarking: 'RECURRING', effectiveFrom: '2026-06-22T00:00:00.000Z', effectiveTo: '2026-09-20T00:00:00.000Z', awaitingSince: '2026-06-22T00:00:00.000Z', daysElapsed: 3 },
  { markingId: 'm-2', deviceId: '900002', state: 'AWAITING_CUSTOMER_CONFIRMATION', reasonCode: 'VEHICLE_SOLD', reasonText: null, dealTypeAtMarking: 'ONE_TIME', effectiveFrom: '2026-06-25T00:00:00.000Z', effectiveTo: '2027-06-25T00:00:00.000Z', awaitingSince: '2026-06-25T00:00:00.000Z', daysElapsed: 0 },
];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

function renderPage() {
  return render(
    <AuthProvider initialSession={zm}>
      <MemoryRouter initialEntries={['/readiness/non-operational']}>
        <Routes>
          <Route path="/readiness/non-operational" element={<NonOperationalQueuePage />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => {
  sessionStorage.setItem('fsm.accessToken', 'tok');
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/non-op/queue')) return json(rows);
    if (u.includes('/non-op/m-1/confirm')) return json({ ...rows[0], state: 'AWAITING_CUSTOMER_CONFIRMATION' });
    if (u.includes('/devices/900003')) return json({ deviceId: '900003', dealType: 'RECURRING' });
    if (u.endsWith('/non-op') && init?.method === 'POST') return json(rows[0], 201);
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Non-Operational dual-confirmation queue (Issue 35)', () => {
  it('renders a row per marking with its state and days-elapsed badge, sorted as served', async () => {
    renderPage();
    const table = within(await screen.findByRole('table', { name: /non-operational dual confirmation/i }));
    const r1 = table.getByTestId('nonop-row-m-1');
    expect(r1).toHaveTextContent(/awaiting (manager|zm)/i);
    expect(r1).toHaveTextContent(/3d/);
    expect(table.getByTestId('nonop-row-m-2')).toHaveTextContent(/awaiting customer/i);
  });

  it('performs the manager confirmation leg via the Confirm action', async () => {
    renderPage();
    await screen.findByTestId('nonop-row-m-1');
    fireEvent.click(screen.getByTestId('nonop-confirm-m-1'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/non-op/m-1/confirm'),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('warns + requires acknowledgement before marking a RECURRING device with a recovery reason', async () => {
    renderPage();
    await screen.findByTestId('nonop-row-m-1');
    fireEvent.click(screen.getByRole('button', { name: /mark non-operational/i }));

    fireEvent.change(screen.getByLabelText(/device id/i), { target: { value: '900003' } });
    fireEvent.change(screen.getByLabelText(/^reason/i), { target: { value: 'COMPANY_PAUSED' } });

    // RECURRING + qualifying reason → the Recovery-Ticket warning appears and submit stays blocked
    await screen.findByText(/recovery ticket will be auto-created/i);
    const submit = screen.getByRole('button', { name: /^mark device non-operational/i });
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/acknowledge/i));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/non-op$/),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });
});
