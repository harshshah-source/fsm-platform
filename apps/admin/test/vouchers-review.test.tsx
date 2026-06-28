import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { VoucherReviewPage } from '../src/pages/vouchers/VoucherReviewPage';

/**
 * Issue 38 — Expense Voucher review (`/vouchers`). The ZM review queue (ZONAL_MANAGER_REVIEW, sorted by
 * submitted_at) with the activity check, over-limit rows in red, photo lightbox, and Approve / Reject
 * (mandatory reason) / Needs Clarification (comment). The Operations Head additionally gets the APPROVED
 * Finance view: Export + multi-select Mark PAID.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };
const oh: SessionView = { user_id: 'oh1', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };

const reviewRows = [
  {
    voucherId: 'v-1', seId: 'se-1', seName: 'Asha', zoneId: 1, status: 'ZONAL_MANAGER_REVIEW',
    plantId: null, ticketId: 't-1', vehicleId: null, totalAmount: 900, submittedAt: '2026-06-27T09:00:00Z',
    reviewNotes: null,
    items: [{ itemId: '10', category: 'MEAL', amount: 900, merchantVendorName: 'Cafe', expenseDatetime: null, photoRef: 'r1.jpg', limit: 500, overLimit: true }],
    hasOverLimit: true,
    activityCheck: { linkedTicketId: 't-1', linkedPlantId: null, ticketFound: true, warning: null },
  },
  {
    voucherId: 'v-2', seId: 'se-2', seName: 'Bala', zoneId: 1, status: 'ZONAL_MANAGER_REVIEW',
    plantId: null, ticketId: null, vehicleId: null, totalAmount: 100, submittedAt: '2026-06-27T08:00:00Z',
    reviewNotes: null,
    items: [{ itemId: '11', category: 'TRAVEL', amount: 100, merchantVendorName: null, expenseDatetime: null, photoRef: null, limit: 5000, overLimit: false }],
    hasOverLimit: false,
    activityCheck: { linkedTicketId: null, linkedPlantId: null, ticketFound: false, warning: 'NO_ACTIVITY_LINK' },
  },
];

const approvedRows = [
  {
    voucherId: 'v-9', seId: 'se-1', seName: 'Asha', zoneId: 1, status: 'APPROVED',
    plantId: null, ticketId: null, vehicleId: null, totalAmount: 500, submittedAt: '2026-06-20T09:00:00Z',
    reviewNotes: null,
    items: [{ itemId: '90', category: 'PARTS', amount: 500, merchantVendorName: 'Shop', expenseDatetime: null, photoRef: 'r9.jpg', limit: 10000, overLimit: false }],
    hasOverLimit: false,
    activityCheck: { linkedTicketId: null, linkedPlantId: null, ticketFound: false, warning: 'NO_ACTIVITY_LINK' },
  },
];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const csv = (body: string) => new Response(body, { status: 200, headers: { 'Content-Type': 'text/csv' } });
const fetchMock = vi.fn();

function renderPage(session: SessionView) {
  return render(
    <AuthProvider initialSession={session}>
      <MemoryRouter initialEntries={['/vouchers']}>
        <Routes>
          <Route path="/vouchers" element={<VoucherReviewPage />} />
          <Route path="/tickets/:id" element={<div>Ticket drawer stub</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (/\/vouchers\?status=APPROVED/.test(u)) return json(approvedRows);
    if (/\/vouchers\?status=ZONAL_MANAGER_REVIEW/.test(u)) return json(reviewRows);
    if (/\/vouchers\/.+\/review$/.test(u)) return json({ status: 'APPROVED' });
    if (/\/vouchers\/mark-paid$/.test(u)) return json({ paid: ['v-9'], skipped: [] });
    if (/\/vouchers\/export\?month=/.test(u)) return csv('voucher_id\nv-9\n');
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Expense Voucher review (Issue 38)', () => {
  it('renders the ZM review queue with over-limit + activity flags', async () => {
    renderPage(zm);
    const table = within(await screen.findByRole('table', { name: /expense vouchers/i }));
    expect(table.getByText('Asha')).toBeInTheDocument();
    expect(table.getByText('Bala')).toBeInTheDocument();
    // over-limit line item is flagged
    expect(screen.getByTestId('voucher-overlimit-10')).toBeInTheDocument();
    // activity check: v-1 shows the linked ticket; v-2 warns
    expect(within(screen.getByTestId('voucher-activity-v-1')).getByText(/t-1/)).toBeInTheDocument();
    expect(screen.getByTestId('voucher-activity-v-2')).toHaveTextContent(/no activity/i);
  });

  it('approves a voucher', async () => {
    const user = userEvent.setup();
    renderPage(zm);
    await screen.findByRole('table', { name: /expense vouchers/i });
    await user.click(within(screen.getByTestId('voucher-row-v-1')).getByRole('button', { name: /^approve$/i }));
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => /\/vouchers\/v-1\/review$/.test(String(url)) && (init as RequestInit)?.method === 'POST',
      ),
    ).toBe(true);
  });

  it('requires a reason before rejecting', async () => {
    const user = userEvent.setup();
    renderPage(zm);
    await screen.findByRole('table', { name: /expense vouchers/i });
    await user.click(within(screen.getByTestId('voucher-row-v-1')).getByRole('button', { name: /reject/i }));
    const reason = await screen.findByLabelText(/rejection reason/i);
    await user.click(screen.getByRole('button', { name: /confirm reject/i }));
    expect(fetchMock.mock.calls.some(([url]) => /\/review$/.test(String(url)))).toBe(false);
    await user.type(reason, 'Duplicate claim');
    await user.click(screen.getByRole('button', { name: /confirm reject/i }));
    expect(
      fetchMock.mock.calls.some(([url, init]) => /\/v-1\/review$/.test(String(url)) && (init as RequestInit)?.method === 'POST'),
    ).toBe(true);
  });

  it('opens a photo lightbox', async () => {
    const user = userEvent.setup();
    renderPage(zm);
    await screen.findByRole('table', { name: /expense vouchers/i });
    await user.click(within(screen.getByTestId('voucher-row-v-1')).getByRole('button', { name: /view photo/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('img')).toHaveAttribute('src', 'r1.jpg');
  });

  it('OH exports Finance and marks vouchers PAID from the Approved view', async () => {
    const user = userEvent.setup();
    renderPage(oh);
    await screen.findByRole('table', { name: /expense vouchers/i });
    // switch to the Approved (Finance) view
    await user.click(screen.getByRole('button', { name: /approved/i }));
    await within(await screen.findByRole('table', { name: /expense vouchers/i })).findByText(/PARTS/);

    // Export Finance triggers the export fetch
    await user.click(screen.getByRole('button', { name: /export finance/i }));
    expect(fetchMock.mock.calls.some(([url]) => /\/vouchers\/export\?month=/.test(String(url)))).toBe(true);

    // select the approved voucher and mark paid
    await user.click(within(screen.getByTestId('voucher-row-v-9')).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /mark paid/i }));
    expect(
      fetchMock.mock.calls.some(([url, init]) => /\/vouchers\/mark-paid$/.test(String(url)) && (init as RequestInit)?.method === 'POST'),
    ).toBe(true);
  });
});
