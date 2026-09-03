import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { VoucherReviewPage } from '../src/pages/vouchers/VoucherReviewPage';

/**
 * Issue 359 — the money-path controls on the Expense Voucher review page. Two surfaces:
 *  - the review queue shows the ticket-match warnings (`TICKET_NOT_ASSIGNED_TO_SE`,
 *    `TICKET_PLANT_MISMATCH`) as flags on the row, never as a block on reviewing it;
 *  - Mark PAID reports its batch back — the backend pays per row rather than all-or-nothing, so a
 *    partial result must be readable: which ids were paid, which were skipped and why (SAME_APPROVER
 *    above all), which failed.
 *
 * The Issue 38 behaviour of the page is covered by `vouchers-review.test.tsx`; this file only adds
 * what 359 introduced.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };
const oh: SessionView = { user_id: 'oh1', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };

const item = (itemId: string) => ({
  itemId,
  category: 'TRAVEL',
  amount: 100,
  merchantVendorName: null,
  expenseDatetime: null,
  photoRef: null,
  limit: 5000,
  overLimit: false,
});

const row = (voucherId: string, status: string, activityCheck: unknown) => ({
  voucherId,
  seId: 'se-1',
  seName: 'Asha',
  zoneId: 1,
  status,
  plantId: null,
  ticketId: null,
  vehicleId: null,
  totalAmount: 100,
  submittedAt: '2026-06-27T09:00:00Z',
  reviewNotes: null,
  items: [item(`i-${voucherId}`)],
  hasOverLimit: false,
  activityCheck,
});

const reviewRows = [
  row('v-1', 'ZONAL_MANAGER_REVIEW', {
    linkedTicketId: 't-1',
    linkedPlantId: 7,
    ticketFound: true,
    ticketAssignedSeId: 'se-other',
    ticketPlantId: 9,
    warning: 'TICKET_NOT_ASSIGNED_TO_SE',
    warnings: ['TICKET_NOT_ASSIGNED_TO_SE', 'TICKET_PLANT_MISMATCH'],
  }),
  row('v-2', 'ZONAL_MANAGER_REVIEW', {
    linkedTicketId: 't-2',
    linkedPlantId: null,
    ticketFound: true,
    ticketAssignedSeId: 'se-1',
    ticketPlantId: 9,
    warning: null,
    warnings: [],
  }),
];

const approvedRows = [
  row('v-paid', 'APPROVED', { linkedTicketId: null, linkedPlantId: null, ticketFound: false, ticketAssignedSeId: null, ticketPlantId: null, warning: 'NO_ACTIVITY_LINK', warnings: ['NO_ACTIVITY_LINK'] }),
  row('v-same', 'APPROVED', { linkedTicketId: null, linkedPlantId: null, ticketFound: false, ticketAssignedSeId: null, ticketPlantId: null, warning: 'NO_ACTIVITY_LINK', warnings: ['NO_ACTIVITY_LINK'] }),
  row('v-bad', 'APPROVED', { linkedTicketId: null, linkedPlantId: null, ticketFound: false, ticketAssignedSeId: null, ticketPlantId: null, warning: 'NO_ACTIVITY_LINK', warnings: ['NO_ACTIVITY_LINK'] }),
];

const markPaidOutcome = {
  result: 'OK',
  paid: ['v-paid'],
  skipped: [{ voucherId: 'v-same', status: 'APPROVED', reason: 'SAME_APPROVER' }],
  failed: [{ voucherId: 'v-bad', reason: 'P2023: invalid input syntax for type uuid' }],
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    if (/\/vouchers\?status=APPROVED/.test(u)) return json(approvedRows);
    if (/\/vouchers\?status=ZONAL_MANAGER_REVIEW/.test(u)) return json(reviewRows);
    if (/\/vouchers\/mark-paid$/.test(u)) return json(markPaidOutcome);
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Expense Voucher controls (Issue 359)', () => {
  it('flags every ticket-match warning on the row without blocking review', async () => {
    renderPage(zm);
    await screen.findByRole('table', { name: /expense vouchers/i });

    const cell = screen.getByTestId('voucher-activity-v-1');
    expect(within(cell).getByTestId('voucher-activity-warning-v-1-TICKET_NOT_ASSIGNED_TO_SE')).toHaveTextContent(
      /not this se/i,
    );
    expect(within(cell).getByTestId('voucher-activity-warning-v-1-TICKET_PLANT_MISMATCH')).toHaveTextContent(
      /plant mismatch/i,
    );
    // the warning is a cue, not a gate — the row is still reviewable
    expect(within(screen.getByTestId('voucher-row-v-1')).getByRole('button', { name: /^approve$/i })).toBeEnabled();
  });

  it('shows no warning on a row whose ticket matches', async () => {
    renderPage(zm);
    await screen.findByRole('table', { name: /expense vouchers/i });
    expect(screen.getByTestId('voucher-activity-v-2')).not.toHaveTextContent(/⚠/);
  });

  it('reports the mark-PAID batch: paid count, the SAME_APPROVER skip, and the failed id', async () => {
    const user = userEvent.setup();
    renderPage(oh);
    await screen.findByRole('table', { name: /expense vouchers/i });
    await user.click(screen.getByRole('button', { name: /approved/i }));
    await screen.findByTestId('voucher-row-v-paid');

    for (const id of ['v-paid', 'v-same', 'v-bad']) {
      await user.click(within(screen.getByTestId(`voucher-row-${id}`)).getByRole('checkbox'));
    }
    await user.click(screen.getByRole('button', { name: /mark paid/i }));

    const outcome = await screen.findByTestId('voucher-markpaid-outcome');
    expect(outcome).toHaveTextContent(/marked paid: 1 of 3/i);
    expect(within(outcome).getByTestId('voucher-markpaid-skipped-v-same')).toHaveTextContent(
      /you approved this voucher/i,
    );
    expect(within(outcome).getByTestId('voucher-markpaid-failed-v-bad')).toHaveTextContent(/invalid input syntax/i);
  });

  it('keeps the skipped and failed vouchers selected so they can be acted on, and drops the paid one', async () => {
    const user = userEvent.setup();
    renderPage(oh);
    await screen.findByRole('table', { name: /expense vouchers/i });
    await user.click(screen.getByRole('button', { name: /approved/i }));
    await screen.findByTestId('voucher-row-v-paid');

    for (const id of ['v-paid', 'v-same', 'v-bad']) {
      await user.click(within(screen.getByTestId(`voucher-row-${id}`)).getByRole('checkbox'));
    }
    await user.click(screen.getByRole('button', { name: /mark paid/i }));
    await screen.findByTestId('voucher-markpaid-outcome');

    expect(within(screen.getByTestId('voucher-row-v-paid')).getByRole('checkbox')).not.toBeChecked();
    expect(within(screen.getByTestId('voucher-row-v-same')).getByRole('checkbox')).toBeChecked();
    expect(within(screen.getByTestId('voucher-row-v-bad')).getByRole('checkbox')).toBeChecked();
  });
});
