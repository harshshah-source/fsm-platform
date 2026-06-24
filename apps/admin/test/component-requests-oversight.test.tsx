import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { ComponentRequestsPage } from '../src/pages/inventory/ComponentRequestsPage';

/**
 * Issue 23 — the manager read-only oversight of Component Requests. A ZM (own zone) / CSM / Operations
 * Head sees the same rows as the Warehouse Manager but WITHOUT any approve/ship/reject actions
 * (CONTEXT §Component Request: ZM visibility is read-only). The page reads `/component-requests` in
 * read-only mode.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

const rows = [
  {
    requestId: 'req-1', ticketId: 't-1', seId: 'se-1', componentId: '9', componentName: 'GPS Antenna',
    companyName: 'Acme', zoneName: 'NORTH', status: 'REQUESTED', deliveryDestination: null,
    trackingRef: null, rejectionReason: null, createdAt: '2026-06-24T06:00:00Z', ageDays: 1,
  },
];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockImplementation(async (url: string) => (String(url).endsWith('/component-requests') ? json(rows) : json([])));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Component Requests oversight (read-only, Issue 23)', () => {
  it('lists requests from the oversight endpoint with no WM actions', async () => {
    render(
      <AuthProvider initialSession={zm}>
        <MemoryRouter initialEntries={['/component-requests']}>
          <Routes>
            <Route path="/component-requests" element={<ComponentRequestsPage readOnly />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    );
    const table = within(await screen.findByRole('table', { name: /component requests/i }));
    expect(table.getByText('GPS Antenna')).toBeInTheDocument();
    // Read-only: no approve / reject / ship controls.
    expect(within(screen.getByTestId('cr-row-req-1')).queryByRole('button', { name: /approve/i })).toBeNull();
    expect(within(screen.getByTestId('cr-row-req-1')).queryByRole('button', { name: /reject/i })).toBeNull();
    // It read the oversight endpoint, not the warehouse mutation queue.
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/component-requests'))).toBe(true);
  });
});
