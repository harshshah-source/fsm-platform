import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import type { MeVoucherRow, MeVouchersView } from '@fsm/shared';
import { VouchersScreen } from './VouchersScreen';
import { apiGetMyVouchers } from '../../api/client';
import { getAccessToken } from '../../auth/tokenStore';

jest.mock('../../api/client', () => {
  const actual = jest.requireActual('../../api/client') as object;
  return { ...actual, apiGetMyVouchers: jest.fn() };
});
jest.mock('../../auth/tokenStore', () => ({ getAccessToken: jest.fn() }));

const mockGetMyVouchers = jest.mocked(apiGetMyVouchers);
const mockGetAccessToken = jest.mocked(getAccessToken);

function row(overrides: Partial<MeVoucherRow>): MeVoucherRow {
  return {
    voucherId: 'v-1',
    status: 'ZONAL_MANAGER_REVIEW',
    plantId: null,
    plantName: null,
    ticketId: null,
    vehicleId: null,
    totalAmount: 250,
    submittedAt: '2026-05-11T00:00:00Z',
    reviewNotes: null,
    reviewerName: null,
    createdAt: '2026-05-11T00:00:00Z',
    items: [{ itemId: 'i-1', category: 'TRAVEL', amount: 250, merchantVendorName: null, expenseDatetime: null, photoRef: 'media-1', limit: 500, overLimit: false }],
    ...overrides,
  };
}

function view(overrides: Partial<MeVouchersView>): MeVouchersView {
  return {
    items: [row({})],
    cursor: null,
    summary: { claimedTotal: 250, pendingCount: 1, approvedCount: 0 },
    ...overrides,
  };
}

describe('VouchersScreen', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders the summary tiles and voucher rows with status', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetMyVouchers.mockResolvedValue(view({}));

    render(<VouchersScreen />);

    await waitFor(() => expect(screen.getByTestId('voucher-row-v-1')).toBeTruthy());
    expect(screen.getByText('Manager Review')).toBeTruthy();
    expect(screen.getByText('Travel')).toBeTruthy();
    expect(screen.getByTestId('voucher-summary-claimed')).toBeTruthy();
  });

  it('renders all 7 statuses distinctly', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    const statuses = ['DRAFT', 'SUBMITTED', 'ZONAL_MANAGER_REVIEW', 'APPROVED', 'REJECTED', 'NEEDS_CLARIFICATION', 'PAID'] as const;
    mockGetMyVouchers.mockResolvedValue(
      view({ items: statuses.map((status, i) => row({ voucherId: `v-${i}`, status })) }),
    );

    render(<VouchersScreen />);

    await waitFor(() => expect(screen.getByTestId('voucher-row-v-0')).toBeTruthy());
    expect(screen.getByText('Draft')).toBeTruthy();
    expect(screen.getByText('Approved')).toBeTruthy();
    expect(screen.getByText('Rejected')).toBeTruthy();
    expect(screen.getByText('Needs Clarification')).toBeTruthy();
    expect(screen.getByText('Paid')).toBeTruthy();
  });

  it('shows the empty state when there are no vouchers', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetMyVouchers.mockResolvedValue(view({ items: [], summary: { claimedTotal: 0, pendingCount: 0, approvedCount: 0 } }));

    render(<VouchersScreen />);

    await waitFor(() => expect(screen.getByTestId('vouchers-empty')).toBeTruthy());
  });

  it('opens the New Voucher form and returns to the list, refetching, on submit', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetMyVouchers.mockResolvedValue(view({}));

    render(<VouchersScreen />);
    await waitFor(() => expect(screen.getByTestId('voucher-new-button')).toBeTruthy());

    fireEvent.press(screen.getByTestId('voucher-new-button'));
    expect(screen.getByTestId('screen-voucher-form')).toBeTruthy();

    fireEvent.press(screen.getByTestId('voucher-form-cancel'));
    await waitFor(() => expect(screen.getByTestId('screen-vouchers')).toBeTruthy());
  });

  it('shows an offline indicator when the fetch fails', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetMyVouchers.mockRejectedValue(new Error('UNAUTHORIZED'));

    render(<VouchersScreen />);

    await waitFor(() => expect(screen.getByTestId('vouchers-offline')).toBeTruthy());
  });
});
