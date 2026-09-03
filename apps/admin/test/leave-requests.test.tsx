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
 *
 * #363 adds the two states the page could not show: an approval that has been **revoked** (the SE is
 * back on the board) and a submit refused because the SE already holds those days.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };
const ops: SessionView = { user_id: 'ops1', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };

const rows = [
  { id: '7', seId: 'se-1', seName: 'Karan Singh', type: 'ON_LEAVE', status: 'PENDING', windowStart: '2026-07-10T00:00:00Z', windowEnd: '2026-07-12T00:00:00Z', reason: 'family', decisionReason: null, createdAt: '2026-06-24T06:00:00Z' },
  { id: '8', seId: 'se-2', seName: 'Amit Yadav', type: 'ON_LEAVE', status: 'APPROVED', windowStart: '2026-07-14T00:00:00Z', windowEnd: '2026-07-16T00:00:00Z', reason: 'wedding', decisionReason: null, createdAt: '2026-06-24T06:00:00Z' },
  { id: '9', seId: 'se-3', seName: 'Deepak Verma', type: 'WEEKLY_OFF', status: 'REVOKED', windowStart: '2026-07-18T00:00:00Z', windowEnd: '2026-07-19T00:00:00Z', reason: null, decisionReason: 'cover needed', createdAt: '2026-06-24T06:00:00Z' },
];

const engineers = [
  { seId: 'se-1', name: 'Karan Singh' },
  { seId: 'se-2', name: 'Amit Yadav' },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();
/** What `POST /leave-requests` answers — overridden by the overlap case. */
let submitResponse: () => Response;

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

const posted = (pattern: RegExp) =>
  fetchMock.mock.calls.find(([u, init]) => pattern.test(String(u)) && (init as RequestInit)?.method === 'POST');

beforeEach(() => {
  submitResponse = () => json({ result: 'OK', id: '99' });
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (/\/leave-requests\/\d+\/(approve|reject|revoke)$/.test(u) && init?.method === 'POST') return json({ result: 'OK' });
    if (/\/leave-requests$/.test(u) && init?.method === 'POST') return submitResponse();
    if (/\/leave-requests$/.test(u)) return json(rows);
    if (/\/engineers$/.test(u)) return json(engineers);
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
    expect(table.getAllByText('ON_LEAVE').length).toBeGreaterThan(0);
    expect(table.getByText('PENDING')).toBeInTheDocument();
  });

  it('approves a request', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /leave requests/i });
    await user.click(within(screen.getByTestId('lr-row-7')).getByRole('button', { name: /approve/i }));
    expect(posted(/\/leave-requests\/7\/approve$/)).toBeTruthy();
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
    expect(posted(/\/leave-requests\/7\/reject$/)).toBeTruthy();
  });

  it('hides decision actions from Operations Head (read-only)', async () => {
    renderPage(ops);
    await screen.findByRole('table', { name: /leave requests/i });
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^revoke$/i })).not.toBeInTheDocument();
  });

  /**
   * #363 AC2 — the Revoke control. Approving the wrong request used to be unrecoverable from this
   * page: the row was terminal and the SE stayed off the board for the whole window. The reason is
   * mandatory for the same reason a rejection's is, and it is asserted here rather than trusted to the
   * server, because a manager who is told "reason required" only after the round-trip has already lost
   * the click.
   */
  it('#363 — revokes an approved request, with a mandatory reason', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /leave requests/i });

    await user.click(within(screen.getByTestId('lr-row-8')).getByRole('button', { name: /^revoke$/i }));
    await user.click(screen.getByRole('button', { name: /confirm revoke/i }));
    expect(fetchMock.mock.calls.some(([u]) => /\/revoke$/.test(String(u)))).toBe(false);

    await user.type(await screen.findByLabelText(/revoke reason/i), 'wedding postponed');
    await user.click(screen.getByRole('button', { name: /confirm revoke/i }));

    const call = posted(/\/leave-requests\/8\/revoke$/);
    expect(call).toBeTruthy();
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ reason: 'wedding postponed' });
  });

  it('#363 — a revoked request reads as REVOKED and offers no further decision', async () => {
    renderPage();
    await screen.findByRole('table', { name: /leave requests/i });
    const row = within(screen.getByTestId('lr-row-9'));
    expect(row.getByText('REVOKED')).toBeInTheDocument();
    expect(row.getByText(/cover needed/)).toBeInTheDocument();
    expect(row.queryByRole('button', { name: /^revoke$/i })).not.toBeInTheDocument();
    expect(row.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });

  /**
   * #363 AC3 — the overlap error state. The ZM files on behalf of an SE who phoned in (the endpoint has
   * always accepted it; no admin surface reached it), so this is where a 409 `OVERLAP` lands: the SE
   * already holds one of those days and the page has to say so rather than fail silently.
   */
  it('#363 — an overlapping submit surfaces the 409 rather than failing silently', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /leave requests/i });

    submitResponse = () => json({ code: 'OVERLAP', conflictId: '7' }, 409);
    await user.selectOptions(await screen.findByLabelText(/^engineer$/i), 'se-1');
    await user.type(screen.getByLabelText(/^from$/i), '2026-07-11');
    await user.type(screen.getByLabelText(/^to$/i), '2026-07-13');
    await user.click(screen.getByRole('button', { name: /file leave/i }));

    expect(posted(/\/leave-requests$/)).toBeTruthy();
    expect(await screen.findByRole('alert')).toHaveTextContent(/already has leave/i);
  });

  it('#363 — a clean submit reloads the list and clears the form', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /leave requests/i });

    await user.selectOptions(await screen.findByLabelText(/^engineer$/i), 'se-2');
    await user.type(screen.getByLabelText(/^from$/i), '2026-08-03');
    await user.type(screen.getByLabelText(/^to$/i), '2026-08-04');
    await user.click(screen.getByRole('button', { name: /file leave/i }));

    const call = posted(/\/leave-requests$/);
    expect(JSON.parse(String((call![1] as RequestInit).body))).toMatchObject({
      seId: 'se-2',
      type: 'ON_LEAVE',
      windowStart: '2026-08-03',
      windowEnd: '2026-08-04',
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(await screen.findByLabelText(/^from$/i)).toHaveValue('');
  });
});
