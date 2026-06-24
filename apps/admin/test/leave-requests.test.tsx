import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { LeaveRequestsPage } from '../src/pages/engineers/LeaveRequestsPage';

/**
 * Issue 26 — ZM Leave Requests approvals (`/leave-requests`). The own-zone PENDING + recent leave
 * requests with Approve / Reject (mandatory reason); approving writes the SE's availability window.
 * Manager roles read; ZM / CSM decide; Operations Head is read-only.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };
const ops: SessionView = { user_id: 'ops1', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };

const rows = [
  { id: '7', seId: 'se-1', seName: 'Karan Singh', type: 'ON_LEAVE', status: 'PENDING', windowStart: '2026-07-10T00:00:00Z', windowEnd: '2026-07-12T00:00:00Z', reason: 'family', decisionReason: null, createdAt: '2026-06-24T06:00:00Z' },
];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

function renderPage(session: SessionView = zm) {
  return render(
    <AuthProvider initialSession={session}>
      <MemoryRouter initialEntries={['/leave-requests']}>
        <Routes>
          <Route path="/leave-requests" element={<LeaveRequestsPage />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (/\/leave-requests\/7\/(approve|reject)$/.test(u) && init?.method === 'POST') return json({ result: 'OK', id: '7' });
    if (/\/leave-requests$/.test(u)) return json(rows);
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Leave Requests page (Issue 26)', () => {
  it('lists pending leave requests with SE, type, and status', async () => {
    renderPage();
    const table = within(await screen.findByRole('table', { name: /leave requests/i }));
    expect(table.getByText('Karan Singh')).toBeInTheDocument();
    expect(table.getByText('ON_LEAVE')).toBeInTheDocument();
    expect(table.getByText('PENDING')).toBeInTheDocument();
  });

  it('approves a request', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /leave requests/i });
    await user.click(within(screen.getByTestId('lr-row-7')).getByRole('button', { name: /approve/i }));
    expect(
      fetchMock.mock.calls.some(([u, init]) => /\/leave-requests\/7\/approve$/.test(String(u)) && (init as RequestInit)?.method === 'POST'),
    ).toBe(true);
  });

  it('requires a reason before rejecting', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /leave requests/i });
    await user.click(within(screen.getByTestId('lr-row-7')).getByRole('button', { name: /reject/i }));
    await user.click(screen.getByRole('button', { name: /confirm reject/i }));
    expect(fetchMock.mock.calls.some(([u]) => /\/reject$/.test(String(u)))).toBe(false);
    await user.type(await screen.findByLabelText(/reject reason/i), 'coverage gap');
    await user.click(screen.getByRole('button', { name: /confirm reject/i }));
    expect(fetchMock.mock.calls.some(([u, init]) => /\/reject$/.test(String(u)) && (init as RequestInit)?.method === 'POST')).toBe(true);
  });

  it('hides decision actions from Operations Head (read-only)', async () => {
    renderPage(ops);
    await screen.findByRole('table', { name: /leave requests/i });
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });
});
