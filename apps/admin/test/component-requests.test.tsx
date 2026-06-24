import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { ComponentRequestsPage } from '../src/pages/inventory/ComponentRequestsPage';

/**
 * Issue 22 — the Warehouse Manager Component Requests queue (`/warehouse/requests`,
 * v2-reference/18-component-requests). A metric strip of lifecycle counts, a table of active requests
 * (company / component / requested-by / ticket / status / age), and per-row WM actions: Approve, Mark
 * Shipped (tracking + destination), Reject (mandatory reason). WAREHOUSE_MANAGER only.
 */
const wm: SessionView = { user_id: 'wm1', role: 'WAREHOUSE_MANAGER', zone_id: null, acted_as_role: null };

const rows = [
  {
    requestId: 'req-1', ticketId: 't-1', seId: 'se-1', componentId: '9', componentName: 'GPS Antenna',
    companyName: 'Acme', zoneName: 'NORTH', status: 'REQUESTED', deliveryDestination: null,
    trackingRef: null, rejectionReason: null, createdAt: '2026-06-24T06:00:00Z', ageDays: 1,
  },
  {
    requestId: 'req-2', ticketId: 't-2', seId: 'se-2', componentId: '7', componentName: 'SIM',
    companyName: 'Beta', zoneName: 'NORTH', status: 'APPROVED', deliveryDestination: null,
    trackingRef: null, rejectionReason: null, createdAt: '2026-06-24T05:00:00Z', ageDays: 2,
  },
];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

function renderPage() {
  return render(
    <AuthProvider initialSession={wm}>
      <MemoryRouter initialEntries={['/warehouse/requests']}>
        <Routes>
          <Route path="/warehouse/requests" element={<ComponentRequestsPage />} />
          <Route path="/tickets/:id" element={<div>Ticket drawer stub</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/warehouse/requests') && (!init || init.method === undefined || init.method === 'GET')) return json(rows);
    if (/\/warehouse\/requests\/.+\/(approve|ship|reject)$/.test(u)) return json({ request: { ...rows[0], status: 'APPROVED' } });
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Component Requests queue (Issue 22)', () => {
  it('renders the metric strip and a row per active request', async () => {
    renderPage();
    const table = within(await screen.findByRole('table', { name: /component requests/i }));
    expect(table.getByText('GPS Antenna')).toBeInTheDocument();
    expect(table.getByText('SIM')).toBeInTheDocument();
    // Metric strip reflects the lifecycle counts (1 REQUESTED, 1 APPROVED).
    const strip = within(screen.getByTestId('cr-metric-strip'));
    expect(strip.getByTestId('cr-metric-REQUESTED')).toHaveTextContent('1');
    expect(strip.getByTestId('cr-metric-APPROVED')).toHaveTextContent('1');
  });

  it('approves a REQUESTED request via the WM action', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /component requests/i });
    await user.click(within(screen.getByTestId('cr-row-req-1')).getByRole('button', { name: /approve/i }));
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => /\/warehouse\/requests\/req-1\/approve$/.test(String(url)) && (init as RequestInit)?.method === 'POST',
      ),
    ).toBe(true);
  });

  it('requires a reason before rejecting', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /component requests/i });
    await user.click(within(screen.getByTestId('cr-row-req-1')).getByRole('button', { name: /reject/i }));
    // A reason field appears; confirming without a reason does not POST.
    const reason = await screen.findByLabelText(/rejection reason/i);
    await user.click(screen.getByRole('button', { name: /confirm reject/i }));
    expect(fetchMock.mock.calls.some(([url]) => /\/reject$/.test(String(url)))).toBe(false);
    // With a reason, it POSTs.
    await user.type(reason, 'Out of stock');
    await user.click(screen.getByRole('button', { name: /confirm reject/i }));
    expect(fetchMock.mock.calls.some(([url, init]) => /\/reject$/.test(String(url)) && (init as RequestInit)?.method === 'POST')).toBe(true);
  });
});
