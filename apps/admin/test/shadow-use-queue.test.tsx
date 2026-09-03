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
 * ticket, and qty; per-row Mark Reconciled / Mark Disputed (mandatory reason).
 *
 * #353 adds the other half of the same decision: the Disputes section, which is where the Zonal
 * Manager a dispute is *escalated to* finally reads it. Both roles render from this one page, so the
 * table selectors below name their table — `/shadow use/i` now matches two.
 */
const wm: SessionView = { user_id: 'wm1', role: 'WAREHOUSE_MANAGER', zone_id: null, acted_as_role: null };
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

const rows = [
  { id: '11', ticketId: 't price', seId: 'se-1', componentId: '9', componentName: 'GPS Antenna', qty: 2, companyName: 'Acme', zoneName: 'NORTH', status: 'SHADOW_USE', reason: null, escalatedTo: null, escalatedBy: null, escalatedAt: null, createdAt: '2026-06-24T06:00:00Z', ageDays: 1 },
];

const disputes = [
  { id: '21', ticketId: 'tkt-dispute-1', seId: 'se-2', componentId: '9', componentName: 'SIM Module 4G', qty: 3, companyName: 'Nathdwara Works', zoneName: 'NORTH', status: 'DISPUTED', reason: 'winner reported this part', escalatedTo: 'ZONAL_MANAGER', escalatedBy: 'wm1', escalatedAt: '2026-06-25T06:00:00Z', createdAt: '2026-06-24T06:00:00Z', ageDays: 2 },
];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

function renderPage(session: SessionView = wm) {
  return render(
    <AuthProvider initialSession={session}>
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
    if (/\/warehouse\/shadow-use\?status=DISPUTED$/.test(u)) return json(disputes);
    if (/\/warehouse\/shadow-use(\?status=[A-Z_]+)?$/.test(u)) return json(rows);
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
    const table = within(await screen.findByRole('table', { name: /shadow use queue/i }));
    expect(table.getByText('GPS Antenna')).toBeInTheDocument();
    expect(within(screen.getByTestId('su-metric-UNRECONCILED')).getByText('1')).toBeInTheDocument();
  });

  it('reconciles a row', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /shadow use queue/i });
    await user.click(within(screen.getByTestId('su-row-11')).getByRole('button', { name: /reconcile/i }));
    expect(fetchMock.mock.calls.some(([u, init]) => /\/warehouse\/shadow-use\/11\/reconcile$/.test(String(u)) && (init as RequestInit)?.method === 'POST')).toBe(true);
  });

  /**
   * #353 AC3 — the Zonal Manager is who a dispute is escalated to, and had nowhere to read one. The
   * Disputes section is that surface: reason, who escalated it and when, and the quantity the
   * dispute put back in the engineer's van. Read-only — reconciling is the Warehouse Manager's call
   * (reference 19 draws the actions on the WM's queue, and the server 403s a ZM either way).
   */
  it('shows a ZM the disputes escalated to them, with reason and escalation metadata', async () => {
    renderPage(zm);
    const table = within(await screen.findByRole('table', { name: /shadow use disputes/i }));
    expect(table.getByText('SIM Module 4G')).toBeInTheDocument();
    expect(table.getByText(/winner reported this part/i)).toBeInTheDocument();
    expect(within(screen.getByTestId('su-metric-DISPUTED')).getByText('1')).toBeInTheDocument();

    // the unreconciled queue is the WM's work, and its actions are refused for a ZM server-side
    expect(screen.queryByRole('table', { name: /^shadow use queue$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reconcile/i })).not.toBeInTheDocument();

    expect(fetchMock.mock.calls.some(([u]) => /\/warehouse\/shadow-use\?status=DISPUTED$/.test(String(u)))).toBe(true);
  });

  it('shows the WM both the queue and the disputes it escalated', async () => {
    renderPage();
    await screen.findByRole('table', { name: /shadow use queue/i });
    const disputes = within(await screen.findByRole('table', { name: /shadow use disputes/i }));
    expect(disputes.getByText('SIM Module 4G')).toBeInTheDocument();
    expect(within(screen.getByTestId('su-metric-DISPUTED')).getByText('1')).toBeInTheDocument();
  });

  it('requires a reason before disputing', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /shadow use queue/i });
    await user.click(within(screen.getByTestId('su-row-11')).getByRole('button', { name: /dispute/i }));
    const reason = await screen.findByLabelText(/dispute reason/i);
    await user.click(screen.getByRole('button', { name: /confirm dispute/i }));
    expect(fetchMock.mock.calls.some(([u]) => /\/dispute$/.test(String(u)))).toBe(false);
    await user.type(reason, 'mismatch with winner');
    await user.click(screen.getByRole('button', { name: /confirm dispute/i }));
    expect(fetchMock.mock.calls.some(([u, init]) => /\/dispute$/.test(String(u)) && (init as RequestInit)?.method === 'POST')).toBe(true);
  });
});
