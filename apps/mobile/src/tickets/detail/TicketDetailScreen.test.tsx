import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react-native';
import type { MeTicketDetailView, VerificationView } from '@fsm/shared';
import { TicketDetailScreen } from './TicketDetailScreen';
import { apiGetTicketDetail, apiGetTicketVerification, apiSetSoftState } from '../../api/client';
import { getAccessToken } from '../../auth/tokenStore';

jest.mock('../../api/client', () => ({
  apiGetTicketDetail: jest.fn(),
  apiGetTicketVerification: jest.fn(),
  apiSetSoftState: jest.fn(),
}));
jest.mock('../../auth/tokenStore', () => ({ getAccessToken: jest.fn() }));

const mockGetDetail = jest.mocked(apiGetTicketDetail);
const mockGetVerification = jest.mocked(apiGetTicketVerification);
const mockSetSoftState = jest.mocked(apiSetSoftState);
const mockGetAccessToken = jest.mocked(getAccessToken);

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
    transporterName: 'Rapid Fleet',
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
    ...overrides,
  };
}

describe('TicketDetailScreen', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders the ready state from the detail read, without fetching verification', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetDetail.mockResolvedValue(detail({}));
    mockSetSoftState.mockResolvedValue({ result: 'OK', softState: {} as never });

    render(<TicketDetailScreen ticketId="t-1" />);

    await waitFor(() => expect(screen.getByText('KA05 CD 8845')).toBeTruthy());
    expect(screen.getByText('TCK-00306')).toBeTruthy();
    expect(screen.getByText('L&T - Bengaluru Plant')).toBeTruthy();
    expect(screen.getByText('Rapid Fleet')).toBeTruthy();
    expect(mockGetVerification).not.toHaveBeenCalled();
  });

  it('renders the verification-pending state and fetches the verification view', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetDetail.mockResolvedValue(detail({ status: 'VERIFICATION_PENDING' }));
    const verification: VerificationView = {
      ticketId: 't-1',
      phase: 'PHASE_1_PASS',
      pingsReceivedCount: 2,
      outcome: null,
      fraudFlag: false,
      firstPingDistanceMeters: 120,
      badge: 'PARTIAL_RECOVERY',
    };
    mockGetVerification.mockResolvedValue(verification);
    mockSetSoftState.mockResolvedValue({ result: 'OK', softState: {} as never });

    render(<TicketDetailScreen ticketId="t-1" />);

    await waitFor(() => expect(screen.getByTestId('verification-pending-card')).toBeTruthy());
    expect(mockGetVerification).toHaveBeenCalledWith('token', 't-1');
    expect(screen.getByText('PARTIAL_RECOVERY')).toBeTruthy();
  });

  it('renders a not-found state on TICKET_NOT_FOUND', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetDetail.mockRejectedValue(new Error('TICKET_NOT_FOUND'));

    render(<TicketDetailScreen ticketId="missing" />);

    await waitFor(() => expect(screen.getByTestId('ticket-detail-not-found')).toBeTruthy());
  });

  it('shows Technical Health hints when available', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetDetail.mockResolvedValue(
      detail({
        technicalHealth: {
          hints: [{ code: 'NO_MAIN_POWER', severity: 8, label: 'No main power — check fuse' }],
          rawTelemetry: null,
          dataAsOf: '2026-05-11T16:15:00Z',
          available: true,
        },
      }),
    );
    mockSetSoftState.mockResolvedValue({ result: 'OK', softState: {} as never });

    render(<TicketDetailScreen ticketId="t-1" />);

    await waitFor(() => expect(screen.getByText('No main power — check fuse')).toBeTruthy());
  });
});
