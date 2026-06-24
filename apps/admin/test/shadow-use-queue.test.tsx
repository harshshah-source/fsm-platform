import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { ShadowUseQueuePage } from '../src/pages/inventory/ShadowUseQueuePage';

/**
 * Issue 24 — the Warehouse Manager Shadow Use Queue (`/warehouse/shadow-use`,
 * v2-reference/19-shadow-use-queue). Unreconciled SHADOW_USE rows with the consumed component, SE,
 * ticket, and qty; per-row Mark Reconciled / Mark Disputed (mandatory reason). WAREHOUSE_MANAGER only.
 */
const wm: SessionView = { user_id: 'wm1', role: 'WAREHOUSE_MANAGER', zone_id: null, acted_as_role: null };

const rows = [
  { id: '11', ticketId: 't price', seId: 'se-1', componentId: '9', componentName: 'GPS Antenna', qty: 2, companyName: 'Acme', zoneName: 'NORTH', status: 'SHADOW_USE', reason: null, createdAt: '2026-06-24T06:00:00Z', ageDays: 1 },
];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

function renderPage() {
  return render(
    <AuthProvider initialSession={wm}>
      <MemoryRouter initialEntries={['/warehouse/shadow-use']}>
        <Routes>
          <Route path="/warehouse/shadow-use" element={<ShadowUseQueuePage />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.endsWith('/warehouse/shadow-use')) return json(rows);
    if (/\/warehouse\/shadow-use\/.+\/(reconcile|dispute)$/.test(u)) return json({ ok: true });
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Shadow Use Queue page (Issue 24)', () => {
  it('lists unreconciled shadow-use rows with component + qty', async () => {
    renderPage();
    const table = within(await screen.findByRole('table', { name: /shadow use/i }));
    expect(table.getByText('GPS Antenna')).toBeInTheDocument();
    expect(within(screen.getByTestId('su-metric-UNRECONCILED')).getByText('1')).toBeInTheDocument();
  });

  it('reconciles a row', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /shadow use/i });
    await user.click(within(screen.getByTestId('su-row-11')).getByRole('button', { name: /reconcile/i }));
    expect(fetchMock.mock.calls.some(([u, init]) => /\/warehouse\/shadow-use\/11\/reconcile$/.test(String(u)) && (init as RequestInit)?.method === 'POST')).toBe(true);
  });

  it('requires a reason before disputing', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /shadow use/i });
    await user.click(within(screen.getByTestId('su-row-11')).getByRole('button', { name: /dispute/i }));
    const reason = await screen.findByLabelText(/dispute reason/i);
    await user.click(screen.getByRole('button', { name: /confirm dispute/i }));
    expect(fetchMock.mock.calls.some(([u]) => /\/dispute$/.test(String(u)))).toBe(false);
    await user.type(reason, 'mismatch with winner');
    await user.click(screen.getByRole('button', { name: /confirm dispute/i }));
    expect(fetchMock.mock.calls.some(([u, init]) => /\/dispute$/.test(String(u)) && (init as RequestInit)?.method === 'POST')).toBe(true);
  });
});
