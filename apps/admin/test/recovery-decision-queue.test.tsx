import type { SessionView } from '@fsm/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { RecoveryDecisionQueuePage } from '../src/pages/readiness/RecoveryDecisionQueuePage';

/**
 * Issue 37 slice 4 — the ZM Recovery decision queue (`/readiness/recovery-decisions`). Manager roles
 * see unable-to-collect recovery tickets and choose Reschedule / Close FAILED_RECOVERY (reason) /
 * Escalate to Operations Head.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

const rows = [
  { ticketId: 't-aaaa1111', status: 'ON_SITE', deviceId: '900001', assignedSeId: 'se-1', collectedDeviceSerial: null, collectionConditionNotes: null, unableToCollectReason: 'COMPANY_REFUSED', closureType: null, closedAt: null },
];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

function renderPage() {
  return render(
    <AuthProvider initialSession={zm}>
      <MemoryRouter initialEntries={['/readiness/recovery-decisions']}>
        <Routes>
          <Route path="/readiness/recovery-decisions" element={<RecoveryDecisionQueuePage />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => {
  sessionStorage.setItem('fsm.accessToken', 'tok');
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/recovery/zm-queue')) return json(rows);
    if (u.includes('/recovery/t-aaaa1111/escalate') && init?.method === 'POST') return json(rows[0]);
    if (u.includes('/recovery/t-aaaa1111/close-failed') && init?.method === 'POST') return json({ ...rows[0], status: 'FAILED_RECOVERY' });
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('prompt', () => 'customer scrapped vehicle');
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Recovery decision queue (Issue 37)', () => {
  it('lists unable-to-collect tickets with the reason', async () => {
    renderPage();
    const table = within(await screen.findByRole('table', { name: /recovery decision queue/i }));
    expect(table.getByTestId('rdq-row-t-aaaa1111')).toHaveTextContent(/company_refused/i);
  });

  it('escalates to Operations Head', async () => {
    renderPage();
    await screen.findByTestId('rdq-row-t-aaaa1111');
    fireEvent.click(screen.getByTestId('rdq-escalate-t-aaaa1111'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/recovery/t-aaaa1111/escalate'), expect.objectContaining({ method: 'POST' })),
    );
  });

  it('closes FAILED_RECOVERY with a reason prompt', async () => {
    renderPage();
    await screen.findByTestId('rdq-row-t-aaaa1111');
    fireEvent.click(screen.getByTestId('rdq-close-failed-t-aaaa1111'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/recovery/t-aaaa1111/close-failed'), expect.objectContaining({ method: 'POST' })),
    );
  });
});
