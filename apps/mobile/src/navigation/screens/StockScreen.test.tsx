import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import type { ComponentRequestRow, VanStockView } from '@fsm/shared';
import { StockScreen } from './StockScreen';
import { apiConfirmReceipt, apiGetMyComponentRequests, apiGetVanStock } from '../../api/client';
import { getAccessToken } from '../../auth/tokenStore';

jest.mock('../../api/client', () => {
  const actual = jest.requireActual('../../api/client') as object;
  return {
    ...actual,
    apiGetVanStock: jest.fn(),
    apiGetMyComponentRequests: jest.fn(),
    apiConfirmReceipt: jest.fn(),
  };
});
jest.mock('../../auth/tokenStore', () => ({ getAccessToken: jest.fn() }));

const mockGetVanStock = jest.mocked(apiGetVanStock);
const mockGetRequests = jest.mocked(apiGetMyComponentRequests);
const mockConfirmReceipt = jest.mocked(apiConfirmReceipt);
const mockGetAccessToken = jest.mocked(getAccessToken);

const vanStock: VanStockView = {
  stock: [
    { componentId: 'c-gps', name: 'GPS Unit', qty: 3 },
    { componentId: 'c-sim', name: 'SIM Card', qty: 1 },
  ],
  commonKit: { complete: false, missing: [{ componentId: 'c-sim', name: 'SIM Card', shortBy: 1 }] },
};

function requestRow(overrides: Partial<ComponentRequestRow>): ComponentRequestRow {
  return {
    requestId: 'req-1',
    ticketId: 't-1',
    seId: 'se-1',
    componentId: 'c-battery',
    componentName: 'Battery',
    status: 'APPROVED',
    deliveryDestination: 'SE_LOCATION',
    trackingRef: null,
    rejectionReason: null,
    companyName: 'JSW Cement',
    zoneName: 'South',
    ageDays: 1,
    createdAt: '2026-05-11T00:00:00Z',
    ...overrides,
  };
}

describe('StockScreen', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders van-stock rows and the three summary tiles', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetVanStock.mockResolvedValue(vanStock);
    mockGetRequests.mockResolvedValue({ items: [], cursor: null });

    render(<StockScreen />);

    await waitFor(() => expect(screen.getByText('GPS Unit')).toBeTruthy());
    expect(screen.getByText('SIM Card')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy(); // available = 3 + 1
  });

  it('shows Kit Incomplete when commonKit.complete is false', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetVanStock.mockResolvedValue(vanStock);
    mockGetRequests.mockResolvedValue({ items: [], cursor: null });

    render(<StockScreen />);

    await waitFor(() => expect(screen.getByTestId('kit-status-incomplete')).toBeTruthy());
  });

  it('shows Kit Complete when commonKit.complete is true', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetVanStock.mockResolvedValue({ stock: [], commonKit: { complete: true, missing: [] } });
    mockGetRequests.mockResolvedValue({ items: [], cursor: null });

    render(<StockScreen />);

    await waitFor(() => expect(screen.getByTestId('kit-status-complete')).toBeTruthy());
  });

  it('renders the Requests list and a Confirm Receipt button only for SHIPPED requests', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetVanStock.mockResolvedValue(vanStock);
    mockGetRequests.mockResolvedValue({
      items: [requestRow({ requestId: 'shipped-1', status: 'SHIPPED' }), requestRow({ requestId: 'approved-1', status: 'APPROVED' })],
      cursor: null,
    });

    render(<StockScreen />);

    await waitFor(() => expect(screen.getByTestId('confirm-receipt-shipped-1')).toBeTruthy());
    expect(screen.queryByTestId('confirm-receipt-approved-1')).toBeNull();
  });

  it('confirms receipt and refetches the requests list on success', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetVanStock.mockResolvedValue(vanStock);
    mockGetRequests.mockResolvedValue({ items: [requestRow({ requestId: 'shipped-1', status: 'SHIPPED' })], cursor: null });
    mockConfirmReceipt.mockResolvedValue({ request: { requestId: 'shipped-1' } as never });

    render(<StockScreen />);
    await waitFor(() => expect(screen.getByTestId('confirm-receipt-shipped-1')).toBeTruthy());

    mockGetRequests.mockResolvedValueOnce({ items: [requestRow({ requestId: 'shipped-1', status: 'RECEIVED' })], cursor: null });
    fireEvent.press(screen.getByTestId('confirm-receipt-shipped-1'));

    await waitFor(() => expect(mockConfirmReceipt).toHaveBeenCalledWith('token', 'shipped-1'));
    await waitFor(() => expect(mockGetRequests).toHaveBeenCalledTimes(2));
  });
});
