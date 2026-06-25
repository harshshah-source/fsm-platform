import type { SessionView } from '@fsm/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { RecoveryReceiptQueuePage } from '../src/pages/warehouse/RecoveryReceiptQueuePage';

/**
 * Issue 36 slice 4 — the Warehouse Manager's Recovery "Awaiting Receipt" queue
 * (`/warehouse/recovery-receipt`). Lists COLLECTED recovery tickets with the confirmed device serial +
 * condition notes; the WM confirms physical receipt, which auto-closes the ticket.
 */
const wm: SessionView = { user_id: 'wm1', role: 'WAREHOUSE_MANAGER', zone_id: null, acted_as_role: null };

const rows = [
  { ticketId: 't-aaaa1111', status: 'COLLECTED', deviceId: '900001', assignedSeId: 'se-1', collectedDeviceSerial: '900001', collectionConditionNotes: 'minor scratches', unableToCollectReason: null, closureType: null, closedAt: null },
];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

function renderPage() {
  return render(
    <AuthProvider initialSession={wm}>
      <MemoryRouter initialEntries={['/warehouse/recovery-receipt']}>
        <Routes>
          <Route path="/warehouse/recovery-receipt" element={<RecoveryReceiptQueuePage />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => {
  sessionStorage.setItem('fsm.accessToken', 'tok');
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/recovery/awaiting-receipt')) return json(rows);
    if (u.includes('/recovery/t-aaaa1111/receipt') && init?.method === 'POST') return json({ ...rows[0], status: 'CLOSED', closureType: 'AUTO_CLOSED_ON_WAREHOUSE_RECEIPT' });
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Recovery Receipt queue (Issue 36)', () => {
  it('lists COLLECTED recovery tickets with serial + condition notes', async () => {
    renderPage();
    const table = within(await screen.findByRole('table', { name: /awaiting warehouse receipt/i }));
    const row = table.getByTestId('rcv-row-t-aaaa1111');
    expect(row).toHaveTextContent('900001');
    expect(row).toHaveTextContent(/minor scratches/i);
  });

  it('confirms receipt via the Confirm Receipt action', async () => {
    renderPage();
    await screen.findByTestId('rcv-row-t-aaaa1111');
    fireEvent.click(screen.getByTestId('rcv-receipt-t-aaaa1111'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/recovery/t-aaaa1111/receipt'),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });
});
