import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { ComponentBlockedPage } from '../src/pages/inventory/ComponentBlockedPage';

/**
 * Issue 21 — the ZM Component-Blocked Queue page (`/component-blocked`). Read-only table of tickets the
 * Recommender dropped for an incomplete Common Kit: missing parts, WM action status, and a "Warehouse
 * Overdue" badge past 7 days. A row click deep-links to the ticket Components tab.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

const rows = [
  {
    id: '1', ticketId: 't-fresh', seId: 'se-1', companyName: 'Acme', zoneName: 'NORTH',
    reason: 'COMMON_KIT_INCOMPLETE', missingComponents: [{ componentId: '9', name: 'SIM', shortBy: 2 }],
    wmActionStatus: 'PENDING', blockedAt: '2026-06-24T06:00:00Z', ageDays: 1, warehouseOverdue: false,
  },
  {
    id: '2', ticketId: 't-overdue', seId: 'se-2', companyName: 'Beta', zoneName: 'NORTH',
    reason: 'COMMON_KIT_INCOMPLETE', missingComponents: [{ componentId: '7', name: 'Cable', shortBy: 1 }],
    wmActionStatus: 'PENDING', blockedAt: '2026-06-10T06:00:00Z', ageDays: 14, warehouseOverdue: true,
  },
];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

function renderPage() {
  return render(
    <AuthProvider initialSession={zm}>
      <MemoryRouter initialEntries={['/component-blocked']}>
        <Routes>
          <Route path="/component-blocked" element={<ComponentBlockedPage />} />
          <Route path="/tickets/:id" element={<div>Ticket drawer stub</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockImplementation(async (url: string) => (String(url).includes('/component-blocked') ? json(rows) : json([])));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Component-Blocked Queue page (Issue 21)', () => {
  it('lists blocked tickets with missing parts and a Warehouse Overdue badge past 7 days', async () => {
    renderPage();
    const table = within(await screen.findByRole('table', { name: /component-blocked queue/i }));
    expect(table.getByText(/SIM \(×2\)/)).toBeInTheDocument();
    // The overdue row shows the badge; the fresh row shows the plain WM status.
    expect(within(screen.getByTestId('cbq-row-t-overdue')).getByText(/warehouse overdue/i)).toBeInTheDocument();
    expect(within(screen.getByTestId('cbq-row-t-fresh')).queryByText(/warehouse overdue/i)).toBeNull();
  });

  it('deep-links a row to the ticket Components tab', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /component-blocked queue/i });
    await user.click(within(screen.getByTestId('cbq-row-t-fresh')).getByText('Acme'));
    expect(await screen.findByText(/ticket drawer stub/i)).toBeInTheDocument();
  });
});
