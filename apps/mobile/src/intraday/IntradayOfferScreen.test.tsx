import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import type { IntradayInsertionOffer, MeTicketDetailView } from '@fsm/shared';
import { IntradayOfferScreen } from './IntradayOfferScreen';
import { apiAcceptIntradayInsertion, apiDeclineIntradayInsertion, apiGetTicketDetail } from '../api/client';
import { getAccessToken } from '../auth/tokenStore';

jest.mock('../api/client', () => {
  const actual = jest.requireActual('../api/client') as object;
  return {
    ...actual,
    apiGetTicketDetail: jest.fn(),
    apiAcceptIntradayInsertion: jest.fn(),
    apiDeclineIntradayInsertion: jest.fn(),
  };
});
jest.mock('../auth/tokenStore', () => ({ getAccessToken: jest.fn() }));

const mockGetDetail = jest.mocked(apiGetTicketDetail);
const mockAccept = jest.mocked(apiAcceptIntradayInsertion);
const mockDecline = jest.mocked(apiDeclineIntradayInsertion);
const mockGetAccessToken = jest.mocked(getAccessToken);

const offer: IntradayInsertionOffer = {
  insertionId: 'i-1',
  ticketId: 't-1',
  zoneId: 'z-1',
  companyId: 'co-1',
  companyTier: 'GOLD',
  insertionType: 'SYSTEM_CRITICAL',
  slaBucket: 'CRITICAL',
  offeredSeId: 'se-1',
  offeredAt: '2026-08-04T06:00:00Z',
  acceptanceDeadline: '2026-08-04T06:10:00Z',
  status: 'PENDING_ACCEPTANCE',
  declineReasonCode: null,
  retryCount: 0,
  whatsappSent: false,
  createdAt: '2026-08-04T06:00:00Z',
};

function detail(overrides: Partial<MeTicketDetailView>): MeTicketDetailView {
  return {
    ticketId: 't-1',
    ticketNo: 306,
    ticketNoDisplay: 'TCK-00306',
    deviceId: 'GPS502',
    vehicleNo: 'KA05 CD 8845',
    plantName: 'L&T - Bengaluru Plant',
    companyName: 'L&T',
    companyTier: 'GOLD',
    transporterName: null,
    transporterContact: null,
    slaBucket: 'CRITICAL',
    workType: 'TROUBLESHOOT',
    status: 'OPEN',
    activeSoftState: null,
    createdAt: '2026-05-01T00:00:00Z',
    lastStateChangedAt: '2026-05-09T21:15:00Z',
    failureCycleHistory: [],
    expectedComponents: [],
    componentRequestStatus: null,
    waitingComponentSince: null,
    readinessHint: 'UNKNOWN',
    technicalHealth: { hints: [], rawTelemetry: null, dataAsOf: null, available: false },
    deferredUntil: null,
    ...overrides,
  };
}

describe('IntradayOfferScreen', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders the offered ticket chrome once loaded', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetDetail.mockResolvedValue(detail({}));

    render(<IntradayOfferScreen offer={offer} onResolved={jest.fn()} />);

    await waitFor(() => expect(screen.getByTestId('screen-intraday-offer')).toBeTruthy());
    expect(screen.getByText('L&T - Bengaluru Plant')).toBeTruthy();
    expect(screen.getAllByText(/L&T/).length).toBeGreaterThan(0);
  });

  it('accepts the offer and calls onResolved with the accepted ticketId', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetDetail.mockResolvedValue(detail({}));
    mockAccept.mockResolvedValue({ result: 'OK', insertionId: 'i-1', scheduleId: 's-1', batchId: 'b-1', ticketId: 't-1', seId: 'se-1' });
    const onResolved = jest.fn();

    render(<IntradayOfferScreen offer={offer} onResolved={onResolved} />);
    await waitFor(() => expect(screen.getByTestId('intraday-accept-button')).toBeTruthy());

    fireEvent.press(screen.getByTestId('intraday-accept-button'));

    await waitFor(() => expect(mockAccept).toHaveBeenCalledWith('token', 'i-1'));
    await waitFor(() => expect(onResolved).toHaveBeenCalledWith('t-1'));
  });

  it('opens the mandatory reason picker on Decline, and posts the chosen reason', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetDetail.mockResolvedValue(detail({}));
    mockDecline.mockResolvedValue({ result: 'OK', status: 'PENDING_ACCEPTANCE', nextSeId: 'se-2' });
    const onResolved = jest.fn();

    render(<IntradayOfferScreen offer={offer} onResolved={onResolved} />);
    await waitFor(() => expect(screen.getByTestId('intraday-decline-button')).toBeTruthy());

    fireEvent.press(screen.getByTestId('intraday-decline-button'));
    expect(screen.getByTestId('screen-intraday-decline')).toBeTruthy();
    expect(screen.getByTestId('intraday-decline-submit').props.accessibilityState.disabled).toBe(true);

    fireEvent.press(screen.getByTestId('intraday-decline-reason-tile-AT_CAPACITY'));
    expect(screen.getByTestId('intraday-decline-submit').props.accessibilityState.disabled).toBe(false);

    fireEvent.press(screen.getByTestId('intraday-decline-submit'));

    await waitFor(() => expect(mockDecline).toHaveBeenCalledWith('token', 'i-1', { reasonCode: 'AT_CAPACITY' }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledWith(null));
  });

  it('returns from the reason picker to the main prompt on Cancel', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetDetail.mockResolvedValue(detail({}));

    render(<IntradayOfferScreen offer={offer} onResolved={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId('intraday-decline-button')).toBeTruthy());
    fireEvent.press(screen.getByTestId('intraday-decline-button'));

    fireEvent.press(screen.getByTestId('intraday-decline-cancel'));

    expect(screen.getByTestId('screen-intraday-offer')).toBeTruthy();
    expect(mockDecline).not.toHaveBeenCalled();
  });

  it('closes gracefully when the offer was already resolved elsewhere (INSERTION_NOT_PENDING)', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetDetail.mockResolvedValue(detail({}));
    mockAccept.mockRejectedValue(new Error('INSERTION_NOT_PENDING'));
    const onResolved = jest.fn();

    render(<IntradayOfferScreen offer={offer} onResolved={onResolved} />);
    await waitFor(() => expect(screen.getByTestId('intraday-accept-button')).toBeTruthy());
    fireEvent.press(screen.getByTestId('intraday-accept-button'));

    await waitFor(() => expect(screen.getByTestId('intraday-offer-gone')).toBeTruthy());
    expect(onResolved).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('intraday-offer-gone-continue'));
    expect(onResolved).toHaveBeenCalledWith(null);
  });
});
